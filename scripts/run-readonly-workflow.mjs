#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function usage() {
  console.error([
    "Usage: node run-readonly-workflow.mjs",
    "  --input <plugin.esp>",
    "  --output <output-directory>",
    "  [--master-root <directory>]...",
    "  [--plugin-map <plugin-path-map.json>]",
    "  [--load-order <plugins.txt>]",
    "  [--language <English>]",
    "  [--expected-sha256 <sha256>]"
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const result = { masterRoots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) {
      usage();
    }
    if (key === "--master-root") {
      result.masterRoots.push(value);
    } else if (key === "--input") {
      result.input = value;
    } else if (key === "--output") {
      result.output = value;
    } else if (key === "--expected-sha256") {
      result.expectedSha256 = value.toLowerCase();
    } else if (key === "--plugin-map") {
      result.pluginMap = value;
    } else if (key === "--load-order") {
      result.loadOrder = value;
    } else if (key === "--language") {
      result.language = value;
    } else {
      usage();
    }
    index += 1;
  }
  return result;
}

function run(command, argumentsList) {
  const result = spawnSync(command, argumentsList, {
    stdio: "inherit",
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output) {
  usage();
}

const inputPath = path.resolve(args.input);
const outputPath = path.resolve(args.output);
if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
  console.error(`Input plugin does not exist or is not a file: ${inputPath}`);
  process.exit(1);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(scriptDirectory, "skyrim-perk-tree-svg.mjs");
const detailExtractor = path.join(scriptDirectory, "extract-perk-details.mjs");
const labelRenderer = path.join(scriptDirectory, "render-perk-tree-labels.mjs");
const validator = path.join(scriptDirectory, "validate-output.mjs");

run(process.execPath, [renderer, inputPath, outputPath, ...args.masterRoots]);

const manifestPath = path.join(outputPath, "manifest.json");
const detailsPath = path.join(outputPath, "perk-tree-details.json");
const detailArguments = [
  detailExtractor,
  "--nodes",
  path.join(outputPath, "perk-tree-nodes.json"),
  "--output",
  detailsPath
];
for (const root of args.masterRoots) {
  detailArguments.push("--plugin-root", root);
}
if (args.pluginMap) {
  detailArguments.push("--plugin-map", args.pluginMap);
}
if (args.loadOrder) {
  detailArguments.push("--load-order", args.loadOrder);
}
if (args.language) {
  detailArguments.push("--language", args.language);
}
run(process.execPath, detailArguments);

run(process.execPath, [
  labelRenderer,
  "--details",
  detailsPath,
  "--svg-directory",
  outputPath,
  "--output",
  outputPath,
]);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const annotationManifestPath = path.join(outputPath, "perk-tree-svg-annotations.json");
const annotationManifest = JSON.parse(fs.readFileSync(annotationManifestPath, "utf8"));
manifest.details = detailsPath;
manifest.annotatedOverview = annotationManifest.overview;
manifest.annotationManifest = annotationManifestPath;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const validatorArguments = [
  validator,
  "--manifest",
  manifestPath
];
if (args.expectedSha256) {
  validatorArguments.push("--expected-sha256", args.expectedSha256);
}
run(process.execPath, validatorArguments);

console.log(`Read-only workflow completed: ${outputPath}`);
