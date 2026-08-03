#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "test-fixtures", "merge");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "skyrim-perk-merge-test-"));
const analyzer = path.join(root, "scripts", "analyze-perk-tree-merge.mjs");
const validator = path.join(root, "scripts", "validate-merge-decision.mjs");
const run = (script, args) => {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result;
};
try {
  run(analyzer, ["--base-details", path.join(fixture, "base-details.json"), "--incoming-details", path.join(fixture, "incoming-details.json"), "--output", output]);
  const analysisPath = path.join(output, "perk-tree-merge-analysis.json");
  const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  const status = analysis.summary.byStatus;
  if (status["exact-duplicate"] !== 1 || status["unique-import-candidate"] !== 1 || status["semantic-conflict"] !== 1) throw new Error(`unexpected classifications: ${JSON.stringify(status)}`);
  for (const required of ["perk-tree-merge-analysis.svg", "perk-tree-merge-analysis.md"]) if (!fs.existsSync(path.join(output, required))) throw new Error(`missing ${required}`);
  const decision = { version: 1, analysisSha256: analysis.analysisSha256, approved: true, decisions: [
    { treeEditorId: "AVOneHanded", incomingIndex: 1, action: "keep-base" },
    { treeEditorId: "AVOneHanded", incomingIndex: 2, action: "import" },
    { treeEditorId: "AVOneHanded", incomingIndex: 3, action: "exclude" }
  ] };
  const decisionPath = path.join(output, "merge-decision.json");
  fs.writeFileSync(decisionPath, `${JSON.stringify(decision)}\n`);
  run(validator, ["--analysis", analysisPath, "--decision", decisionPath]);
  decision.analysisSha256 = "0".repeat(64);
  fs.writeFileSync(decisionPath, `${JSON.stringify(decision)}\n`);
  const rejected = spawnSync(process.execPath, [validator, "--analysis", analysisPath, "--decision", decisionPath], { encoding: "utf8" });
  if (rejected.status === 0) throw new Error("mismatched analysis SHA was accepted");
  console.log(JSON.stringify({ status: "ok", output }, null, 2));
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
