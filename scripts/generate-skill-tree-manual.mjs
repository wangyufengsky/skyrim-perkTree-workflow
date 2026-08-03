#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node generate-skill-tree-manual.mjs --details <perk-tree-details.json> --output <manual.md> [--title <title>]");
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (key === "--details") result.details = value;
    else if (key === "--output") result.output = value;
    else if (key === "--title") result.title = value;
    else usage();
  }
  return result;
}

function text(value, fallback = "未提供") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).replaceAll("\r", " ").replaceAll("\n", " ").trim();
}

function heading(value) {
  return text(value).replaceAll("#", "＃");
}

function number(value, digits = 6) {
  if (value === undefined || value === null) return "null";
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

const args = parseArgs(process.argv.slice(2));
if (!args.details || !args.output) usage();
const detailsPath = path.resolve(args.details);
const outputPath = path.resolve(args.output);
const document = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
const references = document.referencedRecords ?? {};

function referenceLabel(formKey) {
  if (!formKey) return "null";
  const resolution = references[formKey];
  const record = resolution?.record;
  const name = record?.name?.value;
  const editorId = record?.editorId;
  const label = name || editorId;
  return label ? `${formKey} (${text(label)})` : formKey;
}

function parameterLabel(parameter) {
  if (!parameter) return "null";
  const type = text(parameter.expectedType, "unknown");
  const formKey = parameter.formReference?.formKey ?? parameter.formReferenceCandidate?.formKey;
  if (formKey) return `${type}: ${referenceLabel(formKey)}`;
  return `${type}: ${parameter.signedInt32 ?? parameter.rawUInt32 ?? "null"}`;
}

function conditionLabel(condition, position) {
  const join = condition.flags?.or ? "OR" : position === 0 ? "首条" : "AND";
  const fn = condition.function?.name ?? `Function#${condition.functionId ?? "?"}`;
  const comparison = condition.comparison?.useGlobalCandidate?.formKey
    ? referenceLabel(condition.comparison.useGlobalCandidate.formKey)
    : number(condition.comparison?.asFloat);
  const parameters = (condition.parameters ?? []).map(parameterLabel).join("；") || "无参数";
  const runOn = condition.runOnType ?? 0;
  return `${join} · ${fn}(${parameters}) ${condition.operator ?? "?"} ${comparison} · RunOn=${runOn}`;
}

function effectLabel(effect) {
  const data = effect.data ?? {};
  const pairs = Object.entries(data)
    .filter(([key]) => !["kind", "conditionTabCount"].includes(key))
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`);
  return `type=${effect.type ?? "?"} · kind=${data.kind ?? "unknown"} · rank=${effect.rank ?? "?"} · priority=${effect.priority ?? "?"}${pairs.length ? ` · ${pairs.join(" · ")}` : ""}`;
}

const lines = [];
const title = args.title ?? `${path.basename(document.source ?? "Skyrim ESP")} 技能树完整说明`;
lines.push(`# ${heading(title)}`, "");
lines.push(
  `> 本文由 AVIF 技能树结构与已解析 PERK 记录自动生成。源文件 SHA-256：\`${document.sourceSha256}\`。`,
  `> 当前解析模式：\`${document.resolution?.mode ?? "unknown"}\`；winning override 已验证 ${document.summary?.winningOverridesVerified ?? 0} 个。未解析项会原样标为“未解析”，不以猜测补全。`,
  ""
);

lines.push("## 阅读说明", "");
lines.push(
  "- `INAM` 是技能树节点索引；坐标来自 AVIF 的 `XNAM/YNAM/HNAM/VNAM`。",
  "- `CNAM → INAM` 表示界面树上的有向连接；`Parent Required` 表示父节点是否为购买约束。PERK 自身的 CTDA 条件另列为“获取条件”。",
  "- “来源状态 = origin-record-only”表示找到了 FormKey 所属插件中的原始 PERK，但没有用完整活动加载顺序证明它是最终 winning override。",
  "- 条件中的 `AND/OR`、函数、比较符、比较值和参数均来自 CTDA 解码；完整原始十六进制仍保留在对应 JSON 中。",
  ""
);

lines.push("## 总览", "");
lines.push("| 技能树 | AVIF | 可见技能点 | 已解析 | 未解析 | 获取条件 | 效果条件 |", "|---|---|---:|---:|---:|---:|---:|");
for (const tree of document.trees ?? []) {
  const visible = tree.nodes.filter(node => !node.invisibleRoot);
  const resolved = visible.filter(node => node.perkResolution?.perk).length;
  const acquisition = visible.reduce((sum, node) => sum + (node.perkResolution?.perk?.acquisitionConditions?.length ?? 0), 0);
  const effects = visible.flatMap(node => node.perkResolution?.perk?.effects ?? []);
  const effectConditions = effects.reduce((sum, effect) => sum + (effect.conditions?.length ?? 0), 0);
  lines.push(`| ${text(tree.displayName)} | ${tree.editorId} / ${tree.formId} | ${visible.length} | ${resolved} | ${visible.length - resolved} | ${acquisition} | ${effectConditions} |`);
}
lines.push("");

let documentedNodes = 0;
for (const [treePosition, tree] of (document.trees ?? []).entries()) {
  const visibleNodes = tree.nodes.filter(node => !node.invisibleRoot);
  const root = tree.nodes.find(node => node.invisibleRoot);
  const resolvedCount = visibleNodes.filter(node => node.perkResolution?.perk).length;
  lines.push(`## ${treePosition + 1}. ${heading(tree.displayName)}（${tree.editorId}）`, "");
  lines.push(
    `- AVIF：\`${tree.formId}\`；可见技能点 ${visibleNodes.length}；已解析 ${resolvedCount}；未解析 ${visibleNodes.length - resolvedCount}。`,
    `- 虚拟根节点：INAM ${root?.index ?? "无"}，连接到 [${root?.connections?.join(", ") || "无"}]。`,
    `- 网格范围：X 0…${tree.maxGridX ?? "?"}；结构校验：重复索引 ${tree.validation?.duplicateIndices?.length ?? "?"}、悬空连接 ${tree.validation?.danglingConnections?.length ?? "?"}、环 ${tree.validation?.hasCycle ? "有" : "无"}。`,
    ""
  );

  for (const [nodePosition, node] of visibleNodes.entries()) {
    documentedNodes += 1;
    const resolution = node.perkResolution ?? {};
    const perk = resolution.perk;
    const name = perk?.name?.value ?? node.perkEditorId ?? node.perkFormKey;
    lines.push(`### 节点 ${treePosition + 1}.${nodePosition + 1} · INAM ${node.index} · ${heading(name)}`, "");
    lines.push(
      `- PERK：\`${node.perkFormKey}\`；EDID：\`${text(perk?.editorId ?? node.perkEditorId, "未解析")}\`；来源状态：\`${resolution.status ?? "unresolved"}\`；winning override：${resolution.winningOverrideVerified ? "已验证" : "未验证"}。`,
      `- 名称：${text(perk?.name?.value, "未解析")}`,
      `- 描述：${text(perk?.description?.value, "未解析；需要提供该 FormKey 所属插件或完整加载顺序后重新提取")}`,
      `- 位置：网格 (${node.gridX}, ${node.gridY})；偏移 (${number(node.horizontalOffset)}, ${number(node.verticalOffset)})；逻辑坐标 (${number(node.logicalX)}, ${number(node.logicalY)})。`,
      `- 树前置：入边 [${node.incomingConnections?.join(", ") || "无"}]；Parent Required = ${node.parentRequired}; 出边 [${node.connections?.join(", ") || "无"}]。`
    );

    if (!perk) {
      const origin = node.perkFormKey?.split("|")[0] ?? "未知插件";
      lines.push(`- 解析说明：没有在已提供路径中找到 \`${origin}\` 的目标 PERK 记录，因此名称、描述、等级、获取条件与效果均不推断。`, "");
      continue;
    }

    lines.push(
      `- 等级：level=${perk.data?.level ?? "?"}；ranks=${perk.data?.numRanks ?? "?"}；playable=${perk.data?.playable ?? "?"}；hidden=${perk.data?.hidden ?? "?"}；trait=${perk.data?.trait ?? "?"}。`,
      `- 下一等级：${perk.nextPerk?.formKey ? referenceLabel(perk.nextPerk.formKey) : "无"}。`
    );
    const chain = resolution.overrideChain ?? [];
    lines.push(`- 已见覆盖链：${chain.length ? chain.map(item => `${item.plugin} (${item.editorId ?? "无 EDID"})`).join(" → ") : "无"}。`);

    const acquisition = perk.acquisitionConditions ?? [];
    lines.push(`- 获取条件（${acquisition.length}）：`);
    if (acquisition.length === 0) lines.push("  - 无 PERK 级 CTDA 获取条件。");
    else acquisition.forEach((condition, index) => lines.push(`  - ${index + 1}. ${conditionLabel(condition, index)}`));

    const effects = perk.effects ?? [];
    lines.push(`- 效果（${effects.length}）：`);
    if (effects.length === 0) lines.push("  - 无 PRKE 效果记录。");
    for (const [effectIndex, effect] of effects.entries()) {
      lines.push(`  - 效果 ${effectIndex + 1}：${effectLabel(effect)}`);
      const conditions = effect.conditions ?? [];
      if (conditions.length === 0) lines.push("    - 条件：无。");
      else conditions.forEach((condition, index) => lines.push(`    - 条件 ${index + 1}：${conditionLabel(condition, index)}`));
    }
    lines.push("");
  }
}

lines.push("## 数据完整性结论", "");
lines.push(
  `- 文档技能树：${document.trees?.length ?? 0} 棵。`,
  `- 文档可见技能点：${documentedNodes} 个（输入汇总：${document.summary?.visibleNodes ?? "?"}）。`,
  `- 已解析 PERK：${document.summary?.resolvedPerks ?? "?"}；未解析 PERK：${document.summary?.unresolvedPerks ?? "?"}。`,
  `- 获取 CTDA：${document.summary?.acquisitionConditions ?? "?"}；效果 CTDA：${document.summary?.effectConditions ?? "?"}；未映射 CTDA：${document.summary?.unmappedConditions ?? "?"}。`,
  `- 结构和 PERK 详情的机器可读依据：\`${detailsPath}\`。`,
  ""
);

if (documentedNodes !== document.summary?.visibleNodes) {
  throw new Error(`Documented visible node count ${documentedNodes} does not match input summary ${document.summary?.visibleNodes}.`);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
console.log(JSON.stringify({
  output: outputPath,
  trees: document.trees?.length ?? 0,
  visibleNodes: documentedNodes,
  resolvedPerks: document.summary?.resolvedPerks ?? 0,
  unresolvedPerks: document.summary?.unresolvedPerks ?? 0
}, null, 2));
