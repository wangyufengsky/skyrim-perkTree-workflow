#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { canonicalSha256, sha256 } from "./lib/canonical-json.mjs";

function usage() {
  console.error([
    "Usage: node verify-avif-winner.mjs",
    "  --base <plugin.esp>",
    "  --target-avif <Plugin.ext|00000000>",
    "  --expected-winner <plugin filename>",
    "  --plugin-map <plugin-path-map.json>",
    "  --load-order <plugins.txt>",
    "  --output <winner-proof.json>",
    "  [--master-root <directory>]..."
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const result = { masterRoots: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (key === "--master-root") result.masterRoots.push(path.resolve(value));
    else if (key === "--base") result.base = path.resolve(value);
    else if (key === "--target-avif") result.targetAvif = value;
    else if (key === "--expected-winner") result.expectedWinner = value;
    else if (key === "--plugin-map") result.pluginMap = path.resolve(value);
    else if (key === "--load-order") result.loadOrder = path.resolve(value);
    else if (key === "--output") result.output = path.resolve(value);
    else usage();
  }
  return result;
}

function fail(message) { throw new Error(`AVIF winner verification failed: ${message}`); }

function parseLoadOrder(filePath) {
  const lines = fs.readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const hasStars = lines.some((line) => line.startsWith("*"));
  const active = lines
    .filter((line) => !hasStars || line.startsWith("*"))
    .map((line) => line.replace(/^\*/, "").trim());
  if (active.length === 0) fail("load order contains no active plugins");
  const seen = new Set();
  for (const pluginName of active) {
    const key = pluginName.toLowerCase();
    if (seen.has(key)) fail(`load order contains duplicate plugin ${pluginName}`);
    seen.add(key);
  }
  return active;
}

function readPluginMap(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw || Array.isArray(raw) || typeof raw !== "object") fail("plugin map must be an object");
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => {
    const mappedPath = String(value);
    if (!path.isAbsolute(mappedPath)) fail(`plugin map path must be absolute for ${name}: ${mappedPath}`);
    return [name.toLowerCase(), path.resolve(mappedPath)];
  }));
}

function walkPlugins(directory, result = []) {
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkPlugins(entryPath, result);
    else if (/\.(esm|esp|esl)$/i.test(entry.name)) result.push(path.resolve(entryPath));
  }
  return result;
}

function parseSubrecords(buffer) {
  const result = [];
  let position = 0; let extendedSize = null;
  while (position + 6 <= buffer.length) {
    const signature = buffer.toString("ascii", position, position + 4);
    let size = buffer.readUInt16LE(position + 4);
    position += 6;
    if (signature === "XXXX") {
      if (size !== 4 || position + 4 > buffer.length) fail("malformed XXXX subrecord");
      extendedSize = buffer.readUInt32LE(position);
      position += 4;
      continue;
    }
    if (extendedSize !== null) { size = extendedSize; extendedSize = null; }
    if (position + size > buffer.length) fail(`subrecord ${signature} exceeds record`);
    result.push({ signature, data: buffer.subarray(position, position + size) });
    position += size;
  }
  return result;
}

function readZeroTerminatedString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end >= 0 ? end : buffer.length).toString("utf8");
}

function indexPlugin(pluginPath, pluginName) {
  const buffer = fs.readFileSync(pluginPath);
  const records = [];
  let headerSubrecords = null;
  function walk(start, end) {
    let position = start;
    while (position + 24 <= end) {
      const signature = buffer.toString("ascii", position, position + 4);
      const size = buffer.readUInt32LE(position + 4);
      if (signature === "GRUP") {
        if (size < 24 || position + size > end) fail(`malformed GRUP in ${pluginName}`);
        walk(position + 24, position + size);
        position += size;
        continue;
      }
      if (position + 24 + size > end) fail(`record ${signature} exceeds group in ${pluginName}`);
      const formId = buffer.readUInt32LE(position + 12);
      records.push({ signature, formId });
      if (signature === "TES4") headerSubrecords = parseSubrecords(buffer.subarray(position + 24, position + 24 + size));
      position += 24 + size;
    }
  }
  walk(0, buffer.length);
  if (!headerSubrecords) fail(`TES4 header missing in ${pluginName}`);
  const masters = headerSubrecords
    .filter((item) => item.signature === "MAST")
    .map((item) => readZeroTerminatedString(item.data));
  return { name: pluginName, path: pluginPath, sha256: sha256(buffer), masters, records };
}

function formKey(rawFormId, plugin) {
  const slot = rawFormId >>> 24;
  const localId = rawFormId & 0x00ffffff;
  const origin = slot < plugin.masters.length
    ? plugin.masters[slot]
    : slot === plugin.masters.length
      ? plugin.name
      : null;
  return origin ? `${origin}|${localId.toString(16).padStart(8, "0").toUpperCase()}` : null;
}

