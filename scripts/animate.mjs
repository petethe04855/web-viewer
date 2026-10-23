// Turns the JSON animation dumps from `ue-runner --anim-dump` into glTF
// animations inside an existing .glb.
//
//   node scripts/animate.mjs <model.glb> <out.glb> <animDir> [moreDirs...]
//
// Several directories can be passed: a clip is the merge of every dump that
// shares its name, with a leading `Rib_` ignored. Body clips (`Stand1`,
// `Attack04`, ...) animate the 106 skeleton bones, the matching `Rib_*` clip
// carries the 148 hair / skirt / ribbon bones that the body clip does not
// touch, so the two have to be combined or the hair stays in its bind pose.
//
// The mesh exporter converted every bone transform with (x, y, z) -> (x, z, y)
// and quaternions with (x, y, z, w) -> (x, z, y, -w), plus a 0.01 unit scale.
// Animation keys go through exactly the same mapping or the pose is mirrored.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('usage: node scripts/animate.mjs <model.glb> <out.glb> <animDir> [moreDirs...]');
  process.exit(1);
}
const [glbPath, outArg, ...animDirs] = args;

const UNIT_SCALE = 0.01;

const swapVec = (v) => [v[0], v[2], v[1]];
const swapQuat = (q) => {
  const out = [q[0], q[2], q[1], -q[3]];
  const len = Math.hypot(...out);
  return out.map((c) => c / len);
};

// ---------------------------------------------------------------- load dumps

const clips = new Map();

for (const dir of animDirs) {
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.json')) continue;

    const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const rawName = data.name || basename(file, '.json');
    const name = rawName.replace(/^Rib_/, '');
    const isRibbon = /^Rib_/.test(rawName);

    let clip = clips.get(name);
    if (!clip) {
      clip = { name, fps: data.fps || 30, frames: data.frames, tracks: new Map() };
      clips.set(name, clip);
    }

    // The body clip decides the timeline; ribbon clips only fill in bones.
    if (!isRibbon || clip.frames === undefined) {
      clip.fps = data.fps || clip.fps;
      clip.frames = data.frames || clip.frames;
    }

    for (const track of data.tracks) {
      const bone = data.bones[track.bone];
      if (!bone) continue;

      // Body data always wins: the Rib_* dumps also carry tracks for Root and
      // the spine, but their values are the additive variants, so letting them
      // overwrite the body clip flips the whole character over.
      const existing = clip.tracks.get(bone.name);
      if (existing && !existing.isRibbon) continue;

      clip.tracks.set(bone.name, {
        pos: track.pos,
        rot: track.rot,
        frames: data.frames,
        isRibbon,
      });
    }
  }
}

// Resamples a track to the clip's frame count (the ribbon dumps differ by a
// frame now and then, e.g. Stand1_Action01 is 768 vs 769).
function resample(track, frames) {
  if (track.frames === frames) return track;
  const pick = (list) => {
    const out = [];
    for (let f = 0; f < frames; f++) {
      const src = Math.round((f / (frames - 1)) * (track.frames - 1));
      out.push(list[Math.min(src, list.length - 1)]);
    }
    return out;
  };
  return { pos: pick(track.pos), rot: pick(track.rot) };
}

// --------------------------------------------------------------- glb plumbing

const buf = readFileSync(glbPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb file');

const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const binLen = buf.readUInt32LE(20 + jsonLen);
const chunks = [buf.subarray(binStart, binStart + binLen)];

const nodeByName = new Map();
(gltf.nodes ?? []).forEach((node, index) => {
  if (node.name && !nodeByName.has(node.name)) nodeByName.set(node.name, index);
});

gltf.accessors = gltf.accessors ?? [];
gltf.bufferViews = gltf.bufferViews ?? [];
gltf.animations = [];

let cursor = binLen;
const align4 = () => {
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
};

// Appends one float array and returns the accessor index describing it.
function addAccessor(values, type, componentsPerElement) {
  align4();
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  chunks.push(bytes);

  const bufferView = gltf.bufferViews.length;
  gltf.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.length });
  cursor += bytes.length;

  const accessor = gltf.accessors.length;
  gltf.accessors.push({
    bufferView,
    componentType: 5126,
    count: values.length / componentsPerElement,
    type,
  });
  return accessor;
}

