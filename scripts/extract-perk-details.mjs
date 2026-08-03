#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { canonicalSha256 } from "./lib/canonical-json.mjs";

// Verified against xEdit's TES5 wbCTDAFunctions table. Unknown IDs remain numeric
// and are deliberately not guessed.
const CTDA_FUNCTIONS = {
  1: { name: "GetDistance", params: ["ptObjectReference", "ptNone", "ptNone"] },
  14: { name: "GetActorValue", params: ["ptActorValue", "ptNone", "ptNone"] },
  25: { name: "IsMoving", params: ["ptNone", "ptNone", "ptNone"] },
  45: { name: "GetDetected", params: ["ptActor", "ptNone", "ptNone"] },
  72: { name: "GetIsID", params: ["ptReferencableObject", "ptNone", "ptNone"] },
  74: { name: "GetGlobalValue", params: ["ptGlobal", "ptNone", "ptNone"] },
  99: { name: "GetHeadingAngle", params: ["ptObjectReference", "ptNone", "ptNone"] },
  109: { name: "IsWeaponSkillType", params: ["ptActorValue", "ptNone", "ptNone"] },
  214: { name: "HasMagicEffect", params: ["ptMagicEffect", "ptNone", "ptNone"] },
  224: { name: "GetVATSMode", params: ["ptNone", "ptNone", "ptNone"] },
  277: { name: "GetBaseActorValue", params: ["ptActorValue", "ptNone", "ptNone"] },
  286: { name: "IsSneaking", params: ["ptNone", "ptNone", "ptNone"] },
  289: { name: "IsInCombat", params: ["ptInteger", "ptNone", "ptNone"] },
  432: { name: "GetIsObjectType", params: ["ptFormType", "ptNone", "ptNone"] },
  448: { name: "HasPerk", params: ["ptPerk", "ptInteger", "ptNone"] },
  517: { name: "GetVATSBackAreaFree", params: ["ptObjectReference", "ptNone", "ptNone"] },
  560: { name: "HasKeyword", params: ["ptKeyword", "ptNone", "ptNone"] },
  568: { name: "IsSprinting", params: ["ptNone", "ptNone", "ptNone"] },
  569: { name: "IsBlocking", params: ["ptNone", "ptNone", "ptNone"] },
  574: { name: "GetAttackState", params: ["ptNone", "ptNone", "ptNone"] },
  597: { name: "GetEquippedItemType", params: ["ptCastingSource", "ptNone", "ptNone"] },
  640: { name: "GetActorValuePercent", params: ["ptActorValue", "ptNone", "ptNone"] },
  672: { name: "IsAttacking", params: ["ptNone", "ptNone", "ptNone"] },
  673: { name: "IsPowerAttacking", params: ["ptNone", "ptNone", "ptNone"] },
  682: { name: "WornHasKeyword", params: ["ptKeyword", "ptNone", "ptNone"] },
  693: { name: "EPMagic_SpellHasKeyword", params: ["ptKeyword", "ptNone", "ptNone"] },
  696: { name: "EPMagic_SpellHasSkill", params: ["ptActorValue", "ptNone", "ptNone"] },
  697: { name: "IsAttackType", params: ["ptKeyword", "ptNone", "ptNone"] },
  699: { name: "HasMagicEffectKeyword", params: ["ptKeyword", "ptNone", "ptNone"] },
  701: { name: "IsStaggered", params: ["ptNone", "ptNone", "ptNone"] },
  707: { name: "GetCombatTargetHasKeyword", params: ["ptKeyword", "ptNone", "ptNone"] },
  715: { name: "IsUndead", params: ["ptNone", "ptNone", "ptNone"] }
};

const FORM_PARAMETER_TYPES = new Set([
  "ptActor",
  "ptGlobal",
  "ptKeyword",
  "ptMagicEffect",
  "ptObjectReference",
  "ptPerk",
  "ptReferencableObject"
]);

