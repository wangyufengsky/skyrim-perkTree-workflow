#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function usage() {
  console.error("Usage: node test-mutagen-add-node.mjs --base <verified Vokriinator_SCSI_MaoTan_NewTrees.esp> [--dotnet <executable>]");
  process.exit(2);
}

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (key === "--base") result.base = path.resolve(value);
    else if (key === "--dotnet") result.dotnet = value;
    else usage();
  }
  return result;
}

function run(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

const options = args(process.argv.slice(2));
if (!options.base || !fs.existsSync(options.base)) usage();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "skyrim-mutagen-add-node-"));
try {
  const changeSet = {
    version: 2,
    basePlugin: path.basename(options.base),
    baseSha256: crypto.createHash("sha256").update(fs.readFileSync(options.base)).digest("hex"),
    expectedWinnerPlugin: path.basename(options.base),
    targetAvif: "Skyrim.esm|0000044C",
    outputPlugin: "AddNodeSmoke.esp",
    reason: "Isolated addNode writer smoke test; output is deleted after independent reparse.",
    operations: [
      {
        op: "addNode",
        nodeIndex: 5000,
        perkFormKey: "Ordinator - Perks of Skyrim.esp|0000B149",
        required: true,
        xnam: 5,
        ynam: 99,
        hnam: 0,
        vnam: 0
      },
      { op: "connect", fromIndex: 0, toIndex: 5000 }
    ]
  };
  const changeSetPath = path.join(output, "change-set.json");
  const patchPath = path.join(output, changeSet.outputPlugin);
  const pluginMapPath = path.join(output, "plugin-path-map.json");
  const loadOrderPath = path.join(output, "plugins.txt");
  fs.writeFileSync(changeSetPath, `${JSON.stringify(changeSet, null, 2)}\n`);
  fs.writeFileSync(pluginMapPath, `${JSON.stringify({ [path.basename(options.base)]: options.base }, null, 2)}\n`);
  fs.writeFileSync(loadOrderPath, `*${path.basename(options.base)}\n`);
  const workflowArguments = [
    path.join(root, "scripts", "run-mutagen-write-workflow.mjs"),
    "--base", options.base,
    "--change-set", changeSetPath,
    "--output", patchPath,
    "--plugin-map", pluginMapPath,
    "--load-order", loadOrderPath
  ];
  if (options.dotnet) workflowArguments.push("--dotnet", options.dotnet);
  run(process.execPath, workflowArguments);
  const verification = `${patchPath}.verification`;
  const nodes = JSON.parse(fs.readFileSync(path.join(verification, "patch", "perk-tree-nodes.json"), "utf8"));
  const tree = nodes.trees.find((item) => item.formId === "0x0000044C");
  const added = tree?.nodes.find((item) => item.index === 5000);
  const rootNode = tree?.nodes.find((item) => item.index === 0);
  if (!added || added.perkFormKey !== changeSet.operations[0].perkFormKey || !rootNode?.connections.includes(5000)) {
    throw new Error("independent Node reparse did not confirm addNode PERK or root connection");
  }
  for (const proofName of ["winner-proof.json", "change-set-reparse-verification.json"]) {
    const proof = JSON.parse(fs.readFileSync(path.join(verification, proofName), "utf8"));
    if (proof.status !== "verified") throw new Error(`${proofName} did not report verified`);
  }
  fs.writeFileSync(pluginMapPath, `${JSON.stringify({
    [path.basename(options.base)]: options.base,
    [path.basename(patchPath)]: patchPath
  }, null, 2)}\n`);
  fs.writeFileSync(loadOrderPath, `*${path.basename(options.base)}\n*${path.basename(patchPath)}\n`);
  const rejectedWinner = spawnSync(process.execPath, [
    path.join(root, "scripts", "verify-avif-winner.mjs"),
    "--base", options.base,
    "--target-avif", changeSet.targetAvif,
    "--expected-winner", path.basename(options.base),
    "--plugin-map", pluginMapPath,
    "--load-order", loadOrderPath,
    "--output", path.join(output, "negative-winner-proof.json")
  ], { encoding: "utf8" });
  if (rejectedWinner.status === 0) throw new Error("non-winning base plugin was accepted");
  const mismatchedChangeSet = structuredClone(changeSet);
  mismatchedChangeSet.operations[0].xnam += 1;
  const mismatchedChangeSetPath = path.join(output, "mismatched-change-set.json");
  fs.writeFileSync(mismatchedChangeSetPath, `${JSON.stringify(mismatchedChangeSet, null, 2)}\n`);
  const rejectedReparse = spawnSync(process.execPath, [
    path.join(root, "scripts", "verify-change-set-reparse.mjs"),
    "--base-nodes", path.join(verification, "base", "perk-tree-nodes.json"),
    "--output-nodes", path.join(verification, "patch", "perk-tree-nodes.json"),
    "--change-set", mismatchedChangeSetPath,
    "--output", path.join(output, "negative-reparse-proof.json")
  ], { encoding: "utf8" });
  if (rejectedReparse.status === 0) throw new Error("change-set/output mismatch was accepted");
  console.log(JSON.stringify({ status: "ok", addedNode: added.index, perkFormKey: added.perkFormKey, sourceUnchangedSha256: changeSet.baseSha256 }, null, 2));
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