// ------------------------------------------------------------------- convert

let appended = 0;
let untrackedReported = 0;

for (const clip of [...clips.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const frames = clip.frames;
  const fps = clip.fps;

  const times = [];
  for (let i = 0; i < frames; i++) times.push(i / fps);
  const input = addAccessor(times, 'SCALAR', 1);

  const samplers = [];
  const channels = [];
  let matched = 0;
  const unmatched = [];

  for (const [boneName, track] of clip.tracks) {
    const node = nodeByName.get(boneName);
    if (node === undefined) { unmatched.push(boneName); continue; }
    matched++;

    const { pos, rot } = resample(track, frames);
    const rotations = [];
    const translations = [];
    for (let f = 0; f < frames; f++) {
      rotations.push(...swapQuat(rot[f]));
      const p = swapVec(pos[f]);
      translations.push(p[0] * UNIT_SCALE, p[1] * UNIT_SCALE, p[2] * UNIT_SCALE);
    }

    const rotationAccessor = addAccessor(rotations, 'VEC4', 4);
    samplers.push({ input, output: rotationAccessor, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node, path: 'rotation' } });

    // Ribbon clips bake a parent bone scale into the positions (Rib_Stand1
    // stores every translation at 2x rest), and the bones barely translate
    // anyway (<3 mm of drift), so keep the glb rest translation and only take
    // the rotations from the ribbon dump. Emitting those offsets stretches the
    // hair and skirt into spikes.
    if (track.isRibbon) continue;

    const translationAccessor = addAccessor(translations, 'VEC3', 3);
    samplers.push({ input, output: translationAccessor, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node, path: 'translation' } });
  }

  if (matched === 0) {
    console.warn(`${clip.name}: no bone names matched the glb skeleton, skipped`);
    continue;
  }

  gltf.animations.push({ name: clip.name, samplers, channels });
  appended++;

  // The skeleton has 254 joints; list the ones no clip drives so it is obvious
  // whether any secondary bones are still frozen.
  if (!untrackedReported) {
    const driven = new Set();
    for (const other of clips.values()) for (const name of other.tracks.keys()) driven.add(name);
    const joints = gltf.skins[0].joints.map((i) => gltf.nodes[i].name);
    const idle = joints.filter((name) => !driven.has(name));
    untrackedReported = idle.length;
    console.log(`skeleton joints: ${joints.length}, driven by some clip: ${joints.length - idle.length}, never driven: ${idle.length}`);
    if (idle.length) console.log('  never driven: ' + idle.join(', '));
  }

  console.log(`${clip.name}: ${frames} frames @ ${fps.toFixed(2)} fps, ${matched} bones${unmatched.length ? `, ${unmatched.length} not in skeleton` : ''}`);
}

// ---------------------------------------------------------------- write back

let bin = Buffer.concat(chunks);
if (bin.length % 4 !== 0) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);
gltf.buffers = [{ byteLength: bin.length }];

let json = Buffer.from(JSON.stringify(gltf), 'utf8');
if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);

const total = 12 + 8 + json.length + 8 + bin.length;
const out = Buffer.alloc(total);
let p = 0;
out.writeUInt32LE(0x46546c67, p); p += 4;
out.writeUInt32LE(2, p); p += 4;
out.writeUInt32LE(total, p); p += 4;
out.writeUInt32LE(json.length, p); p += 4;
out.writeUInt32LE(0x4e4f534a, p); p += 4;
json.copy(out, p); p += json.length;
out.writeUInt32LE(bin.length, p); p += 4;
out.writeUInt32LE(0x004e4942, p); p += 4;
bin.copy(out, p);

writeFileSync(outArg, out);
console.log(`wrote ${outArg} (${(total / 1048576).toFixed(1)} MB, ${appended} animations)`);