function usage() {
  console.error([
    "Usage: node extract-perk-details.mjs",
    "  --nodes <perk-tree-nodes.json>",
    "  --output <perk-tree-details.json>",
    "  [--plugin-root <directory>]...",
    "  [--plugin-map <plugin-path-map.json>]",
    "  [--load-order <plugins.txt>]",
    "  [--language <English>]"
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const result = { pluginRoots: [], language: "English" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) {
      usage();
    }
    if (key === "--plugin-root") {
      result.pluginRoots.push(path.resolve(value));
    } else if (key === "--nodes") {
      result.nodes = path.resolve(value);
    } else if (key === "--output") {
      result.output = path.resolve(value);
    } else if (key === "--plugin-map") {
      result.pluginMap = path.resolve(value);
    } else if (key === "--load-order") {
      result.loadOrder = path.resolve(value);
    } else if (key === "--language") {
      result.language = value;
    } else {
      usage();
    }
    index += 1;
  }
  return result;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function decodeBytes(buffer) {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }
  return new TextDecoder("windows-1252").decode(buffer);
}

function readZeroTerminatedString(buffer) {
  const end = buffer.indexOf(0);
  return decodeBytes(buffer.subarray(0, end >= 0 ? end : buffer.length));
}

function parseSubrecords(buffer) {
  const result = [];
  let position = 0;
  let extendedSize = null;
  while (position + 6 <= buffer.length) {
    const signature = buffer.toString("ascii", position, position + 4);
    let size = buffer.readUInt16LE(position + 4);
    position += 6;
    if (signature === "XXXX") {
      if (size !== 4 || position + 4 > buffer.length) {
        throw new Error(`Malformed XXXX subrecord at ${position - 6}`);
      }
      extendedSize = buffer.readUInt32LE(position);
      position += 4;
      continue;
    }
    if (extendedSize !== null) {
      size = extendedSize;
      extendedSize = null;
    }
    if (position + size > buffer.length) {
      throw new Error(`Subrecord ${signature} extends beyond its record`);
    }
    result.push({ signature, data: buffer.subarray(position, position + size) });
    position += size;
  }
  return result;
}

function parseRecords(buffer) {
  const records = [];
  function walk(start, end) {
    let position = start;
    while (position + 24 <= end) {
      const signature = buffer.toString("ascii", position, position + 4);
      const size = buffer.readUInt32LE(position + 4);
      if (signature === "GRUP") {
        if (size < 24 || position + size > end) {
          throw new Error(`Malformed GRUP at ${position}`);
        }
        walk(position + 24, position + size);
        position += size;
        continue;
      }
      if (position + 24 + size > end) {
        throw new Error(`Record ${signature} at ${position} extends beyond its group`);
      }
      const flags = buffer.readUInt32LE(position + 8);
      const formId = buffer.readUInt32LE(position + 12);
      let data = buffer.subarray(position + 24, position + 24 + size);
      if ((flags & 0x00040000) !== 0) {
        if (data.length < 4) {
          throw new Error(`Compressed record ${signature} has no size prefix`);
        }
        data = zlib.inflateSync(data.subarray(4));
      }
      records.push({ signature, formId, flags, subrecords: parseSubrecords(data) });
      position += 24 + size;
    }
  }
  walk(0, buffer.length);
  return records;
}

function getHeader(records) {
  const header = records.find((record) => record.signature === "TES4");
  if (!header) {
    throw new Error("TES4 header record not found");
  }
  return header;
}

function getMasters(records) {
  return getHeader(records).subrecords
    .filter((subrecord) => subrecord.signature === "MAST")
    .map((subrecord) => readZeroTerminatedString(subrecord.data));
}

function getEditorId(record) {
  const subrecord = record.subrecords.find((item) => item.signature === "EDID");
  return subrecord ? readZeroTerminatedString(subrecord.data) : null;
}

function toFormKey(pluginName, localFormId) {
  return `${pluginName}|${localFormId.toString(16).padStart(8, "0").toUpperCase()}`;
}

function resolveRawFormId(rawFormId, plugin) {
  if (rawFormId === 0) {
    return null;
  }
  const slot = rawFormId >>> 24;
  const localFormId = rawFormId & 0x00ffffff;
  let originPlugin = null;
  if (slot < plugin.masters.length) {
    originPlugin = plugin.masters[slot];
  } else if (slot === plugin.masters.length) {
    originPlugin = plugin.name;
  }
  return {
    raw: `0x${rawFormId.toString(16).padStart(8, "0").toUpperCase()}`,
    slot,
    localFormId: `0x${localFormId.toString(16).padStart(6, "0").toUpperCase()}`,
    formKey: originPlugin ? toFormKey(originPlugin, localFormId) : null,
    originPlugin,
    unresolvedSlot: originPlugin === null
  };
}

function walkPluginFiles(directory, result = []) {
  if (!fs.existsSync(directory)) {
    return result;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkPluginFiles(entryPath, result);
    } else if (/\.(esm|esp|esl)$/i.test(entry.name)) {
      result.push(path.resolve(entryPath));
    }
  }
  return result;
}

function readPluginPathMap(filePath) {
  if (!filePath) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new Error("plugin map must be a JSON object of plugin filename to absolute path");
  }
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name.toLowerCase(), path.resolve(String(value))]),
  );
}

function parseLoadOrder(filePath) {
  if (!filePath) {
    return null;
  }
  const lines = fs.readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const hasStars = lines.some((line) => line.startsWith("*"));
  return lines
    .filter((line) => !hasStars || line.startsWith("*"))
    .map((line) => line.replace(/^\*/, "").trim());
}

