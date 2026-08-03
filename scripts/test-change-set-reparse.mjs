#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skyrim-reparse-test-"));
const baseSha256 = "a".repeat(64);
const tree = {
  editorId: "AVOneHanded",
  formKey: "Skyrim.esm|0000044C",
  nodes: [
    { index: 0, perkFormKey: "NULL", parentRequired: true, associatedSkill: 1100, gridX: 0, gridY: 0, horizontalOffset: 0, verticalOffset: 0, connections: [1] },
    { index: 1, perkFormKey: "Base.esp|00000001", parentRequired: true, associatedSkill: 1100, gridX: 1, gridY: 1, horizontalOffset: 0, verticalOffset: 0, connections: [2] },
    { index: 2, perkFormKey: "Base.esp|00000002", parentRequired: true, associatedSkill: 1100, gridX: 2, gridY: 2, horizontalOffset: 0, verticalOffset: 0, connections: [] },
    { index: 3, perkFormKey: "Base.esp|00000003", parentRequired: true, associatedSkill: 1100, gridX: 3, gridY: 3, horizontalOffset: 0, verticalOffset: 0, connections: [] }
  ]
};
const changeSet = {
  version: 2,
  basePlugin: "Base.esp",
  baseSha256,
  expectedWinnerPlugin: "Base.esp",
  targetAvif: tree.formKey,
  outputPlugin: "Patch.esp",
  operations: [
    { op: "moveNode", nodeIndex: 1, xnam: 5, ynam: 6, hnam: 0.25, vnam: -0.5 },
    { op: "updateParentRequired", nodeIndex: 3, required: false },
    { op: "disconnect", fromIndex: 1, toIndex: 2 },
    { op: "connect", fromIndex: 1, toIndex: 3 },
    { op: "removeNode", nodeIndex: 2 },
    { op: "addNode", nodeIndex: 4, perkFormKey: "Base.esp|00000004", required: true, xnam: 7, ynam: 8, hnam: 0.5, vnam: 0.75 },
    { op: "connect", fromIndex: 3, toIndex: 4 }
  ]
};
const outputTree = structuredClone(tree);
outputTree.nodes = outputTree.nodes.filter((node) => node.index !== 2);
const one = outputTree.nodes.find((node) => node.index === 1);
one.gridX = 5; one.gridY = 6; one.horizontalOffset = 0.25; one.verticalOffset = -0.5; one.connections = [3];
outputTree.nodes.find((node) => node.index === 3).parentRequired = false;
outputTree.nodes.find((node) => node.index === 3).connections = [4];
outputTree.nodes.push({ index: 4, perkFormKey: "Base.esp|00000004", parentRequired: true, associatedSkill: 1100, gridX: 7, gridY: 8, horizontalOffset: 0.5, verticalOffset: 0.75, connections: [] });

const basePath = path.join(directory, "base.json");
const outputPath = path.join(directory, "output.json");
const changeSetPath = path.join(directory, "change-set.json");
const reportPath = path.join(directory, "report.json");
const verifier = path.join(root, "scripts", "verify-change-set-reparse.mjs");
try {
  fs.writeFileSync(basePath, `${JSON.stringify({ sourceSha256: baseSha256, trees: [tree] })}\n`);
  fs.writeFileSync(outputPath, `${JSON.stringify({ sourceSha256: "b".repeat(64), trees: [outputTree] })}\n`);
  fs.writeFileSync(changeSetPath, `${JSON.stringify(changeSet)}\n`);
  const accepted = spawnSync(process.execPath, [verifier, "--base-nodes", basePath, "--output-nodes", outputPath, "--change-set", changeSetPath, "--output", reportPath], { encoding: "utf8" });
  if (accepted.status !== 0) throw new Error(accepted.stderr || accepted.stdout);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.operationsVerified !== changeSet.operations.length || report.nodesVerified !== 4) throw new Error("verification report counts are wrong");
  outputTree.nodes.find((node) => node.index === 4).gridX = 99;
  fs.writeFileSync(outputPath, `${JSON.stringify({ sourceSha256: "b".repeat(64), trees: [outputTree] })}\n`);
  const rejected = spawnSync(process.execPath, [verifier, "--base-nodes", basePath, "--output-nodes", outputPath, "--change-set", changeSetPath, "--output", path.join(directory, "negative-report.json")], { encoding: "utf8" });
  if (rejected.status === 0) throw new Error("field mismatch was accepted");
  console.log(JSON.stringify({ status: "ok", operations: report.operationsVerified, nodes: report.nodesVerified }, null, 2));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
