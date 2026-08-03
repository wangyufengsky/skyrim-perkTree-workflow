#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { canonicalSha256, sha256 } from "./lib/canonical-json.mjs";

function usage() {
  console.error("Usage: node validate-merge-decision.mjs --analysis <perk-tree-merge-analysis.json> --decision <merge-decision.json>");
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (key === "--analysis") result.analysis = path.resolve(value);
    else if (key === "--decision") result.decision = path.resolve(value);
    else usage();
  }
  return result;
}

function fail(message) { throw new Error(`Merge decision rejected: ${message}`); }

const args = parseArgs(process.argv.slice(2));
if (!args.analysis || !args.decision) usage();
const analysis = JSON.parse(fs.readFileSync(args.analysis, "utf8"));
const decision = JSON.parse(fs.readFileSync(args.decision, "utf8"));
if (decision.version !== 2 || decision.approved !== true) fail("version=2 and approved=true are required");
if (!/^[0-9a-f]{64}$/.test(decision.analysisSha256 ?? "")) fail("analysisSha256 must be lowercase SHA-256");
const recomputedAnalysisSha256 = canonicalSha256({ ...analysis, analysisSha256: undefined, generatedAt: null });
if (analysis.analysisSha256 !== recomputedAnalysisSha256) fail("analysis artifact content does not match its embedded analysisSha256");
if (decision.analysisSha256 !== analysis.analysisSha256) fail("analysisSha256 does not match this analysis artifact");
if (!Array.isArray(decision.decisions) || decision.decisions.length === 0) fail("at least one decision is required");
const expected = new Map();
for (const tree of analysis.trees ?? []) {
  for (const item of tree.items ?? []) {
    const key = `${tree.formKey.toLowerCase()}|${item.incoming.treeIndex}`;
    if (expected.has(key)) fail(`analysis contains duplicate incoming node key ${key}`);
    expected.set(key, item);
  }
}
const seen = new Set();
for (const item of decision.decisions) {
  const key = `${String(item.treeFormKey).toLowerCase()}|${item.incomingIndex}`;
  if (!expected.has(key)) fail(`decision refers to unknown incoming node ${key}`);
  if (seen.has(key)) fail(`duplicate decision for ${key}`);
  seen.add(key);
  if (!["keep-base", "import", "exclude", "manual"].includes(item.action)) fail(`unsupported action for ${key}`);
  const status = expected.get(key).status;
  if (item.action === "import" && ["exact-duplicate", "semantic-conflict", "unresolved-source", "unresolved-base", "target-tree-unmatched"].includes(status)) {
    fail(`import is forbidden for ${status} item ${key}`);
  }
  if (status === "target-tree-unmatched" && item.action !== "exclude" && item.action !== "manual") {
    fail(`target-tree-unmatched item ${key} must remain manual or be excluded`);
  }
}
const omitted = [...expected.keys()].filter((key) => !seen.has(key));
if (omitted.length) fail(`missing decisions for ${omitted.join(", ")}`);
const manual = decision.decisions.filter((item) => item.action === "manual");
if (manual.length) fail(`manual decisions remain: ${manual.map((item) => `${item.treeFormKey}|${item.incomingIndex}`).join(", ")}`);
const imports = decision.decisions.filter((item) => item.action === "import");
console.log(JSON.stringify({ status: "approved-for-change-set-generation", analysis: args.analysis, decision: args.decision, decisionFileSha256: sha256(fs.readFileSync(args.decision)), decisions: decision.decisions.length, imports: imports.length }, null, 2));
