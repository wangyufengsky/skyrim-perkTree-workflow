#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./lib/canonical-json.mjs";

function usage() {
  console.error([
    "Usage: node verify-change-set-reparse.mjs",
    "  --base-nodes <base/perk-tree-nodes.json>",
    "  --output-nodes <patch/perk-tree-nodes.json>",
    "  --change-set <change-set.json>",
    "  --output <verification-report.json>"
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (["--base-nodes", "--output-nodes", "--change-set", "--output"].includes(key)) result[key.slice(2)] = path.resolve(value);
    else usage();
  }
  return result;
}

function fail(message) { throw new Error(`Independent change-set verification failed: ${message}`); }
function normalizedFormKey(value) { return String(value).toLowerCase(); }

function treeByFormKey(exportData, target, label) {
  const matches = (exportData.trees ?? []).filter((tree) => normalizedFormKey(tree.formKey) === normalizedFormKey(target));
  if (matches.length !== 1) fail(`${label} contains ${matches.length} trees for ${target}`);
  return matches[0];
}

function nodeMap(tree) {
  const result = new Map();
  for (const node of tree.nodes ?? []) {
    if (!Number.isInteger(node.index)) fail(`tree ${tree.formKey} has a node without integer INAM`);
    if (result.has(node.index)) fail(`tree ${tree.formKey} has duplicate INAM ${node.index}`);
    result.set(node.index, {
      index: node.index,
      perkFormKey: node.perkFormKey,
      parentRequired: node.parentRequired,
      associatedSkill: node.associatedSkill,
      gridX: node.gridX,
      gridY: node.gridY,
      horizontalOffset: node.horizontalOffset,
      verticalOffset: node.verticalOffset,
      connections: [...(node.connections ?? [])]
    });
  }
  return result;
}

function requireNode(nodes, index, operation) {
  const node = nodes.get(index);
  if (!node) fail(`${operation} references missing INAM ${index} in baseline model`);
  return node;
}

function applyChangeSet(baseTree, changeSet) {
  const nodes = nodeMap(baseTree);
  const root = requireNode(nodes, 0, "baseline");
  for (const operation of changeSet.operations ?? []) {
    switch (operation.op) {
      case "moveNode": {
        const node = requireNode(nodes, operation.nodeIndex, operation.op);
        node.gridX = operation.xnam; node.gridY = operation.ynam;
        node.horizontalOffset = Math.fround(operation.hnam); node.verticalOffset = Math.fround(operation.vnam);
        break;
      }
      case "connect": {
        const from = requireNode(nodes, operation.fromIndex, operation.op);
        requireNode(nodes, operation.toIndex, operation.op);
        if (from.connections.includes(operation.toIndex)) fail(`connect ${operation.fromIndex}->${operation.toIndex} already exists in baseline model`);
        from.connections.push(operation.toIndex);
        break;
      }
      case "disconnect": {
        const from = requireNode(nodes, operation.fromIndex, operation.op);
        const position = from.connections.indexOf(operation.toIndex);
        if (position < 0) fail(`disconnect ${operation.fromIndex}->${operation.toIndex} is absent in baseline model`);
        from.connections.splice(position, 1);
        break;
      }
      case "updateParentRequired":
        requireNode(nodes, operation.nodeIndex, operation.op).parentRequired = operation.required;
        break;
      case "removeNode":
        if (operation.nodeIndex === 0) fail("cannot remove invisible root");
        requireNode(nodes, operation.nodeIndex, operation.op);
        nodes.delete(operation.nodeIndex);
        for (const node of nodes.values()) node.connections = node.connections.filter((target) => target !== operation.nodeIndex);
        break;
      case "addNode":
        if (nodes.has(operation.nodeIndex)) fail(`addNode INAM ${operation.nodeIndex} already exists in baseline model`);
        nodes.set(operation.nodeIndex, {
          index: operation.nodeIndex,
          perkFormKey: operation.perkFormKey,
          parentRequired: operation.required,
          associatedSkill: root.associatedSkill,
          gridX: operation.xnam,
          gridY: operation.ynam,
          horizontalOffset: Math.fround(operation.hnam),
          verticalOffset: Math.fround(operation.vnam),
          connections: []
        });
        break;
      default:
        fail(`unsupported operation ${operation.op}`);
    }
  }
  return nodes;
}

function compareNodes(expected, actual) {
  const differences = [];
  const fields = ["perkFormKey", "parentRequired", "associatedSkill", "gridX", "gridY", "horizontalOffset", "verticalOffset"];
  for (const index of new Set([...expected.keys(), ...actual.keys()])) {
    const left = expected.get(index); const right = actual.get(index);
    if (!left) { differences.push(`unexpected INAM ${index}`); continue; }
    if (!right) { differences.push(`missing INAM ${index}`); continue; }
    for (const field of fields) {
      const leftValue = field === "perkFormKey" ? normalizedFormKey(left[field]) : left[field];
      const rightValue = field === "perkFormKey" ? normalizedFormKey(right[field]) : right[field];
      if (!Object.is(leftValue, rightValue)) differences.push(`INAM ${index} ${field}: expected ${JSON.stringify(left[field])}, actual ${JSON.stringify(right[field])}`);
    }
    if (JSON.stringify(left.connections) !== JSON.stringify(right.connections)) differences.push(`INAM ${index} connections: expected ${JSON.stringify(left.connections)}, actual ${JSON.stringify(right.connections)}`);
  }
  return differences;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["base-nodes", "output-nodes", "change-set", "output"]) if (!args[key]) usage();
for (const key of ["base-nodes", "output-nodes", "change-set"]) if (!fs.existsSync(args[key])) fail(`input missing: ${args[key]}`);
if (fs.existsSync(args.output)) fail(`report output already exists: ${args.output}`);
const base = JSON.parse(fs.readFileSync(args["base-nodes"], "utf8"));
const output = JSON.parse(fs.readFileSync(args["output-nodes"], "utf8"));
const changeSetBytes = fs.readFileSync(args["change-set"]);
const changeSet = JSON.parse(changeSetBytes);
if (base.sourceSha256 !== changeSet.baseSha256) fail(`baseline SHA ${base.sourceSha256} does not equal change-set base SHA ${changeSet.baseSha256}`);
if ((output.trees ?? []).length !== 1) fail(`patch reparse must contain exactly one AVIF tree, found ${(output.trees ?? []).length}`);
const baseTree = treeByFormKey(base, changeSet.targetAvif, "baseline");
const outputTree = treeByFormKey(output, changeSet.targetAvif, "patch");
const expected = applyChangeSet(baseTree, changeSet);
const actual = nodeMap(outputTree);
const differences = compareNodes(expected, actual);
if (differences.length) fail(differences.slice(0, 20).join("; "));
const report = {
  schemaVersion: 1,
  status: "verified",
  targetAvif: changeSet.targetAvif,
  baseSourceSha256: base.sourceSha256,
  patchSourceSha256: output.sourceSha256,
  changeSetSha256: sha256(changeSetBytes),
  operationsVerified: changeSet.operations.length,
  nodesVerified: actual.size,
  connectionsVerified: [...actual.values()].reduce((sum, node) => sum + node.connections.length, 0),
  comparedFields: ["PERK", "FNAM", "XNAM", "YNAM", "HNAM", "VNAM", "SNAM", "CNAM"]
};
fs.mkdirSync(path.dirname(args.output), { recursive: true });
fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, report: args.output }, null, 2));
