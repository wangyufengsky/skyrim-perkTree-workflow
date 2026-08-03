using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;

return await WriterApplication.RunAsync(args);

internal static class WriterApplication
{
    private const int SupportedChangeSetVersion = 2;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Skip,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> RunAsync(string[] args)
    {
        if (args.Length == 0 || args.Contains("--help", StringComparer.Ordinal))
        {
            PrintUsage();
            return args.Length == 0 ? 2 : 0;
        }

        string? temporaryOutput = null;
        string? temporaryDirectory = null;
        try
        {
            var options = CliOptions.Parse(args);
            ValidatePaths(options);

            var changeSetText = await File.ReadAllTextAsync(options.ChangeSetPath);
            var changeSet = JsonSerializer.Deserialize<ChangeSet>(changeSetText, JsonOptions)
                            ?? throw new InvalidDataException("Change-set JSON is empty.");
            ValidateChangeSet(changeSet, options);

            var baseHash = await Sha256Async(options.BasePluginPath);
            if (!string.Equals(baseHash, changeSet.BaseSha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    $"Base SHA-256 mismatch. Expected {changeSet.BaseSha256}, actual {baseHash}. No output was written.");
            }

            var release = ParseRelease(options.GameRelease);
            var baseModKey = ModKey.FromNameAndExtension(Path.GetFileName(options.BasePluginPath));
            var modPath = new ModPath(baseModKey, options.BasePluginPath);
            using var source = SkyrimMod.CreateFromBinaryOverlay(modPath, release);

            var targetFormKey = ParseWorkflowFormKey(changeSet.TargetAvif);
            var target = source.ActorValueInformation.Records.FirstOrDefault(record => record.FormKey == targetFormKey)
                         ?? throw new InvalidDataException(
                             $"Target AVIF {changeSet.TargetAvif} was not found in {baseModKey.FileName}.");

            var edited = target.DeepCopy();
            ValidateTreeBeforeEdit(edited);
            var permittedPerkPlugins = source.ModHeader.MasterReferences
                .Select(master => master.Master)
                .Append(baseModKey)
                .ToHashSet();
            var applied = ApplyOperations(edited, changeSet.Operations, permittedPerkPlugins);
            ValidateTreeAfterEdit(edited);

            var outputModKey = ModKey.FromNameAndExtension(Path.GetFileName(options.OutputPluginPath));
            var patch = new SkyrimMod(outputModKey, release);
            patch.ActorValueInformation.Set(edited);

            var outputDirectory = Path.GetDirectoryName(options.OutputPluginPath)!;
            Directory.CreateDirectory(outputDirectory);
            temporaryDirectory = Path.Combine(outputDirectory, $".mutagen-write-{Guid.NewGuid():N}");
            Directory.CreateDirectory(temporaryDirectory);
            temporaryOutput = Path.Combine(temporaryDirectory, Path.GetFileName(options.OutputPluginPath));

            patch.WriteToBinary(temporaryOutput);
            VerifyMutagenOutput(temporaryOutput, outputModKey, release, targetFormKey, edited);
            File.Move(temporaryOutput, options.OutputPluginPath, overwrite: false);
            temporaryOutput = null;
            Directory.Delete(temporaryDirectory);
            temporaryDirectory = null;

            var outputHash = await Sha256Async(options.OutputPluginPath);
            var report = new WriterReport(
                "ok",
                "Mutagen.Bethesda.Skyrim",
                typeof(SkyrimMod).Assembly.GetName().Version?.ToString() ?? "unknown",
                options.BasePluginPath,
                baseHash,
                options.OutputPluginPath,
                outputHash,
                changeSet.TargetAvif,
                target.EditorID,
                applied.Count,
                edited.PerkTree.Count,
                edited.PerkTree.Sum(node => node.ConnectionLineToIndices.Count));

            var reportJson = JsonSerializer.Serialize(report, JsonOptions);
            if (options.ReportPath is not null)
            {
                var reportDirectory = Path.GetDirectoryName(options.ReportPath);
                if (!string.IsNullOrEmpty(reportDirectory)) Directory.CreateDirectory(reportDirectory);
                await File.WriteAllTextAsync(options.ReportPath, reportJson + Environment.NewLine);
            }

            Console.WriteLine(reportJson);
            return 0;
        }
        catch (Exception exception)
        {
            if (temporaryOutput is not null && File.Exists(temporaryOutput)) File.Delete(temporaryOutput);
            if (temporaryDirectory is not null && Directory.Exists(temporaryDirectory)) Directory.Delete(temporaryDirectory, recursive: true);
            Console.Error.WriteLine($"ERROR: {exception.Message}");
            return 1;
        }
    }