function discoverPlugins(roots, explicitMap) {
  const candidates = new Map();
  for (const pluginPath of new Set(roots.flatMap((root) => walkPluginFiles(root)))) {
    const key = path.basename(pluginPath).toLowerCase();
    if (!candidates.has(key)) {
      candidates.set(key, []);
    }
    candidates.get(key).push(pluginPath);
  }

  const resolutionCache = new Map();
  function resolve(pluginName) {
    const key = pluginName.toLowerCase();
    if (resolutionCache.has(key)) {
      return resolutionCache.get(key);
    }
    if (explicitMap[key]) {
      const explicitPath = explicitMap[key];
      let result;
      if (!fs.existsSync(explicitPath)) {
        result = { status: "missing-explicit-path", selectedPath: null, candidates: [explicitPath] };
      } else if (path.basename(explicitPath).toLowerCase() !== key) {
        result = {
          status: "explicit-plugin-name-mismatch",
          selectedPath: null,
          candidates: [explicitPath],
          expectedFilename: pluginName,
          actualFilename: path.basename(explicitPath)
        };
      } else {
        result = { status: "explicit", selectedPath: explicitPath, candidates: [explicitPath] };
      }
      resolutionCache.set(key, result);
      return result;
    }
    const paths = candidates.get(key) ?? [];
    if (paths.length === 0) {
      const result = { status: "missing", selectedPath: null, candidates: [] };
      resolutionCache.set(key, result);
      return result;
    }
    const byHash = new Map();
    for (const candidate of paths) {
      const digest = sha256(candidate);
      if (!byHash.has(digest)) {
        byHash.set(digest, []);
      }
      byHash.get(digest).push(candidate);
    }
    const result = byHash.size === 1
      ? {
          status: paths.length === 1 ? "unique" : "duplicate-identical",
          selectedPath: [...paths].sort()[0],
          candidates: [...paths].sort(),
          sha256: [...byHash.keys()][0]
        }
      : {
          status: "ambiguous-different-content",
          selectedPath: null,
          candidates: [...paths].sort(),
          candidateHashes: Object.fromEntries(
            [...byHash.entries()].map(([digest, values]) => [digest, values]),
          )
        };
    resolutionCache.set(key, result);
    return result;
  }
  return { resolve, resolutionCache };
}

function parseStringTable(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 8) {
    throw new Error(`String table is too short: ${filePath}`);
  }
  const count = buffer.readUInt32LE(0);
  const dataStart = 8 + count * 8;
  if (dataStart > buffer.length) {
    throw new Error(`String table directory exceeds file: ${filePath}`);
  }
  const lengthPrefixed = /\.(dlstrings|ilstrings)$/i.test(filePath);
  const values = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = buffer.readUInt32LE(8 + index * 8);
    const offset = buffer.readUInt32LE(12 + index * 8);
    const absoluteOffset = dataStart + offset;
    if (absoluteOffset >= buffer.length) {
      continue;
    }
    if (lengthPrefixed) {
      if (absoluteOffset + 4 > buffer.length) {
        continue;
      }
      const length = buffer.readUInt32LE(absoluteOffset);
      const end = Math.min(absoluteOffset + 4 + length, buffer.length);
      values.set(id, readZeroTerminatedString(buffer.subarray(absoluteOffset + 4, end)));
    } else {
      values.set(id, readZeroTerminatedString(buffer.subarray(absoluteOffset)));
    }
  }
  return values;
}

function loadStringTables(pluginPath, pluginName, language) {
  const directory = path.dirname(pluginPath);
  const baseName = path.basename(pluginName, path.extname(pluginName));
  const searchDirectories = [
    path.join(directory, "Strings"),
    path.join(directory, "strings"),
    directory
  ];
  const result = { strings: new Map(), dlstrings: new Map(), ilstrings: new Map(), files: [] };
  for (const extension of ["strings", "dlstrings", "ilstrings"]) {
    const expected = `${baseName}_${language}.${extension}`.toLowerCase();
    let selected = null;
    for (const searchDirectory of searchDirectories) {
      if (!fs.existsSync(searchDirectory)) {
        continue;
      }
      const match = fs.readdirSync(searchDirectory)
        .find((name) => name.toLowerCase() === expected);
      if (match) {
        selected = path.join(searchDirectory, match);
        break;
      }
    }
    if (selected) {
      try {
        result[extension] = parseStringTable(selected);
        result.files.push(selected);
      } catch (error) {
        result.files.push(`${selected} [ERROR: ${error.message}]`);
      }
    }
  }
  return result;
}

function loadPlugin(pluginName, pluginPath, language) {
  const buffer = fs.readFileSync(pluginPath);
  const records = parseRecords(buffer);
  const header = getHeader(records);
  const localized = (header.flags & 0x00000080) !== 0;
  return {
    name: pluginName,
    path: pluginPath,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    masters: getMasters(records),
    localized,
    records,
    stringTables: localized
      ? loadStringTables(pluginPath, pluginName, language)
      : { strings: new Map(), dlstrings: new Map(), ilstrings: new Map(), files: [] }
  };
}

