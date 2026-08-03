#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { canonicalSha256 } from "./lib/canonical-json.mjs";

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
  const decision = { version: 2, analysisSha256: analysis.analysisSha256, approved: true, decisions: [
    { treeFormKey: "Skyrim.esm|0000044C", treeEditorId: "AVOneHanded", incomingIndex: 1, action: "keep-base" },
    { treeFormKey: "Skyrim.esm|0000044C", treeEditorId: "AVOneHanded", incomingIndex: 2, action: "import" },
    { treeFormKey: "Skyrim.esm|0000044C", treeEditorId: "AVOneHanded", incomingIndex: 3, action: "exclude" }
  ] };
  const decisionPath = path.join(output, "merge-decision.json");
  fs.writeFileSync(decisionPath, `${JSON.stringify(decision)}\n`);
  run(validator, ["--analysis", analysisPath, "--decision", decisionPath]);
  analysis.summary.matchedTrees = 999;
  fs.writeFileSync(analysisPath, `${JSON.stringify(analysis)}\n`);
  const tampered = spawnSync(process.execPath, [validator, "--analysis", analysisPath, "--decision", decisionPath], { encoding: "utf8" });
  if (tampered.status === 0) throw new Error("tampered analysis content was accepted");
  analysis.summary.matchedTrees = 1;
  fs.writeFileSync(analysisPath, `${JSON.stringify(analysis)}\n`);
  decision.decisions[0].action = "import";
  fs.writeFileSync(decisionPath, `${JSON.stringify(decision)}\n`);
  const forbiddenImport = spawnSync(process.execPath, [validator, "--analysis", analysisPath, "--decision", decisionPath], { encoding: "utf8" });
  if (forbiddenImport.status === 0) throw new Error("exact duplicate import was accepted");
  decision.decisions[0].action = "keep-base";
  for (const forbiddenStatus of ["semantic-conflict", "unresolved-source", "unresolved-base", "target-tree-unmatched"]) {
    const statusAnalysis = structuredClone(analysis);
    statusAnalysis.trees[0].items[0].status = forbiddenStatus;
    statusAnalysis.analysisSha256 = canonicalSha256({ ...statusAnalysis, analysisSha256: undefined, generatedAt: null });
    const statusAnalysisPath = path.join(output, `analysis-${forbiddenStatus}.json`);
    fs.writeFileSync(statusAnalysisPath, `${JSON.stringify(statusAnalysis)}\n`);
    const statusDecision = structuredClone(decision);
    statusDecision.analysisSha256 = statusAnalysis.analysisSha256;
    statusDecision.decisions[0].action = "import";
    const statusDecisionPath = path.join(output, `decision-${forbiddenStatus}.json`);
    fs.writeFileSync(statusDecisionPath, `${JSON.stringify(statusDecision)}\n`);
    const statusRejected = spawnSync(process.execPath, [validator, "--analysis", statusAnalysisPath, "--decision", statusDecisionPath], { encoding: "utf8" });
    if (statusRejected.status === 0) throw new Error(`${forbiddenStatus} import was accepted`);
  }
  decision.analysisSha256 = "0".repeat(64);
  fs.writeFileSync(decisionPath, `${JSON.stringify(decision)}\n`);
  const rejected = spawnSync(process.execPath, [validator, "--analysis", analysisPath, "--decision", decisionPath], { encoding: "utf8" });
  if (rejected.status === 0) throw new Error("mismatched analysis SHA was accepted");
  const mismatchedIncoming = JSON.parse(fs.readFileSync(path.join(fixture, "incoming-details.json"), "utf8"));
  mismatchedIncoming.resolution.frozenContext.language = "German";
  mismatchedIncoming.resolution.language = "German";
  mismatchedIncoming.resolution.frozenContextSha256 = canonicalSha256(mismatchedIncoming.resolution.frozenContext);
  const mismatchedPath = path.join(output, "incoming-mismatched-context.json");
  fs.writeFileSync(mismatchedPath, `${JSON.stringify(mismatchedIncoming)}\n`);
  const mismatchedContext = spawnSync(process.execPath, [analyzer,
    "--base-details", path.join(fixture, "base-details.json"),
    "--incoming-details", mismatchedPath,
    "--output", path.join(output, "mismatched-context-analysis")
  ], { encoding: "utf8" });
  if (mismatchedContext.status === 0) throw new Error("mismatched frozen context was accepted");
  console.log(JSON.stringify({ status: "ok", output }, null, 2));
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
