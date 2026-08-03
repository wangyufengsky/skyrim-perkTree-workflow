#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(root, "scripts", "render-perk-tree-labels.mjs");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "skyrim-perk-label-test-"));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1200" viewBox="0 0 1920 1200">
<text x="1215" y="132" class="legend-heading">节点索引 · PERK · 来源 · 逻辑坐标</text>
<g class="tree-node"><title>单手 / AVOneHanded\nINAM 1\nTest1</title><circle/></g>
<g class="tree-node"><title>单手 / AVOneHanded\nINAM 2\nTest2</title><circle/></g>
<g class="tree-node"><title>单手 / AVOneHanded\nINAM 5000\nTest3</title><circle/></g>
<text x="1237" y="154" class="legend-text">01 · Test1</text>
<text x="1237" y="175" class="legend-text">02 · Test2</text>
<text x="1237" y="196" class="legend-text">5000 · Test3</text>
<text x="1215" y="1174" class="legend-muted">old footer</text>
</svg>\n`;
const condition = {
  operator: "GreaterOrEqual",
  comparison: { asFloat: 30, useGlobalCandidate: null },
  function: { name: "GetBaseActorValue" },
  parameters: [{ rawUInt32: 6 }],
};
const details = {
  schemaVersion: 2,
  source: "/tmp/Test.esp",
  sourceSha256: "a".repeat(64),
  resolution: { mode: "explicit-load-order-incomplete", winningOverrideVerified: false },
  trees: [{
    editorId: "AVOneHanded",
    displayName: "单手",
    formKey: "Skyrim.esm|0000044C",
    nodes: [
      { index: 0, invisibleRoot: true },
      { index: 1, invisibleRoot: false, perkEditorId: "Test1", perkResolution: { status: "best-known-record-from-incomplete-load-order", perk: { name: { value: "刀与<火>" }, data: { level: 99, numRanks: 1 }, acquisitionConditions: [condition] } } },
      { index: 2, invisibleRoot: false, perkEditorId: "Test2", perkResolution: { status: "best-known-record-from-incomplete-load-order", perk: { name: { value: "无门槛" }, data: { level: 99, numRanks: 5 }, acquisitionConditions: [] } } },
      { index: 5000, invisibleRoot: false, perkEditorId: "未解析节点", perkResolution: { status: "unresolved" } },
    ],
  }],
};

try {
  fs.writeFileSync(path.join(output, "avonehanded.svg"), svg, "utf8");
  const detailsPath = path.join(output, "perk-tree-details.json");
  fs.writeFileSync(detailsPath, `${JSON.stringify(details, null, 2)}\n`, "utf8");
  const result = spawnSync(process.execPath, [renderer, "--details", detailsPath, "--svg-directory", output], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const rendered = fs.readFileSync(path.join(output, "avonehanded.svg"), "utf8");
  const assertions = [
    "01 · 刀与&lt;火&gt; · Lv30+ · 1阶",
    "02 · 无门槛 · Lv— · 5阶",
    "5000 · 未解析节点 · Lv? · ?阶",
    "不使用 PERK.DATA.level",
  ];
  for (const expected of assertions) {
    if (!rendered.includes(expected)) throw new Error(`missing rendered text: ${expected}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "perk-tree-svg-annotations.json"), "utf8"));
  if (manifest.visibleNodes !== 3 || manifest.annotatedLegendRows !== 3 || manifest.annotatedNodeTitles !== 3) throw new Error("annotation coverage mismatch");
  if (manifest.explicitSkillThresholds !== 1 || manifest.noExplicitSkillThresholds !== 1 || manifest.unresolvedSkillThresholds !== 1) throw new Error("level status counts mismatch");
  if (manifest.perkDataLevelUsed !== false) throw new Error("PERK.DATA.level was not explicitly excluded");
  const overview = fs.readFileSync(path.join(output, "skill-trees-overview-names-levels.svg"), "utf8");
  if (!overview.includes("data:image/svg+xml;base64,")) throw new Error("combined overview is not standalone");
  console.log(JSON.stringify({ status: "ok", visibleNodes: manifest.visibleNodes }, null, 2));
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