function readLocalizedText(subrecord, plugin, preferredTable) {
  if (!subrecord) {
    return { value: null, status: "missing", stringId: null };
  }
  if (!plugin.localized) {
    return {
      value: readZeroTerminatedString(subrecord.data),
      status: "inline",
      stringId: null
    };
  }
  if (subrecord.data.length !== 4) {
    return {
      value: null,
      status: "malformed-localized-field",
      stringId: null,
      rawHex: subrecord.data.toString("hex")
    };
  }
  const stringId = subrecord.data.readUInt32LE(0);
  const searchOrder = [
    preferredTable,
    ...["strings", "dlstrings", "ilstrings"].filter((item) => item !== preferredTable)
  ];
  for (const tableName of searchOrder) {
    const value = plugin.stringTables[tableName].get(stringId);
    if (value !== undefined) {
      return { value, status: `localized:${tableName}`, stringId };
    }
  }
  return { value: null, status: "unresolved-string-id", stringId };
}

function parseCondition(data, plugin, tabIndex = null) {
  if (data.length < 32) {
    return {
      status: "malformed",
      size: data.length,
      rawHex: data.toString("hex"),
      tabIndex
    };
  }
  const type = data.readUInt8(0);
  const comparisonRaw = data.readUInt32LE(4);
  const comparisonBuffer = Buffer.allocUnsafe(4);
  comparisonBuffer.writeUInt32LE(comparisonRaw);
  const parameter1 = data.readUInt32LE(12);
  const parameter2 = data.readUInt32LE(16);
  const reference = data.readUInt32LE(24);
  const operatorCode = (type & 0xe0) >>> 5;
  const functionId = data.readUInt16LE(8);
  const functionDefinition = CTDA_FUNCTIONS[functionId] ?? null;
  const rawParameters = [parameter1, parameter2];
  return {
    status: "decoded-raw",
    tabIndex,
    typeRaw: type,
    operatorCode,
    operator: [
      "Equal",
      "NotEqual",
      "Greater",
      "GreaterOrEqual",
      "Less",
      "LessOrEqual",
      "Unknown6",
      "Unknown7"
    ][operatorCode],
    flags: {
      or: (type & 0x01) !== 0,
      useAliases: (type & 0x02) !== 0,
      useGlobal: (type & 0x04) !== 0,
      usePackData: (type & 0x08) !== 0,
      swapSubjectAndTarget: (type & 0x10) !== 0
    },
    flagsRaw: type & 0x1f,
    comparison: {
      rawUInt32: comparisonRaw,
      asFloat: comparisonBuffer.readFloatLE(0),
      useGlobalCandidate: (type & 0x04) !== 0
        ? resolveRawFormId(comparisonRaw, plugin)
        : null
    },
    functionId,
    function: functionDefinition
      ? {
          name: functionDefinition.name,
          parameterTypes: functionDefinition.params,
          status: "verified-xedit-table"
        }
      : {
          name: null,
          parameterTypes: ["unknown", "unknown", "unknown"],
          status: "unmapped-numeric-id"
        },
    parameters: rawParameters.map((rawValue, index) => {
      const expectedType = functionDefinition?.params[index] ?? "unknown";
      return {
        expectedType,
        rawUInt32: rawValue,
        signedInt32: rawValue > 0x7fffffff ? rawValue - 0x100000000 : rawValue,
        formReference: FORM_PARAMETER_TYPES.has(expectedType)
          ? resolveRawFormId(rawValue, plugin)
          : null,
        formReferenceCandidate: functionDefinition
          ? null
          : resolveRawFormId(rawValue, plugin)
      };
    }),
    runOnType: data.readUInt32LE(20),
    reference: resolveRawFormId(reference, plugin),
    parameter3: data.readInt32LE(28),
    rawHex: data.toString("hex")
  };
}

function parseEffectData(data, type, plugin) {
  if (type === 0 && data.length >= 8) {
    return {
      kind: "quest-stage",
      quest: resolveRawFormId(data.readUInt32LE(0), plugin),
      stage: data.readUInt8(4)
    };
  }
  if (type === 1 && data.length >= 4) {
    return {
      kind: "ability",
      ability: resolveRawFormId(data.readUInt32LE(0), plugin)
    };
  }
  if (type === 2 && data.length >= 3) {
    return {
      kind: "entry-point",
      entryPoint: data.readUInt8(0),
      function: data.readUInt8(1),
      conditionTabCount: data.readUInt8(2)
    };
  }
  return {
    kind: "unknown",
    effectType: type,
    rawHex: data.toString("hex")
  };
}

function parseEffectParameter(signature, data, plugin) {
  if (signature === "EPFT" && data.length >= 1) {
    return { signature, type: data.readUInt8(0) };
  }
  if (signature === "EPF2") {
    return {
      signature,
      text: readLocalizedText({ data }, plugin, "strings")
    };
  }
  if (signature === "EPF3" && data.length >= 4) {
    return {
      signature,
      scriptFlags: data.readUInt16LE(0),
      fragmentIndex: data.readUInt16LE(2)
    };
  }
  if (signature === "EPFD") {
    if (data.length === 4) {
      return {
        signature,
        rawUInt32: data.readUInt32LE(0),
        asFloat: data.readFloatLE(0),
        formReferenceCandidate: resolveRawFormId(data.readUInt32LE(0), plugin)
      };
    }
    if (data.length === 8) {
      return {
        signature,
        rawUInt32: [data.readUInt32LE(0), data.readUInt32LE(4)],
        asFloat: [data.readFloatLE(0), data.readFloatLE(4)]
      };
    }
  }
  return { signature, rawHex: data.toString("hex") };
}

