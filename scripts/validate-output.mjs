#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node validate-output.mjs --manifest <manifest.json> [--expected-sha256 <sha256>]");
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) {
      usage();
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function fail(message) {
  console.error(`Validation failed: ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.manifest) {
  usage();
}

const manifestPath = path.resolve(args.manifest);
if (!fs.existsSync(manifestPath)) {
  fail(`manifest does not exist: ${manifestPath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!/^[0-9a-f]{64}$/.test(manifest.sourceSha256 ?? "")) {
  fail("sourceSha256 is missing or malformed");
}
if (args["expected-sha256"] && manifest.sourceSha256 !== args["expected-sha256"].toLowerCase()) {
  fail(`source SHA-256 mismatch: expected ${args["expected-sha256"]}, got ${manifest.sourceSha256}`);
}
if (!Array.isArray(manifest.trees) || manifest.trees.length === 0) {
  fail("no AVIF perk trees were found");
}
if (!manifest.overview || !fs.existsSync(manifest.overview)) {
  fail(`overview SVG does not exist: ${manifest.overview ?? "(missing path)"}`);
}
if (!manifest.nodes || !fs.existsSync(manifest.nodes)) {
  fail(`node export does not exist: ${manifest.nodes ?? "(missing path)"}`);
}
if (!manifest.details || !fs.existsSync(manifest.details)) {
  fail(`perk detail export does not exist: ${manifest.details ?? "(missing path)"}`);
}
if (!manifest.annotatedOverview || !fs.existsSync(manifest.annotatedOverview)) {
  fail(`name/level overview SVG does not exist: ${manifest.annotatedOverview ?? "(missing path)"}`);
}
if (!manifest.annotationManifest || !fs.existsSync(manifest.annotationManifest)) {
  fail(`SVG annotation manifest does not exist: ${manifest.annotationManifest ?? "(missing path)"}`);
}

let visibleNodes = 0;
let allConnections = 0;
let visibleConnections = 0;
const failures = [];

for (const tree of manifest.trees) {
  visibleNodes += tree.visibleNodes ?? 0;
  allConnections += tree.allConnections ?? 0;
  visibleConnections += tree.visibleConnections ?? 0;
  if (!tree.svg || !fs.existsSync(tree.svg)) {
    failures.push(`${tree.editorId}: SVG does not exist`);
  }
  if (!/^.+\|[0-9A-Fa-f]{8}$/.test(tree.formKey ?? "") || tree.unresolvedFormIdSlot) {
    failures.push(`${tree.editorId}: stable AVIF FormKey is missing or unresolved (${tree.formKey ?? "null"})`);
  }
  const validation = tree.validation ?? {};
  if (validation.rootCount !== 1) {
    failures.push(`${tree.editorId}: rootCount=${validation.rootCount}`);
  }
  for (const key of ["duplicateIndices", "danglingConnections", "selfConnections", "unreachableIndices"]) {
    if (!Array.isArray(validation[key]) || validation[key].length > 0) {
      failures.push(`${tree.editorId}: ${key}=${JSON.stringify(validation[key])}`);
    }
  }
  if (validation.hasCycle !== false) {
    failures.push(`${tree.editorId}: hasCycle=${validation.hasCycle}`);
  }
}

if (failures.length > 0) {
  fail(failures.join("; "));
}

const nodeExport = JSON.parse(fs.readFileSync(manifest.nodes, "utf8"));
const detailExport = JSON.parse(fs.readFileSync(manifest.details, "utf8"));
const annotationExport = JSON.parse(fs.readFileSync(manifest.annotationManifest, "utf8"));
if (nodeExport.schemaVersion !== 2 || detailExport.schemaVersion !== 2) {
  fail(`schema version mismatch: nodes=${nodeExport.schemaVersion}, details=${detailExport.schemaVersion}; expected 2`);
}
const exportedVisibleNodes = nodeExport.trees
  .flatMap((tree) => tree.nodes)
  .filter((node) => !node.invisibleRoot);
const detailedVisibleNodes = detailExport.trees
  .flatMap((tree) => tree.nodes)
  .filter((node) => !node.invisibleRoot);

if (nodeExport.sourceSha256 !== manifest.sourceSha256) {
  fail("node export sourceSha256 does not match manifest");
}
if (detailExport.sourceSha256 !== manifest.sourceSha256) {
  fail("detail export sourceSha256 does not match manifest");
}
if (exportedVisibleNodes.length !== visibleNodes) {
  fail(`node export count mismatch: expected ${visibleNodes}, got ${exportedVisibleNodes.length}`);
}
if (detailedVisibleNodes.length !== visibleNodes) {
  fail(`detail export count mismatch: expected ${visibleNodes}, got ${detailedVisibleNodes.length}`);
}
if (detailedVisibleNodes.some((node) => !node.perkResolution?.status)) {
  fail("one or more visible nodes have no perkResolution status");
}
if (annotationExport.sourceSha256 !== manifest.sourceSha256) {
  fail("SVG annotation sourceSha256 does not match manifest");
}
if (annotationExport.perkDataLevelUsed !== false) {
  fail("SVG annotations must not use PERK.DATA.level as the skill requirement");
}
if (annotationExport.visibleNodes !== visibleNodes || annotationExport.annotatedLegendRows !== visibleNodes || annotationExport.annotatedNodeTitles !== visibleNodes) {
  fail(`SVG annotation count mismatch: visible=${annotationExport.visibleNodes}, legend=${annotationExport.annotatedLegendRows}, titles=${annotationExport.annotatedNodeTitles}, expected=${visibleNodes}`);
}
if (!Array.isArray(annotationExport.trees) || annotationExport.trees.length !== manifest.trees.length) {
  fail(`SVG annotation tree count mismatch: expected ${manifest.trees.length}, got ${annotationExport.trees?.length ?? "null"}`);
}
for (const tree of annotationExport.trees) {
  if (!tree.output || !fs.existsSync(tree.output)) {
    fail(`${tree.editorId}: annotated SVG does not exist`);
  }
  if (tree.visibleNodes !== tree.annotatedLegendRows || tree.visibleNodes !== tree.annotatedNodeTitles) {
    fail(`${tree.editorId}: incomplete name/level annotation coverage`);
  }
}

const summary = {
  manifest: manifestPath,
  source: manifest.source,
  sourceSha256: manifest.sourceSha256,
  trees: manifest.trees.length,
  visibleNodes,
  allConnections,
  visibleConnections,
  structuralErrors: 0,
  perkResolutionMode: detailExport.resolution?.mode ?? null,
  frozenContextSha256: detailExport.resolution?.frozenContextSha256 ?? null,
  sourceAvifWinnerVerified: detailExport.resolution?.winningOverrideVerified ?? false,
  resolvedPerks: detailExport.summary?.resolvedPerks ?? 0,
  unresolvedPerks: detailExport.summary?.unresolvedPerks ?? visibleNodes,
  namedPerks: detailExport.summary?.namedPerks ?? 0,
  describedPerks: detailExport.summary?.describedPerks ?? 0,
  acquisitionConditions: detailExport.summary?.acquisitionConditions ?? 0,
  effectConditions: detailExport.summary?.effectConditions ?? 0,
  mappedConditions: detailExport.summary?.mappedConditions ?? 0,
  unmappedConditions: detailExport.summary?.unmappedConditions ?? 0,
  effects: detailExport.summary?.effects ?? 0,
  winningOverridesVerified: detailExport.summary?.winningOverridesVerified ?? 0,
  avifWinnersVerified: detailExport.summary?.avifWinnersVerified ?? 0,
  referencedRecords: detailExport.summary?.referencedRecords ?? 0,
  resolvedReferencedRecords: detailExport.summary?.resolvedReferencedRecords ?? 0,
  unresolvedReferencedRecords: detailExport.summary?.unresolvedReferencedRecords ?? 0,
  annotatedLegendRows: annotationExport.annotatedLegendRows ?? 0,
  explicitSkillThresholds: annotationExport.explicitSkillThresholds ?? 0,
  noExplicitSkillThresholds: annotationExport.noExplicitSkillThresholds ?? 0,
  unresolvedSkillThresholds: annotationExport.unresolvedSkillThresholds ?? 0
};

console.log(JSON.stringify(summary, null, 2));
