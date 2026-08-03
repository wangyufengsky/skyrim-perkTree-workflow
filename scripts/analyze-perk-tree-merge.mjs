#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { canonicalSha256, sha256 } from "./lib/canonical-json.mjs";

function usage() {
  console.error([
    "Usage: node analyze-perk-tree-merge.mjs",
    "  --base-details <perk-tree-details.json>",
    "  --incoming-details <perk-tree-details.json>",
    "  --output <directory>",
    "  [--base-label <label>] [--incoming-label <label>]"
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (key === "--base-details") result.baseDetails = value;
    else if (key === "--incoming-details") result.incomingDetails = value;
    else if (key === "--output") result.output = value;
    else if (key === "--base-label") result.baseLabel = value;
    else if (key === "--incoming-label") result.incomingLabel = value;
    else usage();
  }
  return result;
}

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function visibleNodes(tree) {
  return (tree.nodes ?? []).filter((node) => !node.invisibleRoot);
}

function fingerprint(node) {
  const perk = node.perkResolution?.perk;
  if (!perk) return null;
  return canonicalSha256({
    editorId: normalize(perk.editorId),
    name: normalize(perk.name?.value),
    description: normalize(perk.description?.value),
    data: perk.data ?? null,
    nextPerk: perk.nextPerk?.formKey ?? null,
    acquisitionConditions: perk.acquisitionConditions ?? [],
    effects: perk.effects ?? []
  });
}

function nodeSummary(node) {
  const perk = node.perkResolution?.perk;
  return {
    treeIndex: node.index,
    perkFormKey: node.perkFormKey,
    editorId: perk?.editorId ?? node.perkEditorId ?? null,
    name: perk?.name?.value ?? null,
    description: perk?.description?.value ?? null,
    resolutionStatus: node.perkResolution?.status ?? "unresolved",
    winningOverrideVerified: Boolean(node.perkResolution?.winningOverrideVerified),
    unresolved: perk?.unresolved ?? ["PERK details unresolved"],
    parentRequired: node.parentRequired,
    incomingConnections: node.incomingConnections ?? [],
    connections: node.connections ?? [],
    logicalX: node.logicalX,
    logicalY: node.logicalY,
    gridX: node.gridX,
    gridY: node.gridY,
    horizontalOffset: node.horizontalOffset,
    verticalOffset: node.verticalOffset,
    fingerprint: fingerprint(node)
  };
}

function classify(baseNode, incomingNode) {
  if (!incomingNode.winningOverrideVerified || incomingNode.resolutionStatus === "unresolved") {
    return { status: "unresolved-source", defaultDecision: "exclude", rationale: "来树的 PERK winner 未完整验证或未解析；不得自动导入。" };
  }
  if (baseNode && (!baseNode.winningOverrideVerified || baseNode.resolutionStatus === "unresolved")) {
    return { status: "unresolved-base", defaultDecision: "manual", rationale: "基树的同位候选未完整验证；不得用其判断重复或覆盖。" };
  }
  if (baseNode?.perkFormKey === incomingNode.perkFormKey) {
    return { status: "exact-duplicate", defaultDecision: "keep-base", rationale: "两节点引用同一稳定 PERK FormKey；不应重复导入。" };
  }
  if (baseNode && baseNode.fingerprint && baseNode.fingerprint === incomingNode.fingerprint) {
    return { status: "equivalent-review", defaultDecision: "keep-base", rationale: "PERK 的已解析名称、描述、DATA、CTDA、效果和 Next Perk 指纹相同，但 FormKey 不同；需用户确认是否视为重复。" };
  }
  const sameEditorId = baseNode && normalize(baseNode.editorId) && normalize(baseNode.editorId) === normalize(incomingNode.editorId);
  const sameName = baseNode && normalize(baseNode.name) && normalize(baseNode.name) === normalize(incomingNode.name);
  if (sameEditorId || sameName) {
    return { status: "semantic-conflict", defaultDecision: "manual", rationale: "EDID 或显示名相同但效果/条件证据不同；不能自动合并或替换。" };
  }
  if (baseNode) {
    return { status: "distinct-nearby", defaultDecision: "import", rationale: "与基树节点位置接近但 PERK 证据不同；可作为导入候选，仍需确认布局和前置连接。" };
  }
  return { status: "unique-import-candidate", defaultDecision: "import", rationale: "在同一 AVIF 树中未发现相同 FormKey、完整证据指纹、EDID 或名称的基树节点。" };
}

function nearest(baseNodes, incomingNode) {
  if (baseNodes.length === 0 || !Number.isFinite(incomingNode.logicalX) || !Number.isFinite(incomingNode.logicalY)) return null;
  return baseNodes.map((node) => ({
    node,
    distance: Math.hypot(node.logicalX - incomingNode.logicalX, node.logicalY - incomingNode.logicalY)
  })).sort((left, right) => left.distance - right.distance)[0];
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function project(nodes, area) {
  const usable = nodes.filter((node) => Number.isFinite(node.logicalX) && Number.isFinite(node.logicalY));
  if (usable.length === 0) return new Map();
  const xs = usable.map((node) => node.logicalX);
  const ys = usable.map((node) => node.logicalY);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const scale = Math.min((area.width - 48) / Math.max(maxX - minX, 1), (area.height - 68) / Math.max(maxY - minY, 1));
  return new Map(usable.map((node) => [node.treeIndex, {
    x: area.x + 24 + (node.logicalX - minX) * scale,
    y: area.y + 40 + (maxY - node.logicalY) * scale
  }]));
}

function renderTree(tree, area, label, colorByIndex) {
  const points = project(tree.nodes, area);
  const byIndex = new Map(tree.nodes.map((node) => [node.treeIndex, node]));
  const pieces = [`<rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" rx="12" class="panel"/>`, `<text x="${area.x + 18}" y="${area.y + 24}" class="heading">${escapeXml(label)}</text>`];
  for (const node of tree.nodes) {
    for (const target of node.connections) {
      const start = points.get(node.treeIndex); const end = points.get(target);
      if (start && end && byIndex.has(target)) pieces.push(`<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" class="edge"/>`);
    }
  }
  for (const node of tree.nodes) {
    const point = points.get(node.treeIndex); if (!point) continue;
    const color = colorByIndex.get(node.treeIndex) ?? "#94a3b8";
    const title = `${node.treeIndex} · ${node.editorId ?? node.perkFormKey}\n${node.name ?? "未解析"}`;
    pieces.push(`<g><title>${escapeXml(title)}</title><circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="11" fill="${color}"/><text x="${point.x.toFixed(2)}" y="${(point.y + 3).toFixed(2)}" text-anchor="middle" class="index">${node.treeIndex}</text></g>`);
  }
  return pieces.join("\n");
}

function renderSvg(analysis) {
  const pairs = analysis.trees.filter((tree) => tree.base && tree.incoming);
  const panelWidth = 550; const panelHeight = 360; const gap = 30;
  const width = panelWidth * 2 + gap * 3; const height = Math.max(180, pairs.length * (panelHeight + gap) + 105);
  const blocks = [];
  for (const [index, pair] of pairs.entries()) {
    const y = 85 + index * (panelHeight + gap);
    const colors = new Map(pair.items.map((item) => [item.incoming.treeIndex, ({
      "exact-duplicate": "#64748b", "equivalent-review": "#fbbf24", "semantic-conflict": "#ef4444", "unique-import-candidate": "#22c55e", "distinct-nearby": "#38bdf8", "unresolved-source": "#a855f7", "unresolved-base": "#a855f7"
    })[item.status] ?? "#94a3b8"]));
    blocks.push(renderTree(pair.base, { x: gap, y, width: panelWidth, height: panelHeight }, `${pair.displayName} · 基树`, new Map()));
    blocks.push(renderTree(pair.incoming, { x: gap * 2 + panelWidth, y, width: panelWidth, height: panelHeight }, `${pair.displayName} · 待并入树`, colors));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <style>text{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.panel{fill:#0f172a;stroke:#334155}.heading{fill:#e2e8f0;font-size:16px;font-weight:600}.edge{stroke:#64748b;stroke-width:1.6;opacity:.8}.index{font-size:9px;font-weight:700;fill:#020617}.title{fill:#f8fafc;font-size:24px;font-weight:700}.meta{fill:#cbd5e1;font-size:13px}</style>
  <rect width="100%" height="100%" fill="#020617"/><text x="30" y="33" class="title">双技能树合并评审图</text><text x="30" y="58" class="meta">灰=同 FormKey 重复；黄=同证据待确认；红=语义冲突；绿=独有导入候选；蓝=相邻但不同；紫=未解析</text>
  ${blocks.join("\n")}
</svg>\n`;
}

function markdown(analysis, svgPath) {
  const lines = [
    "# 双 Mod 技能树合并评审", "",
    `> 基树：\`${analysis.base.source}\`（源 SHA-256：\`${analysis.base.sourceSha256}\`）`,
    `> 待并入树：\`${analysis.incoming.source}\`（源 SHA-256：\`${analysis.incoming.sourceSha256}\`）`,
    `> 冻结环境：\`${analysis.frozenContextSha256}\`（load order、plugin map、语言、物理插件路径与 SHA 一致）`,
    `> 此报告 SHA-256：\`${analysis.analysisSha256}\`。它是只读提案，不产生 ESP，也不是用户批准。`, "",
    "## 图例与决策边界", "",
    `![合并评审图](${path.basename(svgPath)})`, "",
    "- `exact-duplicate`：同一稳定 PERK FormKey；默认保留基树，不重复导入。",
    "- `equivalent-review`：所有已解析 PERK 证据指纹一致、但 FormKey 不同；默认保留基树，须用户确认。",
  "- `semantic-conflict`：EDID 或名称相同而证据不同；只能人工决策，绝不自动覆盖。",
  "- `unique-import-candidate`/`distinct-nearby`：可导入候选；仍须确认坐标、入边、出边和 Parent Required。",
    "- `target-tree-unmatched`：待并入 AVIF 在基树中不存在；必须先由用户指定目标 AVIF，不能自动跨树拼接。",
    "- `unresolved-*`：缺少完整 winner 或 PERK 解析；不得导入。", "",
    "## 汇总", "",
    "| 分类 | 数量 | 默认处理 |", "|---|---:|---|"
  ];
  for (const [status, count] of Object.entries(analysis.summary.byStatus)) lines.push(`| ${status} | ${count} | ${analysis.summary.defaultByStatus[status]} |`);
  lines.push("", "## 逐项分析", "");
  for (const tree of analysis.trees) {
    lines.push(`### ${tree.displayName}（${tree.editorId} / ${tree.formKey}）`, "");
    if (!tree.base || !tree.incoming) {
      lines.push(`- 状态：${tree.base ? "仅基树存在" : "仅待并入树存在"}。不同 AVIF 不能在本工作流中自动拼接；需用户指定目标 AVIF 和新增树策略。`, "");
      continue;
    }
    lines.push("| 待并入 INAM / PERK | 名称 | 分类 | 最近基树节点 | 建议 | 依据 |", "|---|---|---|---|---|---|");
    for (const item of tree.items) {
      const source = item.incoming;
      const base = item.base ? `${item.base.treeIndex} / ${item.base.perkFormKey}` : "无";
      lines.push(`| ${source.treeIndex} / \`${source.perkFormKey}\` | ${source.name ?? source.editorId ?? "未解析"} | \`${item.status}\` | ${base} | \`${item.defaultDecision}\` | ${item.rationale} |`);
      lines.push(`| ↳ 结构 | 入边 [${source.incomingConnections.join(", ") || "无"}]；出边 [${source.connections.join(", ") || "无"}]；Parent Required=${source.parentRequired}；逻辑坐标 (${source.logicalX}, ${source.logicalY}) |  |  |  |  |  |`);
    }
    lines.push("");
  }
  lines.push("## 用户确认门", "", "请逐项确认：保留基树、导入待并入节点、排除，或手工指定替换/连线/坐标。只有用户明确确认后，才能生成与该报告 SHA 绑定的 change-set 并写出新的补丁 ESP。写后必须重新出图和完整说明，再等待最终确认。", "");
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.baseDetails || !args.incomingDetails || !args.output) usage();
const basePath = path.resolve(args.baseDetails); const incomingPath = path.resolve(args.incomingDetails); const output = path.resolve(args.output);
for (const filePath of [basePath, incomingPath]) if (!fs.existsSync(filePath)) throw new Error(`Details file does not exist: ${filePath}`);
const base = JSON.parse(fs.readFileSync(basePath, "utf8")); const incoming = JSON.parse(fs.readFileSync(incomingPath, "utf8"));
function validateDetails(details, label) {
  if (details.schemaVersion !== 2) throw new Error(`${label} details must use schemaVersion 2 with stable AVIF FormKeys`);
  if (details.resolution?.mode !== "explicit-load-order-complete" || details.resolution?.perkWinningOverridesVerified !== true) {
    throw new Error(`${label} details do not have complete load-order PERK winner evidence`);
  }
  if ((details.resolution.pluginFailures ?? []).length > 0) throw new Error(`${label} details contain plugin resolution failures`);
  if (!/^[0-9a-f]{64}$/.test(details.resolution?.frozenContextSha256 ?? "")) throw new Error(`${label} details have no frozen-context SHA-256`);
  if (!/^[0-9a-f]{64}$/.test(details.resolution?.loadOrderSha256 ?? "") || !/^[0-9a-f]{64}$/.test(details.resolution?.pluginMapSha256 ?? "")) {
    throw new Error(`${label} details must bind both plugins.txt and plugin-path-map.json`);
  }
  const context = details.resolution.frozenContext;
  if (!context || canonicalSha256(context) !== details.resolution.frozenContextSha256) {
    throw new Error(`${label} frozen-context content does not match its SHA-256`);
  }
  if (context.loadOrderSha256 !== details.resolution.loadOrderSha256 || context.pluginMapSha256 !== details.resolution.pluginMapSha256 || context.language !== details.resolution.language) {
    throw new Error(`${label} frozen-context fields disagree with resolution metadata`);
  }
}
validateDetails(base, "base"); validateDetails(incoming, "incoming");
if (base.resolution.frozenContextSha256 !== incoming.resolution.frozenContextSha256) {
  throw new Error(`Frozen analysis contexts differ: ${base.resolution.frozenContextSha256} != ${incoming.resolution.frozenContextSha256}`);
}
const baseLabel = args.baseLabel ?? path.basename(base.source ?? basePath); const incomingLabel = args.incomingLabel ?? path.basename(incoming.source ?? incomingPath);
function indexTrees(details, label) {
  const result = new Map();
  for (const tree of details.trees ?? []) {
    if (!tree.formKey || !/^.+\|[0-9a-f]{8}$/i.test(tree.formKey)) throw new Error(`${label} tree ${tree.editorId ?? "(no EDID)"} has no stable AVIF FormKey`);
    const key = normalize(tree.formKey);
    if (result.has(key)) throw new Error(`${label} contains duplicate AVIF FormKey ${tree.formKey}`);
    result.set(key, tree);
  }
  return result;
}
const baseByFormKey = indexTrees(base, "base");
const incomingByFormKey = indexTrees(incoming, "incoming");
const trees = [];
for (const formKeyKey of new Set([...baseByFormKey.keys(), ...incomingByFormKey.keys()])) {
  const baseTree = baseByFormKey.get(formKeyKey); const incomingTree = incomingByFormKey.get(formKeyKey);
  const formKey = baseTree?.formKey ?? incomingTree?.formKey;
  const editorId = baseTree?.editorId ?? incomingTree?.editorId ?? "";
  const baseNodes = baseTree ? visibleNodes(baseTree).map(nodeSummary) : [];
  const incomingNodes = incomingTree ? visibleNodes(incomingTree).map(nodeSummary) : [];
  const items = incomingNodes.map((source) => {
    if (!baseTree) {
      return { incoming: source, base: null, nearestBase: null, status: "target-tree-unmatched", defaultDecision: "manual", rationale: "基树没有同 EDID 的 AVIF；跨 AVIF 合并必须由用户指定目标树和新增树策略。" };
    }
    const formMatch = baseNodes.find((node) => node.perkFormKey === source.perkFormKey);
    const fingerprintMatch = source.fingerprint && baseNodes.find((node) => node.fingerprint === source.fingerprint);
    const idOrNameMatch = baseNodes.find((node) => (normalize(node.editorId) && normalize(node.editorId) === normalize(source.editorId)) || (normalize(node.name) && normalize(node.name) === normalize(source.name)));
    const nearby = nearest(baseNodes, source);
    const selected = formMatch ?? fingerprintMatch ?? idOrNameMatch ?? (nearby?.distance <= 0.0001 ? nearby.node : null);
    const decision = classify(selected, source);
    return { incoming: source, base: selected, nearestBase: nearby ? { treeIndex: nearby.node.treeIndex, distance: nearby.distance } : null, ...decision };
  });
  trees.push({ formKey, editorId, displayName: baseTree?.displayName ?? incomingTree?.displayName ?? (editorId || formKey), base: baseTree ? { nodes: baseNodes } : null, incoming: incomingTree ? { nodes: incomingNodes } : null, items });
}
const allItems = trees.flatMap((tree) => tree.items);
const byStatus = Object.fromEntries([...new Set(allItems.map((item) => item.status))].sort().map((status) => [status, allItems.filter((item) => item.status === status).length]));
const analysis = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  frozenContextSha256: base.resolution.frozenContextSha256,
  base: { details: basePath, detailsSha256: sha256(fs.readFileSync(basePath)), source: base.source, sourceSha256: base.sourceSha256, label: baseLabel, resolution: base.resolution ?? null },
  incoming: { details: incomingPath, detailsSha256: sha256(fs.readFileSync(incomingPath)), source: incoming.source, sourceSha256: incoming.sourceSha256, label: incomingLabel, resolution: incoming.resolution ?? null },
  summary: { matchedTrees: trees.filter((tree) => tree.base && tree.incoming).length, baseOnlyTrees: trees.filter((tree) => tree.base && !tree.incoming).length, incomingOnlyTrees: trees.filter((tree) => !tree.base && tree.incoming).length, incomingVisibleNodes: allItems.length, byStatus, defaultByStatus: Object.fromEntries(allItems.map((item) => [item.status, item.defaultDecision])) },
  trees
};
analysis.analysisSha256 = canonicalSha256({ ...analysis, analysisSha256: undefined, generatedAt: null });
fs.mkdirSync(output, { recursive: true });
const jsonPath = path.join(output, "perk-tree-merge-analysis.json"); const svgPath = path.join(output, "perk-tree-merge-analysis.svg"); const mdPath = path.join(output, "perk-tree-merge-analysis.md");
fs.writeFileSync(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`);
fs.writeFileSync(svgPath, renderSvg(analysis));
fs.writeFileSync(mdPath, markdown(analysis, svgPath));
console.log(JSON.stringify({ output, analysis: jsonPath, svg: svgPath, manual: mdPath, ...analysis.summary }, null, 2));