function parsePerkRecord(record, plugin, formKey) {
  const full = readLocalizedText(
    record.subrecords.find((item) => item.signature === "FULL"),
    plugin,
    "strings",
  );
  const description = readLocalizedText(
    record.subrecords.find((item) => item.signature === "DESC"),
    plugin,
    "dlstrings",
  );
  const acquisitionConditions = [];
  const effects = [];
  let perkData = null;
  let nextPerk = null;
  let icon = null;
  let currentEffect = null;
  let currentTabIndex = null;
  let vmad = null;

  for (const subrecord of record.subrecords) {
    const { signature, data } = subrecord;
    if (signature === "PRKE") {
      currentEffect = {
        type: data.length >= 1 ? data.readUInt8(0) : null,
        rank: data.length >= 2 ? data.readUInt8(1) : null,
        priority: data.length >= 3 ? data.readUInt8(2) : null,
        data: null,
        conditions: [],
        parameters: []
      };
      effects.push(currentEffect);
      currentTabIndex = null;
    } else if (signature === "PRKF") {
      currentEffect = null;
      currentTabIndex = null;
    } else if (signature === "PRKC" && currentEffect) {
      currentTabIndex = data.length >= 1 ? data.readInt8(0) : null;
    } else if (signature === "CTDA") {
      const condition = parseCondition(data, plugin, currentTabIndex);
      if (currentEffect) {
        currentEffect.conditions.push(condition);
      } else {
        acquisitionConditions.push(condition);
      }
    } else if (signature === "DATA") {
      if (currentEffect) {
        currentEffect.data = parseEffectData(data, currentEffect.type, plugin);
      } else if (data.length >= 5) {
        perkData = {
          trait: data.readUInt8(0) !== 0,
          level: data.readUInt8(1),
          numRanks: data.readUInt8(2),
          playable: data.readUInt8(3) !== 0,
          hidden: data.readUInt8(4) !== 0
        };
      }
    } else if (signature === "NNAM" && data.length >= 4) {
      nextPerk = resolveRawFormId(data.readUInt32LE(0), plugin);
    } else if (signature === "ICON") {
      icon = readZeroTerminatedString(data);
    } else if (signature === "VMAD") {
      vmad = {
        present: true,
        size: data.length,
        status: "raw-not-expanded"
      };
    } else if (currentEffect && ["EPFT", "EPF2", "EPF3", "EPFD"].includes(signature)) {
      currentEffect.parameters.push(parseEffectParameter(signature, data, plugin));
    }
  }

  const unresolved = [];
  if (full.status === "unresolved-string-id") {
    unresolved.push(`FULL string ID ${full.stringId} was not found`);
  }
  if (description.status === "unresolved-string-id") {
    unresolved.push(`DESC string ID ${description.stringId} was not found`);
  }
  if (vmad) {
    unresolved.push("VMAD script data is present but not semantically expanded");
  }
  const allConditions = [
    ...acquisitionConditions,
    ...effects.flatMap((effect) => effect.conditions)
  ];
  if (allConditions.some((condition) => condition.function?.status === "unmapped-numeric-id")) {
    unresolved.push("One or more CTDA function IDs are not in the bundled verified function map");
  }

  return {
    formKey,
    editorId: getEditorId(record),
    name: full,
    description,
    recordFlags: `0x${record.flags.toString(16).padStart(8, "0").toUpperCase()}`,
    data: perkData,
    nextPerk,
    icon,
    acquisitionConditions,
    effects,
    vmad,
    source: {
      plugin: plugin.name,
      path: plugin.path,
      sha256: plugin.sha256,
      localized: plugin.localized,
      stringFiles: plugin.stringTables.files
    },
    unresolved
  };
}

function parseSpellEffects(record, plugin) {
  const effects = [];
  let current = null;
  for (const subrecord of record.subrecords) {
    const { signature, data } = subrecord;
    if (signature === "EFID" && data.length >= 4) {
      current = {
        baseEffect: resolveRawFormId(data.readUInt32LE(0), plugin),
        magnitude: null,
        area: null,
        duration: null,
        conditions: []
      };
      effects.push(current);
    } else if (signature === "EFIT" && current && data.length >= 12) {
      current.magnitude = data.readFloatLE(0);
      current.area = data.readUInt32LE(4);
      current.duration = data.readUInt32LE(8);
    } else if (signature === "CTDA" && current) {
      current.conditions.push(parseCondition(data, plugin));
    }
  }
  return effects;
}

