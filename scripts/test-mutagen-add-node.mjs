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
  fs.writeFileSync(changeSetPath, `${JSON.stringify(changeSet, null, 2)}\n`);
  run(options.dotnet ?? "dotnet", [
    "run", "--no-build", "--configuration", "Release",
    "--project", path.join(root, "writer", "SkyrimPerkTreeWriter", "SkyrimPerkTreeWriter.csproj"), "--",
    "--base", options.base, "--change-set", changeSetPath, "--output", patchPath
  ]);
  const reparse = path.join(output, "reparse");
  run(process.execPath, [path.join(root, "scripts", "run-readonly-workflow.mjs"), "--input", patchPath, "--output", reparse]);
  const nodes = JSON.parse(fs.readFileSync(path.join(reparse, "perk-tree-nodes.json"), "utf8"));
  const tree = nodes.trees.find((item) => item.formId === "0x0000044C");
  const added = tree?.nodes.find((item) => item.index === 5000);
  const rootNode = tree?.nodes.find((item) => item.index === 0);
  if (!added || added.perkFormKey !== changeSet.operations[0].perkFormKey || !rootNode?.connections.includes(5000)) {
    throw new Error("independent Node reparse did not confirm addNode PERK or root connection");
  }
  console.log(JSON.stringify({ status: "ok", addedNode: added.index, perkFormKey: added.perkFormKey, sourceUnchangedSha256: changeSet.baseSha256 }, null, 2));
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
