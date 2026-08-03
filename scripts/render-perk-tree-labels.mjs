#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ACTOR_VALUE_BY_TREE = {
  AVOneHanded: 6,
  AVTwoHanded: 7,
  AVMarksman: 8,
  AVBlock: 9,
  AVSmithing: 10,
  AVHeavyArmor: 11,
  AVLightArmor: 12,
  AVPickpocket: 13,
  AVLockpicking: 14,
  AVSneak: 15,
  AVAlchemy: 16,
  AVSpeechcraft: 17,
  AVAlteration: 18,
  AVConjuration: 19,
  AVDestruction: 20,
  AVMysticism: 21,
  AVRestoration: 22,
  AVEnchanting: 23,
};

function usage() {
  console.error([
    "Usage: node render-perk-tree-labels.mjs",
    "  --details <perk-tree-details.json>",
    "  --svg-directory <directory-containing-per-tree-svg-files>",
    "  [--output <output-directory>]",
  ].join("\n"));
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

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeFileName(editorId) {
  return editorId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function compactName(value, maximumLength = 25) {
  const name = String(value ?? "名称未解析").trim() || "名称未解析";
  return name.length > maximumLength ? `${name.slice(0, maximumLength - 1)}…` : name;
}

function numericText(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatCondition(condition) {
  if (condition.comparison?.useGlobalCandidate) {
    return "Lv?(Global)";
  }
  const value = condition.comparison?.asFloat;
  if (!Number.isFinite(value)) {
    return "Lv?";
  }
  const number = numericText(value);
  const operatorLabels = {
    GreaterOrEqual: `Lv${number}+`,
    GreaterThan: `Lv>${number}`,
    Equal: `Lv=${number}`,
    NotEqual: `Lv≠${number}`,
    LessOrEqual: `Lv≤${number}`,
    LessThan: `Lv<${number}`,
  };
  return operatorLabels[condition.operator] ?? `Lv?(${condition.operator ?? "unknown"} ${number})`;
}

function skillLevelRequirement(tree, node) {
  const perk = node.perkResolution?.perk;
  if (!perk) {
    return { label: "Lv?", status: "perk-unresolved", conditions: [] };
  }
  const actorValue = ACTOR_VALUE_BY_TREE[tree.editorId];
  if (actorValue === undefined) {
    return { label: "Lv?", status: "tree-actor-value-unmapped", conditions: [] };
  }
  const matches = (perk.acquisitionConditions ?? []).filter(
    (condition) =>
      condition.function?.name === "GetBaseActorValue" &&
      condition.parameters?.[0]?.rawUInt32 === actorValue,
  );
  if (matches.length === 0) {
    return {
      label: "Lv—",
      status: "no-explicit-skill-threshold",
      conditions: [],
    };
  }
  const labels = [...new Set(matches.map(formatCondition))];
  return {
    label: labels.join("/"),
    status: labels.some((label) => label.startsWith("Lv?"))
      ? "skill-threshold-partially-unresolved"
      : "ctda-get-base-actor-value",
    conditions: matches.map((condition) => ({
      operator: condition.operator ?? null,
      comparison: condition.comparison ?? null,
      actorValue,
    })),
  };
}

function resolvedLabel(tree, node) {
  const perk = node.perkResolution?.perk;
  const name = perk?.name?.value ?? node.perkEditorId ?? "名称未解析";
  const level = skillLevelRequirement(tree, node);
  const ranks = Number.isInteger(perk?.data?.numRanks) ? perk.data.numRanks : null;
  return {
    name,
    compactName: compactName(name),
    level,
    ranks,
    rankLabel: ranks === null ? "?阶" : `${ranks}阶`,
    perkResolutionStatus: node.perkResolution?.status ?? "unresolved",
  };
}

function annotateTree(tree, inputDirectory, outputDirectory) {
  const fileName = `${safeFileName(tree.editorId)}.svg`;
  const inputPath = path.join(inputDirectory, fileName);
  const outputPath = path.join(outputDirectory, fileName);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Missing per-tree SVG for ${tree.editorId}: ${inputPath}`);
  }
  let svg = fs.readFileSync(inputPath, "utf8");
  if (svg.includes('data-perk-name-levels="1"')) {
    throw new Error(`SVG is already annotated; regenerate the raw SVG first: ${inputPath}`);
  }
  const visibleNodes = tree.nodes.filter((node) => !node.invisibleRoot);
  const labelsByIndex = new Map(visibleNodes.map((node) => [node.index, resolvedLabel(tree, node)]));

  svg = svg.replace("<svg ", '<svg data-perk-name-levels="1" ');
  svg = svg.replace(
    "节点索引 · PERK · 来源 · 逻辑坐标",
    "节点索引 · PERK 名称 · 技能等级 · 阶数 · 来源 · 逻辑坐标",
  );

  let annotatedLegendRows = 0;
  svg = svg.replace(
    /<text x="1237" y="([^"]+)" class="legend-text">(\d+) · [^<]*<\/text>/g,
    (match, y, renderedIndex) => {
      const index = Number(renderedIndex);
      const label = labelsByIndex.get(index);
      if (!label) {
        throw new Error(`${tree.editorId} legend references unknown INAM ${index}`);
      }
      annotatedLegendRows += 1;
      const text = `${renderedIndex} · ${label.compactName} · ${label.level.label} · ${label.rankLabel}`;
      return `<text x="1237" y="${y}" class="legend-text">${escapeXml(text)}</text>`;
    },
  );

  let annotatedNodeTitles = 0;
  svg = svg.replace(
    /<g class="tree-node"><title>([\s\S]*?)<\/title>/g,
    (match, title) => {
      const indexMatch = title.match(/INAM (\d+)/);
      if (!indexMatch) {
        throw new Error(`${tree.editorId} node title lacks INAM`);
      }
      const index = Number(indexMatch[1]);
      const label = labelsByIndex.get(index);
      if (!label) {
        throw new Error(`${tree.editorId} title references unknown INAM ${index}`);
      }
      annotatedNodeTitles += 1;
      const evidence = label.level.status === "no-explicit-skill-threshold"
        ? "技能等级：获取条件中无本技能 GetBaseActorValue 门槛"
        : `技能等级：${label.level.label}（获取条件 CTDA）`;
      return `<g class="tree-node"><title>${title}\n名称：${escapeXml(label.name)}\n${escapeXml(evidence)}\n阶数：${label.rankLabel}</title>`;
    },
  );

  if (annotatedLegendRows !== visibleNodes.length || annotatedNodeTitles !== visibleNodes.length) {
    throw new Error(
      `${tree.editorId} annotation coverage mismatch: legend=${annotatedLegendRows}, titles=${annotatedNodeTitles}, visible=${visibleNodes.length}`,
    );
  }

  svg = svg.replace(
    /<text x="1215" y="1174" class="legend-muted">[^<]*<\/text>/,
    '<text x="1215" y="1158" class="legend-muted">圆形：Parent Required · 菱形：false · Lv—：无显式技能等级门槛 · Lv?：等级未解析</text>\n  <text x="1215" y="1178" class="legend-muted">等级取自 PERK 获取条件 CTDA，不使用 PERK.DATA.level；winner 状态以详情导出为准</text>',
  );

  fs.writeFileSync(outputPath, svg, "utf8");
  const labels = visibleNodes.map((node) => ({ index: node.index, ...labelsByIndex.get(node.index) }));
  return {
    editorId: tree.editorId,
    displayName: tree.displayName,
    formKey: tree.formKey,
    input: inputPath,
    output: outputPath,
    visibleNodes: visibleNodes.length,
    annotatedLegendRows,
    annotatedNodeTitles,
    explicitSkillThresholds: labels.filter((label) => label.level.status === "ctda-get-base-actor-value").length,
    noExplicitSkillThresholds: labels.filter((label) => label.level.status === "no-explicit-skill-threshold").length,
    unresolvedSkillThresholds: labels.filter((label) => !["ctda-get-base-actor-value", "no-explicit-skill-threshold"].includes(label.level.status)).length,
    labels,
    sha256: crypto.createHash("sha256").update(svg).digest("hex"),
    svg,
  };
}

function renderCombinedOverview(trees, sourceName, sourceSha256) {
  const columns = Math.min(2, trees.length);
  const rows = Math.ceil(trees.length / columns);
  const cellWidth = 1920;
  const cellHeight = 1200;
  const width = columns * cellWidth;
  const height = rows * cellHeight;
  const images = trees.map((tree, index) => {
    const x = (index % columns) * cellWidth;
    const y = Math.floor(index / columns) * cellHeight;
    const data = Buffer.from(tree.svg, "utf8").toString("base64");
    return `<image x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" href="data:image/svg+xml;base64,${data}"/>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="overview-title overview-desc">
  <title id="overview-title">${escapeXml(sourceName)} 技能树名称与等级总览</title>
  <desc id="overview-desc">${trees.length} 棵技能树；每个 INAM 在右侧索引中标注 PERK 名称、CTDA 技能等级门槛、阶数、来源和逻辑坐标。源 SHA-256 ${escapeXml(sourceSha256)}。</desc>
  <rect width="${width}" height="${height}" fill="#03070d"/>
  ${images}
</svg>
`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.details || !args["svg-directory"]) {
  usage();
}
const detailsPath = path.resolve(args.details);
const inputDirectory = path.resolve(args["svg-directory"]);
const outputDirectory = path.resolve(args.output ?? args["svg-directory"]);
if (!fs.existsSync(detailsPath) || !fs.statSync(detailsPath).isFile()) {
  throw new Error(`Details file does not exist: ${detailsPath}`);
}
if (!fs.existsSync(inputDirectory) || !fs.statSync(inputDirectory).isDirectory()) {
  throw new Error(`SVG directory does not exist: ${inputDirectory}`);
}

const details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
if (details.schemaVersion !== 2 || !Array.isArray(details.trees) || details.trees.length === 0) {
  throw new Error("Expected schema-version-2 perk-tree-details.json with at least one tree");
}
fs.mkdirSync(outputDirectory, { recursive: true });
const annotatedTrees = details.trees.map((tree) => annotateTree(tree, inputDirectory, outputDirectory));
const combinedSvg = renderCombinedOverview(
  annotatedTrees,
  path.basename(details.source ?? "plugin"),
  details.sourceSha256,
);
const overviewPath = path.join(outputDirectory, "skill-trees-overview-names-levels.svg");
fs.writeFileSync(overviewPath, combinedSvg, "utf8");

const publicTrees = annotatedTrees.map(({ svg, ...tree }) => tree);
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  details: detailsPath,
  source: details.source,
  sourceSha256: details.sourceSha256,
  resolutionMode: details.resolution?.mode ?? null,
  winningOverrideVerified: details.resolution?.winningOverrideVerified ?? false,
  levelDefinition: "Matching-tree GetBaseActorValue acquisition CTDA; Lv— means no explicit matching threshold, Lv? means unresolved.",
  perkDataLevelUsed: false,
  overview: overviewPath,
  visibleNodes: publicTrees.reduce((sum, tree) => sum + tree.visibleNodes, 0),
  annotatedLegendRows: publicTrees.reduce((sum, tree) => sum + tree.annotatedLegendRows, 0),
  annotatedNodeTitles: publicTrees.reduce((sum, tree) => sum + tree.annotatedNodeTitles, 0),
  explicitSkillThresholds: publicTrees.reduce((sum, tree) => sum + tree.explicitSkillThresholds, 0),
  noExplicitSkillThresholds: publicTrees.reduce((sum, tree) => sum + tree.noExplicitSkillThresholds, 0),
  unresolvedSkillThresholds: publicTrees.reduce((sum, tree) => sum + tree.unresolvedSkillThresholds, 0),
  trees: publicTrees,
};
const manifestPath = path.join(outputDirectory, "perk-tree-svg-annotations.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ manifest: manifestPath, overview: overviewPath, visibleNodes: manifest.visibleNodes }, null, 2));
