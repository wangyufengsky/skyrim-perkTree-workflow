#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

const args = parseArgs(process.argv.slice(2));
if (!args.analysis || !args.decision) usage();
const analysis = JSON.parse(fs.readFileSync(args.analysis, "utf8"));
const decision = JSON.parse(fs.readFileSync(args.decision, "utf8"));
if (decision.version !== 1 || decision.approved !== true) fail("version=1 and approved=true are required");
if (!/^[0-9a-f]{64}$/.test(decision.analysisSha256 ?? "")) fail("analysisSha256 must be lowercase SHA-256");
if (decision.analysisSha256 !== analysis.analysisSha256) fail("analysisSha256 does not match this analysis artifact");
if (!Array.isArray(decision.decisions) || decision.decisions.length === 0) fail("at least one decision is required");
const expected = new Set((analysis.trees ?? []).flatMap((tree) => (tree.items ?? []).map((item) => `${tree.editorId}|${item.incoming.treeIndex}`)));
const seen = new Set();
for (const item of decision.decisions) {
  const key = `${item.treeEditorId}|${item.incomingIndex}`;
  if (!expected.has(key)) fail(`decision refers to unknown incoming node ${key}`);
  if (seen.has(key)) fail(`duplicate decision for ${key}`);
  seen.add(key);
  if (!["keep-base", "import", "exclude", "manual"].includes(item.action)) fail(`unsupported action for ${key}`);
}
const omitted = [...expected].filter((key) => !seen.has(key));
if (omitted.length) fail(`missing decisions for ${omitted.join(", ")}`);
const manual = decision.decisions.filter((item) => item.action === "manual");
if (manual.length) fail(`manual decisions remain: ${manual.map((item) => `${item.treeEditorId}|${item.incomingIndex}`).join(", ")}`);
const imports = decision.decisions.filter((item) => item.action === "import");
console.log(JSON.stringify({ status: "approved-for-change-set-generation", analysis: args.analysis, decision: args.decision, decisionFileSha256: sha256(fs.readFileSync(args.decision)), decisions: decision.decisions.length, imports: imports.length }, null, 2));