    private static void PrintUsage()
    {
        Console.WriteLine(
            """
            SkyrimPerkTreeWriter - safe Mutagen AVIF patch writer

            Usage:
              dotnet run --project writer/SkyrimPerkTreeWriter -- \
                --base /path/to/Winner.esp \
                --change-set /path/to/change-set.json \
                --output /path/to/NewPatch.esp \
                [--game-release SkyrimSE] [--report /path/to/writer-report.json]

            Safety rules:
              * The base plugin is read-only and its SHA-256 must match the change-set.
              * The output must be a new .esp path and must not already exist.
              * Only the requested AVIF override is emitted; Mutagen owns binary serialization.
              * The temporary output is reopened with Mutagen and structurally compared before commit.
            """);
    }

    private static void ValidatePaths(CliOptions options)
    {
        options.BasePluginPath = Path.GetFullPath(options.BasePluginPath);
        options.ChangeSetPath = Path.GetFullPath(options.ChangeSetPath);
        options.OutputPluginPath = Path.GetFullPath(options.OutputPluginPath);
        if (options.ReportPath is not null) options.ReportPath = Path.GetFullPath(options.ReportPath);

        if (!File.Exists(options.BasePluginPath)) throw new FileNotFoundException("Base plugin not found.", options.BasePluginPath);
        if (!File.Exists(options.ChangeSetPath)) throw new FileNotFoundException("Change-set not found.", options.ChangeSetPath);
        if (!string.Equals(Path.GetExtension(options.BasePluginPath), ".esp", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(Path.GetExtension(options.BasePluginPath), ".esm", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(Path.GetExtension(options.BasePluginPath), ".esl", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Base plugin must have .esp, .esm, or .esl extension.");
        }

        if (!string.Equals(Path.GetExtension(options.OutputPluginPath), ".esp", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Output must be a new .esp file.");
        }

        if (string.Equals(options.BasePluginPath, options.OutputPluginPath, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Output path must differ from the base plugin path.");
        }

        if (File.Exists(options.OutputPluginPath))
        {
            throw new IOException("Output already exists. Refusing to overwrite it.");
        }
    }

    private static void ValidateChangeSet(ChangeSet changeSet, CliOptions options)
    {
        if (changeSet.Version != SupportedChangeSetVersion)
            throw new InvalidDataException($"Unsupported change-set version {changeSet.Version}; expected {SupportedChangeSetVersion}.");
        if (changeSet.Operations is null || changeSet.Operations.Count == 0)
            throw new InvalidDataException("Change-set must contain at least one operation.");
        foreach (var (name, value) in new[]
                 {
                     ("basePlugin", changeSet.BasePlugin),
                     ("baseSha256", changeSet.BaseSha256),
                     ("expectedWinnerPlugin", changeSet.ExpectedWinnerPlugin),
                     ("targetAvif", changeSet.TargetAvif),
                     ("outputPlugin", changeSet.OutputPlugin),
                 })
        {
            if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException($"{name} is required.");
        }
        if (!IsSha256(changeSet.BaseSha256)) throw new InvalidDataException("baseSha256 must be 64 lowercase hexadecimal characters.");

        var baseFileName = Path.GetFileName(options.BasePluginPath);
        if (!string.Equals(changeSet.BasePlugin, baseFileName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"basePlugin is {changeSet.BasePlugin}, but --base is {baseFileName}.");
        if (!string.Equals(changeSet.ExpectedWinnerPlugin, baseFileName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException(
                $"expectedWinnerPlugin is {changeSet.ExpectedWinnerPlugin}, but --base is {baseFileName}. Run load-order analysis first and pass the verified winner.");
        if (!string.Equals(changeSet.OutputPlugin, Path.GetFileName(options.OutputPluginPath), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"outputPlugin is {changeSet.OutputPlugin}, but --output names {Path.GetFileName(options.OutputPluginPath)}.");

        _ = ParseWorkflowFormKey(changeSet.TargetAvif);
        foreach (var operation in changeSet.Operations) operation.Validate();
    }

    private static void ValidateTreeBeforeEdit(ActorValueInformation tree)
    {
        ValidateTreeGraph(tree, "Target tree");
    }

    private static void ValidateTreeGraph(ActorValueInformation tree, string label)
    {
        if (tree.PerkTree.Any(node => !node.Index.HasValue))
            throw new InvalidDataException($"{label} contains a node without an INAM index.");
        var duplicate = tree.PerkTree.Where(node => node.Index.HasValue)
            .GroupBy(node => node.Index!.Value)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null) throw new InvalidDataException($"{label} has duplicate INAM index {duplicate.Key}.");

        var byIndex = tree.PerkTree.ToDictionary(node => node.Index!.Value);
        var dangling = tree.PerkTree
            .SelectMany(node => node.ConnectionLineToIndices.Select(target => (From: node.Index!.Value, To: target)))
            .FirstOrDefault(edge => !byIndex.ContainsKey(edge.To));
        if (!byIndex.ContainsKey(dangling.To) && dangling != default)
            throw new InvalidDataException($"{label} contains dangling connection {dangling.From}->{dangling.To}.");

        if (!byIndex.TryGetValue(0, out var root) || !root.Perk.IsNull)
            throw new InvalidDataException($"{label} must contain the invisible null-PERK root at INAM 0.");

        var visiting = new HashSet<uint>();
        var visited = new HashSet<uint>();
        bool Visit(uint index)
        {
            if (visiting.Contains(index)) return false;
            if (visited.Contains(index)) return true;
            visiting.Add(index);
            foreach (var target in byIndex[index].ConnectionLineToIndices)
            {
                if (!Visit(target)) return false;
            }
            visiting.Remove(index);
            visited.Add(index);
            return true;
        }

        if (!Visit(0)) throw new InvalidDataException($"{label} contains a directed cycle.");
        var unreachable = byIndex.Keys.Where(index => !visited.Contains(index)).OrderBy(index => index).ToArray();
        if (unreachable.Length > 0)
            throw new InvalidDataException($"{label} contains nodes unreachable from INAM 0: {string.Join(", ", unreachable)}.");
    }

    private static List<string> ApplyOperations(
        ActorValueInformation tree,
        IReadOnlyList<ChangeOperation> operations,
        IReadOnlySet<ModKey> permittedPerkPlugins)
    {
        var applied = new List<string>();
        foreach (var operation in operations)
        {
            var byIndex = tree.PerkTree.Where(node => node.Index.HasValue)
                .ToDictionary(node => node.Index!.Value);
            switch (operation.Op)
            {
                case "moveNode":
                {
                    var node = RequireNode(byIndex, operation.NodeIndex, operation.Op);
                    node.PerkGridX = checked((uint)operation.Xnam!.Value);
                    node.PerkGridY = checked((uint)operation.Ynam!.Value);
                    node.HorizontalPosition = operation.Hnam!.Value;
                    node.VerticalPosition = operation.Vnam!.Value;
                    applied.Add($"moveNode:{operation.NodeIndex}");
                    break;
                }
                case "connect":
                {
                    var from = RequireNode(byIndex, operation.FromIndex, operation.Op);
                    _ = RequireNode(byIndex, operation.ToIndex, operation.Op);
                    var targetIndex = checked((uint)operation.ToIndex!.Value);
                    if (from.ConnectionLineToIndices.Contains(targetIndex))
                        throw new InvalidDataException($"connect {operation.FromIndex}->{operation.ToIndex} already exists.");
                    from.ConnectionLineToIndices.Add(targetIndex);
                    applied.Add($"connect:{operation.FromIndex}->{operation.ToIndex}");
                    break;
                }
                case "disconnect":
                {
                    var from = RequireNode(byIndex, operation.FromIndex, operation.Op);
                    var targetIndex = checked((uint)operation.ToIndex!.Value);
                    if (!from.ConnectionLineToIndices.Remove(targetIndex))
                        throw new InvalidDataException($"disconnect {operation.FromIndex}->{operation.ToIndex} does not exist.");
                    applied.Add($"disconnect:{operation.FromIndex}->{operation.ToIndex}");
                    break;
                }
                case "updateParentRequired":
                {
                    var node = RequireNode(byIndex, operation.NodeIndex, operation.Op);
                    node.FNAM = new byte[] { operation.Required!.Value ? (byte)1 : (byte)0, 0, 0, 0 };
                    applied.Add($"updateParentRequired:{operation.NodeIndex}={operation.Required.Value.ToString().ToLowerInvariant()}");
                    break;
                }
                case "removeNode":
                {
                    if (operation.NodeIndex == 0) throw new InvalidDataException("removeNode cannot remove the invisible root at INAM 0.");
                    var node = RequireNode(byIndex, operation.NodeIndex, operation.Op);
                    var targetIndex = checked((uint)operation.NodeIndex!.Value);
                    tree.PerkTree.Remove(node);
                    foreach (var candidate in tree.PerkTree)
                    {
                        while (candidate.ConnectionLineToIndices.Remove(targetIndex)) { }
                    }
                    applied.Add($"removeNode:{operation.NodeIndex}");
                    break;
                }
                case "addNode":
                {
                    if (operation.NodeIndex == 0) throw new InvalidDataException("addNode cannot use the invisible root index 0.");
                    var nodeIndex = checked((uint)operation.NodeIndex!.Value);
                    if (byIndex.ContainsKey(nodeIndex)) throw new InvalidDataException($"addNode index {operation.NodeIndex} already exists.");
                    var perkFormKey = ParseWorkflowFormKey(operation.PerkFormKey!);
                    if (!permittedPerkPlugins.Contains(perkFormKey.ModKey))
                    {
                        throw new InvalidDataException(
                            $"addNode PERK {operation.PerkFormKey} is not from the verified base plugin or one of its masters. " +
                            "Choose a verified base that declares this plugin as a master; the writer will not silently add a new dependency.");
                    }
                    var template = tree.PerkTree.FirstOrDefault()
                                   ?? throw new InvalidDataException("addNode needs an existing invisible root to copy the associated skill.");
                    tree.PerkTree.Add(new ActorValuePerkNode
                    {
                        Perk = new FormLink<IPerkGetter>(perkFormKey),
                        FNAM = new byte[] { operation.Required!.Value ? (byte)1 : (byte)0, 0, 0, 0 },
                        PerkGridX = checked((uint)operation.Xnam!.Value),
                        PerkGridY = checked((uint)operation.Ynam!.Value),
                        HorizontalPosition = operation.Hnam!.Value,
                        VerticalPosition = operation.Vnam!.Value,
                        AssociatedSkill = template.AssociatedSkill,
                        Index = nodeIndex
                    });
                    applied.Add($"addNode:{operation.NodeIndex}:{operation.PerkFormKey}");
                    break;
                }
                default:
                    throw new InvalidDataException($"Unsupported operation {operation.Op}.");
            }
        }

        return applied;
    }

    private static ActorValuePerkNode RequireNode(
        IReadOnlyDictionary<uint, ActorValuePerkNode> byIndex,
        int? index,
        string operation)
    {
        if (!index.HasValue || !byIndex.TryGetValue(checked((uint)index.Value), out var node))
            throw new InvalidDataException($"{operation} references missing node index {index?.ToString() ?? "null"}.");
        return node;
    }

    private static void ValidateTreeAfterEdit(ActorValueInformation tree)
    {
        ValidateTreeGraph(tree, "Edited tree");
    }

    private static void VerifyMutagenOutput(
        string path,
        ModKey outputModKey,
        SkyrimRelease release,
        FormKey targetFormKey,
        ActorValueInformation expected)
    {
        using var reopened = SkyrimMod.CreateFromBinaryOverlay(new ModPath(outputModKey, path), release);
        var actual = reopened.ActorValueInformation.Records.SingleOrDefault(record => record.FormKey == targetFormKey)
                     ?? throw new InvalidDataException("Mutagen re-open verification could not find the target AVIF override.");
        if (reopened.ActorValueInformation.Records.Count() != 1)
            throw new InvalidDataException("Output contains records beyond the single requested AVIF override.");
        if (actual.PerkTree.Count != expected.PerkTree.Count)
            throw new InvalidDataException("Mutagen re-open verification found a node-count mismatch.");

        var expectedNodes = expected.PerkTree.Where(node => node.Index.HasValue).ToDictionary(node => node.Index!.Value);
        foreach (var actualNode in actual.PerkTree.Where(node => node.Index.HasValue))
        {
            if (!expectedNodes.TryGetValue(actualNode.Index!.Value, out var expectedNode))
                throw new InvalidDataException($"Mutagen re-open verification found unexpected node {actualNode.Index}.");
            if (actualNode.PerkGridX != expectedNode.PerkGridX
                || actualNode.PerkGridY != expectedNode.PerkGridY
                || actualNode.HorizontalPosition != expectedNode.HorizontalPosition
                || actualNode.VerticalPosition != expectedNode.VerticalPosition
                || actualNode.Perk.FormKey != expectedNode.Perk.FormKey
                || actualNode.AssociatedSkill.FormKey != expectedNode.AssociatedSkill.FormKey
                || !NullableBytesEqual(actualNode.FNAM, expectedNode.FNAM)
                || !actualNode.ConnectionLineToIndices.SequenceEqual(expectedNode.ConnectionLineToIndices))
            {
                throw new InvalidDataException($"Mutagen re-open verification found changed node data at INAM {actualNode.Index}.");
            }
        }
    }

    private static bool NullableBytesEqual(Noggog.ReadOnlyMemorySlice<byte>? left, Noggog.ReadOnlyMemorySlice<byte>? right)
    {
        if (!left.HasValue || !right.HasValue) return left.HasValue == right.HasValue;
        return left.Value.Span.SequenceEqual(right.Value.Span);
    }

    internal static FormKey ParseWorkflowFormKey(string value)
    {
        var separator = value.LastIndexOf('|');
        if (separator <= 0 || separator == value.Length - 1)
            throw new InvalidDataException($"Invalid workflow FormKey {value}; expected Plugin.ext|00000000.");
        var plugin = value[..separator];
        var idText = value[(separator + 1)..];
        if (idText.Length != 8 || !uint.TryParse(idText, System.Globalization.NumberStyles.HexNumber, null, out var id))
            throw new InvalidDataException($"Invalid workflow FormKey ID in {value}.");
        return new FormKey(ModKey.FromNameAndExtension(plugin), id);
    }

    private static SkyrimRelease ParseRelease(string value) => value switch
    {
        "SkyrimSE" => SkyrimRelease.SkyrimSE,
        "SkyrimLE" => SkyrimRelease.SkyrimLE,
        _ => throw new InvalidDataException("--game-release must be SkyrimSE or SkyrimLE."),
    };

    private static bool IsSha256(string? value) =>
        value?.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static async Task<string> Sha256Async(string path)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant();
    }
}

internal sealed class CliOptions
{
    public required string BasePluginPath { get; set; }
    public required string ChangeSetPath { get; set; }
    public required string OutputPluginPath { get; set; }
    public string GameRelease { get; set; } = "SkyrimSE";
    public string? ReportPath { get; set; }

    public static CliOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < args.Length; index += 2)
        {
            if (!args[index].StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length)
                throw new ArgumentException($"Expected --option value, got {args[index]}.");
            if (!values.TryAdd(args[index], args[index + 1])) throw new ArgumentException($"Duplicate option {args[index]}.");
        }

        var known = new HashSet<string>(["--base", "--change-set", "--output", "--game-release", "--report"], StringComparer.Ordinal);
        var unknown = values.Keys.FirstOrDefault(key => !known.Contains(key));
        if (unknown is not null) throw new ArgumentException($"Unknown option {unknown}.");

        return new CliOptions
        {
            BasePluginPath = Require(values, "--base"),
            ChangeSetPath = Require(values, "--change-set"),
            OutputPluginPath = Require(values, "--output"),
            GameRelease = values.GetValueOrDefault("--game-release", "SkyrimSE"),
            ReportPath = values.GetValueOrDefault("--report"),
        };
    }

    private static string Require(IReadOnlyDictionary<string, string> values, string key) =>
        values.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException($"Missing required option {key}.");
}

internal sealed record ChangeSet(
    int Version,
    string BasePlugin,
    string BaseSha256,
    string ExpectedWinnerPlugin,
    string TargetAvif,
    string OutputPlugin,
    string? Reason,
    List<ChangeOperation> Operations);

internal sealed record ChangeOperation(
    string Op,
    int? NodeIndex,
    long? Xnam,
    long? Ynam,
    float? Hnam,
    float? Vnam,
    int? FromIndex,
    int? ToIndex,
    bool? Required,
    string? PerkFormKey)
{
    public void Validate()
    {
        static void ValidateNodeIndex(int? value, string name)
        {
            if (value is null or < 0 or > 65535) throw new InvalidDataException($"{name} must be between 0 and 65535.");
        }

        switch (Op)
        {
            case "moveNode":
                ValidateNodeIndex(NodeIndex, "nodeIndex");
                if (Xnam is null or < 0 or > uint.MaxValue || Ynam is null or < 0 or > uint.MaxValue || Hnam is null || Vnam is null)
                    throw new InvalidDataException("moveNode requires uint xnam/ynam and finite hnam/vnam.");
                if (!float.IsFinite(Hnam.Value) || !float.IsFinite(Vnam.Value))
                    throw new InvalidDataException("moveNode hnam/vnam must be finite.");
                if (FromIndex.HasValue || ToIndex.HasValue || Required.HasValue)
                    throw new InvalidDataException("moveNode contains fields belonging to another operation.");
                break;
            case "connect":
            case "disconnect":
                ValidateNodeIndex(FromIndex, "fromIndex");
                ValidateNodeIndex(ToIndex, "toIndex");
                if (NodeIndex.HasValue || Xnam.HasValue || Ynam.HasValue || Hnam.HasValue || Vnam.HasValue || Required.HasValue)
                    throw new InvalidDataException($"{Op} contains fields belonging to another operation.");
                break;
            case "updateParentRequired":
                ValidateNodeIndex(NodeIndex, "nodeIndex");
                if (!Required.HasValue) throw new InvalidDataException("updateParentRequired requires required.");
                if (Xnam.HasValue || Ynam.HasValue || Hnam.HasValue || Vnam.HasValue || FromIndex.HasValue || ToIndex.HasValue)
                    throw new InvalidDataException("updateParentRequired contains fields belonging to another operation.");
                break;
            case "removeNode":
                ValidateNodeIndex(NodeIndex, "nodeIndex");
                if (Xnam.HasValue || Ynam.HasValue || Hnam.HasValue || Vnam.HasValue || FromIndex.HasValue || ToIndex.HasValue || Required.HasValue)
                    throw new InvalidDataException("removeNode contains fields belonging to another operation.");
                break;
            case "addNode":
                ValidateNodeIndex(NodeIndex, "nodeIndex");
                if (NodeIndex == 0) throw new InvalidDataException("addNode cannot use nodeIndex 0.");
                if (string.IsNullOrWhiteSpace(PerkFormKey)) throw new InvalidDataException("addNode requires perkFormKey.");
                _ = WriterApplication.ParseWorkflowFormKey(PerkFormKey);
                if (!Required.HasValue || Xnam is null or < 0 or > uint.MaxValue || Ynam is null or < 0 or > uint.MaxValue || Hnam is null || Vnam is null)
                    throw new InvalidDataException("addNode requires required, uint xnam/ynam, and finite hnam/vnam.");
                if (!float.IsFinite(Hnam.Value) || !float.IsFinite(Vnam.Value))
                    throw new InvalidDataException("addNode hnam/vnam must be finite.");
                if (FromIndex.HasValue || ToIndex.HasValue)
                    throw new InvalidDataException("addNode contains fields belonging to another operation.");
                break;
            default:
                throw new InvalidDataException($"Unsupported operation {Op}.");
        }
    }

}

internal sealed record WriterReport(
    string Status,
    string Writer,
    string WriterVersion,
    string BasePlugin,
    string BaseSha256,
    string OutputPlugin,
    string OutputSha256,
    string TargetAvif,
    string? TargetEditorId,
    int AppliedOperations,
    int OutputNodes,
    int OutputConnections);