function summarizeReferencedRecord(record, plugin, formKey) {
  const full = readLocalizedText(
    record.subrecords.find((item) => item.signature === "FULL"),
    plugin,
    "strings",
  );
  const description = readLocalizedText(
    record.subrecords.find((item) => item.signature === "DESC"),
    plugin,
    "dlstrings",
  );
  const result = {
    formKey,
    signature: record.signature,
    editorId: getEditorId(record),
    name: full,
    description,
    recordFlags: `0x${record.flags.toString(16).padStart(8, "0").toUpperCase()}`,
    source: {
      plugin: plugin.name,
      path: plugin.path,
      sha256: plugin.sha256,
      localized: plugin.localized
    },
    subrecords: record.subrecords.map((subrecord) => ({
      signature: subrecord.signature,
      size: subrecord.data.length
    }))
  };
  if (record.signature === "SPEL") {
    result.spellEffects = parseSpellEffects(record, plugin);
  }
  return result;
}

function collectFormKeys(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFormKeys(item, result);
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "formKey" && typeof item === "string" && /^[^|]+\|[0-9A-Fa-f]{8}$/.test(item)) {
        result.add(item);
      } else {
        collectFormKeys(item, result);
      }
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.nodes || !args.output) {
  usage();
}
if (!fs.existsSync(args.nodes)) {
  throw new Error(`Node export does not exist: ${args.nodes}`);
}

const nodeExport = JSON.parse(fs.readFileSync(args.nodes, "utf8"));
const explicitMap = readPluginPathMap(args.pluginMap);
const roots = [
  path.dirname(nodeExport.source),
  ...args.pluginRoots
];
const discovery = discoverPlugins([...new Set(roots)], explicitMap);
const loadOrder = parseLoadOrder(args.loadOrder);
const pluginCache = new Map();
const pluginFailures = [];

function getPlugin(pluginName) {
  const key = pluginName.toLowerCase();
  if (pluginCache.has(key)) {
    return pluginCache.get(key);
  }
  const resolution = discovery.resolve(pluginName);
  if (!resolution.selectedPath) {
    pluginCache.set(key, null);
    pluginFailures.push({ plugin: pluginName, ...resolution });
    return null;
  }
  try {
    const plugin = loadPlugin(pluginName, resolution.selectedPath, args.language);
    plugin.pathResolution = resolution;
    pluginCache.set(key, plugin);
    return plugin;
  } catch (error) {
    pluginCache.set(key, null);
    pluginFailures.push({
      plugin: pluginName,
      status: "parse-failed",
      selectedPath: resolution.selectedPath,
      error: error.message
    });
    return null;
  }
}

const targetFormKeys = new Set(
  nodeExport.trees.flatMap((tree) =>
    tree.nodes
      .map((node) => node.perkFormKey)
      .filter((formKey) => formKey && formKey !== "NULL"),
  ),
);
const overrideChains = new Map([...targetFormKeys].map((formKey) => [formKey, []]));
const targetAvifFormKeys = new Set(
  nodeExport.trees.map((tree) => tree.formKey).filter(Boolean),
);
const avifOverrideChains = new Map([...targetAvifFormKeys].map((formKey) => [formKey, []]));

if (loadOrder) {
  for (const pluginName of loadOrder) {
    const plugin = getPlugin(pluginName);
    if (!plugin) {
      continue;
    }
    for (const record of plugin.records.filter((item) => item.signature === "PERK")) {
      const resolved = resolveRawFormId(record.formId, plugin);
      if (!resolved?.formKey || !targetFormKeys.has(resolved.formKey)) {
        continue;
      }
      overrideChains.get(resolved.formKey).push({
        plugin,
        record,
        perk: parsePerkRecord(record, plugin, resolved.formKey)
      });
    }
    for (const record of plugin.records.filter((item) => item.signature === "AVIF")) {
      const resolved = resolveRawFormId(record.formId, plugin);
      if (resolved?.formKey && targetAvifFormKeys.has(resolved.formKey)) {
        avifOverrideChains.get(resolved.formKey).push({ plugin, record });
      }
    }
  }
} else {
  const formKeysByPlugin = new Map();
  for (const formKey of targetFormKeys) {
    const separator = formKey.lastIndexOf("|");
    const pluginName = formKey.slice(0, separator);
    if (!formKeysByPlugin.has(pluginName)) {
      formKeysByPlugin.set(pluginName, new Set());
    }
    formKeysByPlugin.get(pluginName).add(formKey);
  }
  for (const [pluginName, formKeys] of formKeysByPlugin) {
    const plugin = getPlugin(pluginName);
    if (!plugin) {
      continue;
    }
    for (const record of plugin.records.filter((item) => item.signature === "PERK")) {
      const resolved = resolveRawFormId(record.formId, plugin);
      if (!resolved?.formKey || !formKeys.has(resolved.formKey)) {
        continue;
      }
      overrideChains.get(resolved.formKey).push({
        plugin,
        record,
        perk: parsePerkRecord(record, plugin, resolved.formKey)
      });
    }
  }
}

const sourcePluginName = path.basename(nodeExport.source);
const activePluginNames = new Set((loadOrder ?? []).map((pluginName) => pluginName.toLowerCase()));
const sourcePluginPresent = Boolean(loadOrder)
  && activePluginNames.has(sourcePluginName.toLowerCase());
