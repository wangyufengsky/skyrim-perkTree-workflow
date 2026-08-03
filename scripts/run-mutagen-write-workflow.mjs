#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function usage() {
  console.error([
    "Usage: node run-mutagen-write-workflow.mjs",
    "  --base <verified-winning-plugin.esp>",
    "  --change-set <change-set.json>",
    "  --output <new-patch.esp>",
    "  [--verification-output <directory>]",
    "  [--dotnet <dotnet-executable>]",
    "  [--game-release <SkyrimSE|SkyrimLE>]",
    "  [--master-root <directory>]...",
    "  [--plugin-map <plugin-path-map.json>]",
    "  [--load-order <plugins.txt>]",
    "  [--language <English>]"
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const result = { masterRoots: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (key === "--master-root") result.masterRoots.push(value);
    else if (key === "--base") result.base = value;
    else if (key === "--change-set") result.changeSet = value;
    else if (key === "--output") result.output = value;
    else if (key === "--verification-output") result.verificationOutput = value;
    else if (key === "--dotnet") result.dotnet = value;
    else if (key === "--game-release") result.gameRelease = value;
    else if (key === "--plugin-map") result.pluginMap = value;
    else if (key === "--load-order") result.loadOrder = value;
    else if (key === "--language") result.language = value;
    else usage();
  }
  return result;
}

function run(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { stdio: "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
if (!args.base || !args.changeSet || !args.output) usage();
if (!args.pluginMap || !args.loadOrder) {
  throw new Error("--plugin-map and --load-order are required to prove the winning AVIF before writing.");
}

const basePath = path.resolve(args.base);
const changeSetPath = path.resolve(args.changeSet);
const outputPath = path.resolve(args.output);
const verificationOutput = path.resolve(args.verificationOutput ?? `${outputPath}.verification`);
const reportPath = `${outputPath}.writer-report.json`;
const winnerProofPath = path.join(verificationOutput, "winner-proof.json");
const baselineOutput = path.join(verificationOutput, "base");
const patchOutput = path.join(verificationOutput, "patch");
const reparseProofPath = path.join(verificationOutput, "change-set-reparse-verification.json");
for (const requiredPath of [basePath, changeSetPath]) {
  if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
    throw new Error(`Required input is not a file: ${requiredPath}`);
  }
}
if (fs.existsSync(outputPath)) throw new Error(`Output already exists: ${outputPath}`);
if (fs.existsSync(verificationOutput)) throw new Error(`Verification output already exists: ${verificationOutput}`);
if (fs.existsSync(reportPath)) throw new Error(`Writer report already exists: ${reportPath}`);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectPath = path.resolve(scriptDirectory, "../writer/SkyrimPerkTreeWriter/SkyrimPerkTreeWriter.csproj");
const readonlyWorkflow = path.join(scriptDirectory, "run-readonly-workflow.mjs");
const winnerVerifier = path.join(scriptDirectory, "verify-avif-winner.mjs");
const reparseVerifier = path.join(scriptDirectory, "verify-change-set-reparse.mjs");
const baseHashBefore = sha256(basePath);
const changeSet = JSON.parse(fs.readFileSync(changeSetPath, "utf8"));
if (changeSet.baseSha256 !== baseHashBefore) {
  throw new Error(`Change-set base SHA-256 does not match --base: ${changeSet.baseSha256} != ${baseHashBefore}`);
}
if (String(changeSet.basePlugin).toLowerCase() !== path.basename(basePath).toLowerCase()) {
  throw new Error(`Change-set basePlugin ${changeSet.basePlugin} does not name --base ${path.basename(basePath)}`);
}

const profileArguments = [];
for (const root of args.masterRoots) profileArguments.push("--master-root", path.resolve(root));
profileArguments.push("--plugin-map", path.resolve(args.pluginMap), "--load-order", path.resolve(args.loadOrder));

run(process.execPath, [
  winnerVerifier,
  "--base", basePath,
  "--target-avif", changeSet.targetAvif,
  "--expected-winner", changeSet.expectedWinnerPlugin,
  "--plugin-map", path.resolve(args.pluginMap),
  "--load-order", path.resolve(args.loadOrder),
  "--output", winnerProofPath,
  ...args.masterRoots.flatMap((root) => ["--master-root", path.resolve(root)])
]);

const baselineArguments = [readonlyWorkflow, "--input", basePath, "--output", baselineOutput, "--expected-sha256", baseHashBefore, ...profileArguments];
if (args.language) baselineArguments.push("--language", args.language);
run(process.execPath, baselineArguments);

run(args.dotnet ?? "dotnet", [
  "run",
  "--project",
  projectPath,
  "--configuration",
  "Release",
  "--",
  "--base",
  basePath,
  "--change-set",
  changeSetPath,
  "--output",
  outputPath,
  "--game-release",
  args.gameRelease ?? "SkyrimSE",
  "--report",
  reportPath
]);

const baseHashAfter = sha256(basePath);
if (baseHashAfter !== baseHashBefore) {
  throw new Error(`Base plugin changed during write workflow: ${baseHashBefore} -> ${baseHashAfter}`);
}
const writerReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
if (sha256(outputPath) !== writerReport.outputSha256) throw new Error("Output hash does not match writer report.");

const verificationArgs = [
  readonlyWorkflow,
  "--input",
  outputPath,
  "--output",
  patchOutput,
  "--expected-sha256",
  writerReport.outputSha256
];
for (const root of args.masterRoots) verificationArgs.push("--master-root", path.resolve(root));
if (args.pluginMap) verificationArgs.push("--plugin-map", path.resolve(args.pluginMap));
if (args.loadOrder) verificationArgs.push("--load-order", path.resolve(args.loadOrder));
if (args.language) verificationArgs.push("--language", args.language);
run(process.execPath, verificationArgs);
run(process.execPath, [
  reparseVerifier,
  "--base-nodes", path.join(baselineOutput, "perk-tree-nodes.json"),
  "--output-nodes", path.join(patchOutput, "perk-tree-nodes.json"),
  "--change-set", changeSetPath,
  "--output", reparseProofPath
]);

console.log(JSON.stringify({
  status: "ok",
  writer: writerReport.writer,
  writerVersion: writerReport.writerVersion,
  baseSha256: baseHashAfter,
  output: outputPath,
  outputSha256: writerReport.outputSha256,
  report: reportPath,
  winnerProof: winnerProofPath,
  verification: verificationOutput,
  reparseProof: reparseProofPath
}, null, 2));
