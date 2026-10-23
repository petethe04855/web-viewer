using System.Text.Json;
using CUE4Parse.FileProvider;
using CUE4Parse.FileProvider.Objects;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Animations;
using CUE4Parse.UE4.Assets.Exports.Animation;
using UE4GameFile = CUE4Parse.FileProvider.Objects.GameFile;

namespace WuwaRunner;

/// <summary>
/// Samples every bone track of an AnimSequence into plain JSON (UE coordinates).
/// scripts/animate.mjs turns those keys into glTF animation samplers using the
/// same Y/Z swap the mesh exporter applied to the skeleton.
/// </summary>
public static class AnimDump
{
    public static int Run(DefaultFileProvider provider, IEnumerable<UE4GameFile> files, string outDirectory, string label)
    {
        Directory.CreateDirectory(outDirectory);
        var written = 0;

        foreach (var file in files)
        {
            if (!file.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) continue;

            try
            {
                var package = provider.LoadPackage(file);
                var animation = package.GetExports().OfType<UAnimationAsset>().FirstOrDefault();
                if (animation is null) continue;

                var animSet = animation.ConvertAnims();
                if (animSet is null || animSet.Sequences.Count == 0) continue;

                var sequence = animSet.Sequences[0];
                var refSkeleton = animSet.Skeleton.ReferenceSkeleton;

                var bones = new List<object>(refSkeleton.FinalRefBoneInfo.Length);
                foreach (var bone in refSkeleton.FinalRefBoneInfo)
                    bones.Add(new { name = bone.Name.Text, parent = bone.ParentIndex });

                var tracks = new List<object>();
                for (var boneIndex = 0; boneIndex < animSet.Skeleton.BoneCount; boneIndex++)
                {
                    if (sequence.OriginalSequence.FindTrackForBoneIndex(boneIndex) < 0) continue;

                    var rest = refSkeleton.FinalRefBonePose[boneIndex];
                    var pos = new List<float[]>(sequence.NumFrames);
                    var rot = new List<float[]>(sequence.NumFrames);
                    var scale = new List<float[]>(sequence.NumFrames);

                    for (var frame = 0; frame < sequence.NumFrames; frame++)
                    {
                        var p = rest.Translation;
                        var q = rest.Rotation;
                        var s = rest.Scale3D;
                        sequence.Tracks[boneIndex].GetBoneTransform(frame, sequence.NumFrames, ref q, ref p, ref s);
                        pos.Add([p.X, p.Y, p.Z]);
                        rot.Add([q.X, q.Y, q.Z, q.W]);
                        scale.Add([s.X, s.Y, s.Z]);
                    }

                    tracks.Add(new { bone = boneIndex, pos, rot, scale });
                }

                var payload = new
                {
                    name = sequence.Name,
                    path = file.Path,
                    fps = sequence.FramesPerSecond,
                    frames = sequence.NumFrames,
                    bones,
                    tracks,
                };

                var outPath = Path.Combine(outDirectory, $"{Path.GetFileNameWithoutExtension(file.Path)}.json");
                File.WriteAllText(outPath, JsonSerializer.Serialize(payload));
                written++;
                Console.Error.WriteLine($"{Path.GetFileName(file.Path)}: {sequence.NumFrames} frames, {tracks.Count} tracks, {sequence.FramesPerSecond} fps");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"{Path.GetFileName(file.Path)}: FAILED {e.GetType().Name}: {e.Message}");
            }
        }

        Console.Error.WriteLine($"{label}: wrote {written} animation(s) to {outDirectory}");
        return written;
    }
}