const missingSourceMastersInLoadOrder = loadOrder
  ? nodeExport.masters.filter((master) => !activePluginNames.has(master.toLowerCase()))
  : [];
const loadOrderComplete = Boolean(loadOrder)
  && sourcePluginPresent
  && missingSourceMastersInLoadOrder.length === 0
  && pluginFailures.length === 0;

const resolvedPlugins = (loadOrder ?? []).map((pluginName) => {
  const plugin = getPlugin(pluginName);
  return plugin
    ? { name: plugin.name, path: plugin.path, sha256: plugin.sha256, pathResolution: plugin.pathResolution.status }
    : { name: pluginName, path: null, sha256: null, pathResolution: "unresolved" };
});
const frozenContext = loadOrderComplete
  ? {
      loadOrderSha256: sha256(args.loadOrder),
      pluginMapSha256: args.pluginMap ? sha256(args.pluginMap) : null,
      pluginRoots: [...args.pluginRoots].sort(),
      language: args.language,
      resolvedPlugins
    }
  : null;
const frozenContextSha256 = frozenContext ? canonicalSha256(frozenContext) : null;

let resolvedPerks = 0;
let namedPerks = 0;
let describedPerks = 0;
let acquisitionConditionCount = 0;
let effectConditionCount = 0;
let mappedConditionCount = 0;
let unmappedConditionCount = 0;
let effectCount = 0;
let winningOverridesVerified = 0;
let visibleNodeCount = 0;

const detailedTrees = nodeExport.trees.map((tree) => ({
  editorId: tree.editorId,
  displayName: tree.displayName,
  formId: tree.formId,
  formKey: tree.formKey,
  unresolvedFormIdSlot: Boolean(tree.unresolvedFormIdSlot),
  avifResolution: (() => {
    const chain = avifOverrideChains.get(tree.formKey) ?? [];
    const winner = chain.at(-1) ?? null;
    const winningOverrideVerified = Boolean(
      loadOrderComplete
      && winner
      && path.resolve(winner.plugin.path) === path.resolve(nodeExport.source),
    );
    return {
      status: !loadOrderComplete
        ? "unverified-load-order"
        : winner
          ? winningOverrideVerified ? "source-is-winning-override" : "source-is-not-winning-override"
          : "target-avif-unresolved",
      winningOverrideVerified,
      overrideChain: chain.map((entry) => ({
        plugin: entry.plugin.name,
        path: entry.plugin.path,
        sha256: entry.plugin.sha256,
        rawFormId: `0x${entry.record.formId.toString(16).padStart(8, "0").toUpperCase()}`
      })),
      winner: winner
        ? { plugin: winner.plugin.name, path: winner.plugin.path, sha256: winner.plugin.sha256 }
        : null
    };
  })(),
  maxGridX: tree.maxGridX,
  validation: tree.validation,
  nodes: tree.nodes.map((node) => {
    if (!node.invisibleRoot) {
      visibleNodeCount += 1;
    }
    const chain = node.perkFormKey === "NULL"
      ? []
      : (overrideChains.get(node.perkFormKey) ?? []);
    const winner = chain.at(-1) ?? null;
    if (winner) {
      resolvedPerks += node.invisibleRoot ? 0 : 1;
      namedPerks += !node.invisibleRoot && winner.perk.name.value ? 1 : 0;
      describedPerks += !node.invisibleRoot && winner.perk.description.value ? 1 : 0;
      acquisitionConditionCount += node.invisibleRoot
        ? 0
        : winner.perk.acquisitionConditions.length;
      effectCount += node.invisibleRoot ? 0 : winner.perk.effects.length;
      const conditions = node.invisibleRoot
        ? []
        : [
            ...winner.perk.acquisitionConditions,
            ...winner.perk.effects.flatMap((effect) => effect.conditions)
          ];
      effectConditionCount += node.invisibleRoot
        ? 0
        : winner.perk.effects.reduce((sum, effect) => sum + effect.conditions.length, 0);
      mappedConditionCount += conditions
        .filter((condition) => condition.function?.status === "verified-xedit-table")
        .length;
      unmappedConditionCount += conditions
        .filter((condition) => condition.function?.status === "unmapped-numeric-id")
        .length;
      winningOverridesVerified += !node.invisibleRoot && loadOrderComplete ? 1 : 0;
    }
    return {
      ...node,
      perkResolution: node.perkFormKey === "NULL"
        ? {
            status: "invisible-root",
            winningOverrideVerified: false,
            overrideChain: [],
            perk: null
          }
        : winner
          ? {
              status: loadOrderComplete
                ? "winning-override-from-complete-load-order"
                : loadOrder
                  ? "best-known-record-from-incomplete-load-order"
                  : "origin-record-only",
              winningOverrideVerified: loadOrderComplete,
              overrideChain: chain.map((entry) => ({
                plugin: entry.plugin.name,
                path: entry.plugin.path,
                sha256: entry.plugin.sha256,
                editorId: entry.perk.editorId
              })),
              perk: winner.perk
            }
          : {
              status: "unresolved",
              winningOverrideVerified: false,
              overrideChain: [],
              perk: null
            }
    };
  })
}));