function normalizeFormKey(value) {
  const separator = value.lastIndexOf("|");
  if (separator <= 0 || !/^[0-9a-f]{8}$/i.test(value.slice(separator + 1))) fail(`invalid target FormKey ${value}`);
  return `${value.slice(0, separator).toLowerCase()}|${value.slice(separator + 1).toUpperCase()}`;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["base", "targetAvif", "expectedWinner", "pluginMap", "loadOrder", "output"]) if (!args[key]) usage();
for (const filePath of [args.base, args.pluginMap, args.loadOrder]) if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`required file missing: ${filePath}`);
for (const root of args.masterRoots) if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`master root missing: ${root}`);
if (fs.existsSync(args.output)) fail(`proof output already exists: ${args.output}`);

const baseName = path.basename(args.base);
if (baseName.toLowerCase() !== args.expectedWinner.toLowerCase()) fail(`expected winner ${args.expectedWinner} does not name base ${baseName}`);
const loadOrder = parseLoadOrder(args.loadOrder);
const activeNames = new Set(loadOrder.map((name) => name.toLowerCase()));
if (!activeNames.has(baseName.toLowerCase())) fail(`base plugin is not active in load order: ${baseName}`);
const explicitMap = readPluginMap(args.pluginMap);
const candidates = new Map();
for (const pluginPath of new Set([path.dirname(args.base), ...args.masterRoots].flatMap((root) => walkPlugins(root)))) {
  const key = path.basename(pluginPath).toLowerCase();
  if (!candidates.has(key)) candidates.set(key, []);
  candidates.get(key).push(pluginPath);
}

function resolvePlugin(pluginName) {
  const key = pluginName.toLowerCase();
  const explicit = explicitMap[key];
  if (explicit) {
    if (!fs.existsSync(explicit) || !fs.statSync(explicit).isFile()) fail(`mapped plugin path missing for ${pluginName}: ${explicit}`);
    if (path.basename(explicit).toLowerCase() !== key) fail(`mapped filename mismatch for ${pluginName}: ${explicit}`);
    return { selectedPath: explicit, resolution: "explicit", candidates: [explicit] };
  }
  const paths = candidates.get(key) ?? [];
  if (paths.length === 0) fail(`active plugin cannot be resolved: ${pluginName}`);
  const hashes = new Map(paths.map((candidate) => [candidate, sha256(fs.readFileSync(candidate))]));
  if (new Set(hashes.values()).size > 1) fail(`active plugin has different-content duplicates and needs plugin-map entry: ${pluginName}`);
  const baseCandidate = key === baseName.toLowerCase() ? paths.find((candidate) => fs.realpathSync(candidate) === fs.realpathSync(args.base)) : null;
  return { selectedPath: baseCandidate ?? [...paths].sort()[0], resolution: paths.length === 1 ? "unique" : "duplicate-identical", candidates: [...paths].sort() };
}

const plugins = loadOrder.map((pluginName) => {
  const resolved = resolvePlugin(pluginName);
  const plugin = indexPlugin(resolved.selectedPath, pluginName);
  return { ...plugin, pathResolution: resolved.resolution, candidates: resolved.candidates };
});
const target = normalizeFormKey(args.targetAvif);
const chain = [];
for (const plugin of plugins) {
  for (const record of plugin.records) {
    if (record.signature !== "AVIF") continue;
    const resolved = formKey(record.formId, plugin);
    if (resolved && normalizeFormKey(resolved) === target) {
      chain.push({ plugin: plugin.name, path: plugin.path, sha256: plugin.sha256, rawFormId: `0x${record.formId.toString(16).padStart(8, "0").toUpperCase()}` });
    }
  }
}
if (chain.length === 0) fail(`target AVIF ${args.targetAvif} has no active override`);
const winner = chain.at(-1);
if (winner.plugin.toLowerCase() !== baseName.toLowerCase()) fail(`target AVIF winner is ${winner.plugin}, not ${baseName}`);
if (fs.realpathSync(winner.path) !== fs.realpathSync(args.base)) fail(`winning physical path ${winner.path} does not equal --base ${args.base}`);

const proof = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: "verified",
  winningOverrideVerified: true,
  targetAvif: args.targetAvif,
  expectedWinnerPlugin: args.expectedWinner,
  winner,
  overrideChain: chain,
  loadOrderFile: args.loadOrder,
  loadOrderSha256: sha256(fs.readFileSync(args.loadOrder)),
  pluginMapFile: args.pluginMap,
  pluginMapSha256: sha256(fs.readFileSync(args.pluginMap)),
  masterRoots: args.masterRoots,
  resolvedPlugins: plugins.map((plugin) => ({ name: plugin.name, path: plugin.path, sha256: plugin.sha256, pathResolution: plugin.pathResolution, candidates: plugin.candidates }))
};
proof.proofSha256 = canonicalSha256({ ...proof, generatedAt: null });
fs.mkdirSync(path.dirname(args.output), { recursive: true });
fs.writeFileSync(args.output, `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify({ status: proof.status, targetAvif: proof.targetAvif, winner: proof.winner, proof: args.output, proofSha256: proof.proofSha256 }, null, 2));
