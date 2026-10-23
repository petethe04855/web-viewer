using System.Text.Json;
using CUE4Parse.UE4.Versions;
using WuwaRunner;
using UEBulkExport;

// Thin wrapper around the UEBulkExport CLI so the full WuWa key set can be passed
// in-process: 500+ --aes pairs overflow the Windows 32 KB command line limit.
//
// Extra mode:  --paths <regex>   print the container paths that match, nothing else.

const string SettingsPath = @"C:\Users\pete\AppData\Roaming\FModel\AppSettings.json";
const string ProfileKey = "E:/SteamLibrary/steamapps/common/Wuthering Waves/Client/Content/Paks";
var PaksPath = Environment.GetEnvironmentVariable("WUWA_PAKS") ?? @"E:\SteamLibrary\steamapps\common\Wuthering Waves\Client\Content\Paks";

var cliArgs = new List<string> { "--paks", PaksPath, "--game", "GAME_WutheringWaves" };
var keys = new List<string>();

try
{
    using var doc = JsonDocument.Parse(File.ReadAllText(SettingsPath));
    var profile = doc.RootElement.GetProperty("PerDirectory").GetProperty(ProfileKey);
    var aes = profile.GetProperty("AesKeys");

    if (aes.TryGetProperty("mainKey", out var main) && main.GetString() is { Length: > 0 } mainKey)
        keys.Add(mainKey);

    if (aes.TryGetProperty("dynamicKeys", out var dyn))
    {
        foreach (var entry in dyn.EnumerateArray())
        {
            var guid = entry.GetProperty("guid").GetString();
            var key = entry.GetProperty("key").GetString();
            if (!string.IsNullOrEmpty(guid) && !string.IsNullOrEmpty(key))
                keys.Add($"{guid}:{key}");
        }
    }
}
catch (Exception e)
{
    Console.Error.WriteLine($"Could not read AES keys from FModel settings: {e.Message}");
    return 1;
}

Log.AddSink(new ConsoleSink());
foreach (var k in keys) cliArgs.AddRange(["--aes", k]);

var userArgs = Environment.GetCommandLineArgs().Skip(1).ToArray();

if (userArgs.Length >= 2 && userArgs[0] == "--anim-dump")
{
    var options = new Options
    {
        PaksDirectory = PaksPath,
        Game = EGame.GAME_WutheringWaves,
        Mode = ExportMode.List,
        IncludeRegex = userArgs[1],
        AesKeys = keys
    };

    using var exporter = new BulkExporter(options);
    exporter.Mount();
    AnimDump.Run(exporter.Provider, exporter.SelectFiles(), userArgs.Length > 2 ? userArgs[2] : "anims", userArgs[1]);
    return 0;
}

if (userArgs.Length == 2 && userArgs[0] == "--paths")
{
    var options = new Options
    {
        PaksDirectory = PaksPath,
        Game = EGame.GAME_WutheringWaves,
        Mode = ExportMode.List,
        IncludeRegex = userArgs[1],
        AesKeys = keys
    };

    using var exporter = new BulkExporter(options);
    exporter.Mount();
    foreach (var file in exporter.SelectFiles())
        Console.WriteLine(file.Path);

    return 0;
}

cliArgs.AddRange(userArgs);
return await CliRunner.RunAsync(cliArgs.ToArray());

sealed class ConsoleSink : ILogSink
{
    public void Write(in LogEntry entry) => Console.WriteLine(entry.Format());
}