function findRecordChain(formKey) {
  const chain = [];
  const inspectPlugin = (plugin) => {
    if (!plugin) {
      return;
    }
    for (const record of plugin.records) {
      if (record.signature === "TES4") {
        continue;
      }
      const resolved = resolveRawFormId(record.formId, plugin);
      if (resolved?.formKey === formKey) {
        chain.push({
          plugin,
          record,
          summary: summarizeReferencedRecord(record, plugin, formKey)
        });
      }
    }
  };

  if (loadOrder) {
    for (const pluginName of loadOrder) {
      inspectPlugin(getPlugin(pluginName));
    }
  } else {
    const separator = formKey.lastIndexOf("|");
    inspectPlugin(getPlugin(formKey.slice(0, separator)));
  }
  return chain;
}

const referencedRecords = {};
const referenceQueue = [
  ...collectFormKeys(
    detailedTrees.flatMap((tree) =>
      tree.nodes.map((node) => node.perkResolution?.perk).filter(Boolean),
    ),
  )
].filter((formKey) => !targetFormKeys.has(formKey));
const queuedReferences = new Set(referenceQueue);

while (referenceQueue.length > 0 && Object.keys(referencedRecords).length < 5000) {
  const formKey = referenceQueue.shift();
  const chain = findRecordChain(formKey);
  const winner = chain.at(-1) ?? null;
  referencedRecords[formKey] = winner
    ? {
        status: loadOrderComplete
          ? "winning-override-from-complete-load-order"
          : loadOrder
            ? "best-known-record-from-incomplete-load-order"
            : "origin-record-only",
        winningOverrideVerified: loadOrderComplete,
        overrideChain: chain.map((entry) => ({
          plugin: entry.plugin.name,
          path: entry.plugin.path,
          sha256: entry.plugin.sha256,
          signature: entry.record.signature,
          editorId: entry.summary.editorId
        })),
        record: winner.summary
      }
    : {
        status: "unresolved",
        winningOverrideVerified: false,
        overrideChain: [],
        record: null
      };

  if (winner) {
    for (const nestedFormKey of collectFormKeys(winner.summary)) {
      if (
        !targetFormKeys.has(nestedFormKey)
        && !queuedReferences.has(nestedFormKey)
        && !Object.hasOwn(referencedRecords, nestedFormKey)
      ) {
        queuedReferences.add(nestedFormKey);
        referenceQueue.push(nestedFormKey);
      }
    }
  }
}

const resolvedReferencedRecords = Object.values(referencedRecords)
  .filter((item) => item.record !== null)
  .length;
const avifWinnersVerified = detailedTrees.filter((tree) => tree.avifResolution.winningOverrideVerified).length;
const allSourceAvifWinnersVerified = loadOrderComplete
  && detailedTrees.length > 0
  && avifWinnersVerified === detailedTrees.length;

const result = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  source: nodeExport.source,
  sourceSha256: nodeExport.sourceSha256,
  resolution: {
    mode: loadOrderComplete
      ? "explicit-load-order-complete"
      : loadOrder
        ? "explicit-load-order-incomplete"
        : "origin-only",
    loadOrderFile: args.loadOrder ?? null,
    loadOrderSha256: args.loadOrder ? sha256(args.loadOrder) : null,
    loadOrder,
    pluginMapFile: args.pluginMap ?? null,
    pluginMapSha256: args.pluginMap ? sha256(args.pluginMap) : null,
    pluginRoots: args.pluginRoots,
    sourceDirectory: path.dirname(nodeExport.source),
    language: args.language,
    sourcePluginPresent,
    missingSourceMastersInLoadOrder,
    winningOverrideVerified: allSourceAvifWinnersVerified,
    perkWinningOverridesVerified: loadOrderComplete,
    avifWinnersVerified,
    pluginFailures,
    resolvedPlugins,
    frozenContext,
    frozenContextSha256
  },
  summary: {
    trees: detailedTrees.length,
    visibleNodes: visibleNodeCount,
    resolvedPerks,
    unresolvedPerks: visibleNodeCount - resolvedPerks,
    namedPerks,
    describedPerks,
    acquisitionConditions: acquisitionConditionCount,
    effectConditions: effectConditionCount,
    mappedConditions: mappedConditionCount,
    unmappedConditions: unmappedConditionCount,
    effects: effectCount,
    winningOverridesVerified,
    avifWinnersVerified,
    referencedRecords: Object.keys(referencedRecords).length,
    resolvedReferencedRecords,
    unresolvedReferencedRecords: Object.keys(referencedRecords).length - resolvedReferencedRecords
  },
  trees: detailedTrees,
  referencedRecords
};

fs.mkdirSync(path.dirname(args.output), { recursive: true });
fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  output: args.output,
  mode: result.resolution.mode,
  ...result.summary
}, null, 2));
