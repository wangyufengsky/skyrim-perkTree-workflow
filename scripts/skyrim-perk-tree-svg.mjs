#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const [, , inputArg, outputArg, ...masterSearchArgs] = process.argv;

if (!inputArg || !outputArg) {
  console.error("Usage: node skyrim-perk-tree-svg.mjs <input.esp> <output-directory> [master-search-root ...]");
  process.exit(2);
}

const inputPath = path.resolve(inputArg);
const outputDirectory = path.resolve(outputArg);
const workspaceRoot = process.cwd();
const masterSearchRoots = [
  path.dirname(inputPath),
  ...(masterSearchArgs.length > 0
    ? masterSearchArgs.map((item) => path.resolve(item))
    : [workspaceRoot]),
];

const TREE_NAMES = {
  AVOneHanded: "单手",
  AVTwoHanded: "双手",
  AVMarksman: "箭术",
  AVBlock: "格挡",
  AVHeavyArmor: "重甲",
  AVSneak: "潜行",
};

const MASTER_COLORS = {
  "Skyrim.esm": "#b8c0cc",
  "Ordinator - Perks of Skyrim.esp": "#ffc857",
  "Ordinator Reworked - Combat Mod Compatibility.esp": "#ff6b6b",
  "SCSI-ACTbfco-Main.esp": "#bd8cff",
  "SCSI-PerksOfSkyrim.esp": "#52d5e8",
  "Vokrii - Minimalistic Perks of Skyrim.esp": "#70d17b",
  "Vokriinator.esp": "#69a8ff",
};

const MASTER_ABBREVIATIONS = {
  "Skyrim.esm": "Skyrim",
  "Ordinator - Perks of Skyrim.esp": "ORD",
  "Ordinator Reworked - Combat Mod Compatibility.esp": "ORD-RW",
  "SCSI-ACTbfco-Main.esp": "SCSI-ACT",
  "SCSI-PerksOfSkyrim.esp": "SCSI",
  "Vokrii - Minimalistic Perks of Skyrim.esp": "Vokrii",
  "Vokriinator.esp": "Vokriinator",
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function readZeroTerminatedString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end >= 0 ? end : buffer.length).toString("utf8");
}

function parseSubrecords(buffer) {
  const result = [];
  let position = 0;
  let extendedSize = null;

  while (position + 6 <= buffer.length) {
    const signature = buffer.toString("ascii", position, position + 4);
    let size = buffer.readUInt16LE(position + 4);
    position += 6;

    if (signature === "XXXX") {
      if (size !== 4 || position + 4 > buffer.length) {
        throw new Error(`Malformed XXXX subrecord at ${position - 6}`);
      }
      extendedSize = buffer.readUInt32LE(position);
      position += 4;
      continue;
    }

    if (extendedSize !== null) {
      size = extendedSize;
      extendedSize = null;
    }

    if (position + size > buffer.length) {
      throw new Error(`Subrecord ${signature} extends beyond its record`);
    }

    result.push({
      signature,
      data: buffer.subarray(position, position + size),
    });
    position += size;
  }

  return result;
}

function parseRecords(buffer) {
  const records = [];

  function walk(start, end) {
    let position = start;

    while (position + 24 <= end) {
      const signature = buffer.toString("ascii", position, position + 4);
      const size = buffer.readUInt32LE(position + 4);

      if (signature === "GRUP") {
        if (size < 24 || position + size > end) {
          throw new Error(`Malformed GRUP at ${position}`);
        }
        walk(position + 24, position + size);
        position += size;
        continue;
      }

      if (position + 24 + size > end) {
        throw new Error(`Record ${signature} at ${position} extends beyond its group`);
      }

      const flags = buffer.readUInt32LE(position + 8);
      const formId = buffer.readUInt32LE(position + 12);
      let data = buffer.subarray(position + 24, position + 24 + size);

      if ((flags & 0x00040000) !== 0) {
        if (data.length < 4) {
          throw new Error(`Compressed record ${signature} has no size prefix`);
        }
        data = zlib.inflateSync(data.subarray(4));
      }

      records.push({
        signature,
        formId,
        flags,
        subrecords: parseSubrecords(data),
      });
      position += 24 + size;
    }
  }

  walk(0, buffer.length);
  return records;
}

function getEditorId(record) {
  const edid = record.subrecords.find((subrecord) => subrecord.signature === "EDID");
  return edid ? readZeroTerminatedString(edid.data) : "";
}

function getMasters(records) {
  const header = records.find((record) => record.signature === "TES4");
  if (!header) {
    throw new Error("TES4 header record not found");
  }
  return header.subrecords
    .filter((subrecord) => subrecord.signature === "MAST")
    .map((subrecord) => readZeroTerminatedString(subrecord.data));
}

function walkFiles(directory, result = []) {
  if (!fs.existsSync(directory)) {
    return result;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, result);
    } else if (/\.(esm|esp|esl)$/i.test(entry.name)) {
      result.push(entryPath);
    }
  }
  return result;
}

function resolveFormKey(rawFormId, masters, sourcePluginName) {
  if (rawFormId === 0) {
    return { plugin: null, localFormId: 0, formKey: null, unresolvedSlot: false };
  }
  const slot = rawFormId >>> 24;
  const localFormId = rawFormId & 0x00ffffff;
  const plugin = slot < masters.length
    ? masters[slot]
    : slot === masters.length
      ? sourcePluginName
      : null;
  return {
    plugin,
    localFormId,
    formKey: plugin
      ? `${plugin}|${localFormId.toString(16).padStart(8, "0").toUpperCase()}`
      : null,
    unresolvedSlot: plugin === null,
  };
}

function buildPerkNameIndex(pluginNames) {
  const candidatesByName = new Map();

  const candidateFiles = [
    ...new Set(masterSearchRoots.flatMap((root) => walkFiles(root))),
  ];

  for (const candidate of candidateFiles) {
    const baseName = path.basename(candidate);
    if (!pluginNames.includes(baseName)) {
      continue;
    }
    if (!candidatesByName.has(baseName)) {
      candidatesByName.set(baseName, []);
    }
    candidatesByName.get(baseName).push(candidate);
  }

  const result = new Map();

  for (const pluginName of pluginNames) {
    const candidates = candidatesByName.get(pluginName) ?? [];
    const namesByLocalId = new Map();

    for (const candidate of candidates) {
      try {
        const records = parseRecords(fs.readFileSync(candidate));
        const ownSlot = getMasters(records).length;

        for (const record of records.filter((item) => item.signature === "PERK")) {
          if ((record.formId >>> 24) !== ownSlot) {
            continue;
          }
          const localId = record.formId & 0x00ffffff;
          const editorId = getEditorId(record);
          if (!editorId) {
            continue;
          }
          if (!namesByLocalId.has(localId)) {
            namesByLocalId.set(localId, new Set());
          }
          namesByLocalId.get(localId).add(editorId);
        }
      } catch {
        // A duplicate or unrelated plugin should not block rendering the target file.
      }
    }

    const stableNames = new Map();
    for (const [localId, names] of namesByLocalId) {
      if (names.size === 1) {
        stableNames.set(localId, [...names][0]);
      }
    }
    result.set(pluginName, stableNames);
  }

  return result;
}

function parseSkillTrees(records, masters, sourcePluginName, perkNameIndex) {
  const trees = [];

  for (const record of records.filter((item) => item.signature === "AVIF")) {
    const editorId = getEditorId(record);
    const nodes = [];
    let current = null;

    for (const subrecord of record.subrecords) {
      const { signature, data } = subrecord;

      if (signature === "PNAM") {
        const rawFormId = data.readUInt32LE(0);
        const masterSlot = rawFormId >>> 24;
        const resolved = resolveFormKey(rawFormId, masters, sourcePluginName);
        const localFormId = resolved.localFormId;
        const master = resolved.plugin;
        const resolvedEditorId = master
          ? perkNameIndex.get(master)?.get(localFormId)
          : null;

        current = {
          rawFormId,
          masterSlot,
          master,
          localFormId,
          formKey: rawFormId === 0 ? "NULL" : resolved.formKey,
          unresolvedSlot: resolved.unresolvedSlot,
          perkEditorId: resolvedEditorId ?? null,
          parentRequired: null,
          gridX: null,
          gridY: null,
          horizontalOffset: null,
          verticalOffset: null,
          associatedSkill: null,
          connections: [],
          index: null,
        };
        nodes.push(current);
        continue;
      }

      if (!current) {
        continue;
      }

      if (signature === "FNAM") {
        current.parentRequired = data.readUInt32LE(0) !== 0;
      } else if (signature === "XNAM") {
        current.gridX = data.readUInt32LE(0);
      } else if (signature === "YNAM") {
        current.gridY = data.readUInt32LE(0);
      } else if (signature === "HNAM") {
        current.horizontalOffset = data.readFloatLE(0);
      } else if (signature === "VNAM") {
        current.verticalOffset = data.readFloatLE(0);
      } else if (signature === "SNAM") {
        current.associatedSkill = data.readUInt32LE(0);
      } else if (signature === "CNAM") {
        current.connections.push(data.readUInt32LE(0));
      } else if (signature === "INAM") {
        current.index = data.readUInt32LE(0);
      }
    }

    const root = nodes.find((node) => node.rawFormId === 0 && node.index === 0);
    const visibleNodes = nodes.filter((node) => node !== root);
    const maxGridX = Math.max(...visibleNodes.map((node) => node.gridX));

    for (const node of visibleNodes) {
      node.logicalX = maxGridX - node.gridX - node.horizontalOffset;
      node.logicalY = node.gridY + node.verticalOffset;
    }

    const byIndex = new Map(nodes.map((node) => [node.index, node]));
    const allConnections = nodes.flatMap((node) =>
      node.connections.map((target) => ({ from: node.index, to: target })),
    );
    const visibleConnections = visibleNodes.flatMap((node) =>
      node.connections
        .filter((target) => {
          const targetNode = byIndex.get(target);
          return targetNode && targetNode !== root;
        })
        .map((target) => ({ from: node.index, to: target })),
    );

    const treeFormKey = resolveFormKey(record.formId, masters, sourcePluginName);
    trees.push({
      editorId,
      displayName: TREE_NAMES[editorId] ?? editorId,
      formId: record.formId,
      formKey: treeFormKey.formKey,
      unresolvedFormIdSlot: treeFormKey.unresolvedSlot,
      nodes,
      root,
      visibleNodes,
      allConnections,
      visibleConnections,
      maxGridX,
      validation: validateTree(nodes, root),
    });
  }

  return trees;
}

function validateTree(nodes, root) {
  const indices = nodes.map((node) => node.index);
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const duplicateIndices = [
    ...new Set(indices.filter((index, position) => indices.indexOf(index) !== position)),
  ];
  const danglingConnections = [
    ...new Set(nodes.flatMap((node) => node.connections).filter((target) => !byIndex.has(target))),
  ];
  const selfConnections = nodes.flatMap((node) =>
    node.connections
      .filter((target) => target === node.index)
      .map(() => node.index),
  );

  const reachable = new Set();
  const stack = root ? [root.index] : [];
  while (stack.length > 0) {
    const index = stack.pop();
    if (reachable.has(index)) {
      continue;
    }
    reachable.add(index);
    for (const child of byIndex.get(index)?.connections ?? []) {
      stack.push(child);
    }
  }

  const white = new Set(indices);
  const gray = new Set();
  let hasCycle = false;

  function visit(index) {
    white.delete(index);
    gray.add(index);
    for (const child of byIndex.get(index)?.connections ?? []) {
      if (gray.has(child)) {
        hasCycle = true;
        return;
      }
      if (white.has(child)) {
        visit(child);
      }
      if (hasCycle) {
        return;
      }
    }
    gray.delete(index);
  }

  while (white.size > 0 && !hasCycle) {
    visit(white.values().next().value);
  }

  return {
    rootCount: nodes.filter((node) => node.rawFormId === 0 && node.index === 0).length,
    duplicateIndices,
    danglingConnections,
    selfConnections,
    hasCycle,
    unreachableIndices: indices.filter((index) => !reachable.has(index)),
  };
}

function deterministicStars(width, height, count, seed) {
  let state = seed >>> 0;
  const stars = [];
  for (let index = 0; index < count; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const x = (state / 0xffffffff) * width;
    state = (state * 1664525 + 1013904223) >>> 0;
    const y = (state / 0xffffffff) * height;
    state = (state * 1664525 + 1013904223) >>> 0;
    const radius = 0.4 + (state / 0xffffffff) * 1.4;
    stars.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" fill="#dbeafe" opacity="${(0.18 + radius * 0.18).toFixed(2)}"/>`,
    );
  }
  return stars.join("\n");
}

function makeProjector(nodes, area) {
  const xs = nodes.map((node) => node.logicalX);
  const ys = nodes.map((node) => node.logicalY);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = Math.max(maxX - minX, 1);
  const rangeY = Math.max(maxY - minY, 1);
  const scale = Math.min(
    (area.width - area.padding * 2) / rangeX,
    (area.height - area.padding * 2) / rangeY,
  );
  const usedWidth = rangeX * scale;
  const usedHeight = rangeY * scale;
  const left = area.x + (area.width - usedWidth) / 2;
  const top = area.y + (area.height - usedHeight) / 2;

  return {
    position(node) {
      return {
        x: left + (node.logicalX - minX) * scale,
        y: top + (maxY - node.logicalY) * scale,
      };
    },
    bounds: { minX, maxX, minY, maxY, scale },
  };
}

function nodeTitle(tree, node) {
  const label = node.perkEditorId ?? node.formKey;
  return [
    `${tree.displayName} / ${tree.editorId}`,
    `INAM ${node.index}`,
    label,
    node.formKey,
    `逻辑坐标 (${node.logicalX.toFixed(4)}, ${node.logicalY.toFixed(4)})`,
    `Grid (${node.gridX}, ${node.gridY}) + Offset (${node.horizontalOffset.toFixed(4)}, ${node.verticalOffset.toFixed(4)})`,
    `Children [${node.connections.join(", ")}]`,
    `Parent Required: ${node.parentRequired}`,
  ].join("\n");
}

function renderTreeMarks(tree, area, options = {}) {
  const projector = makeProjector(tree.visibleNodes, area);
  const byIndex = new Map(tree.visibleNodes.map((node) => [node.index, node]));
  const positions = new Map(
    tree.visibleNodes.map((node) => [node.index, projector.position(node)]),
  );
  const nodeRadius = options.nodeRadius ?? 12;
  const showIndex = options.showIndex ?? true;
  const markerId = options.markerId ?? `arrow-${tree.editorId}`;
  const parts = [];

  for (const connection of tree.visibleConnections) {
    const source = positions.get(connection.from);
    const target = positions.get(connection.to);
    if (!source || !target) {
      continue;
    }
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    const startX = source.x + (dx / magnitude) * (nodeRadius + 2);
    const startY = source.y + (dy / magnitude) * (nodeRadius + 2);
    const endX = target.x - (dx / magnitude) * (nodeRadius + 5);
    const endY = target.y - (dy / magnitude) * (nodeRadius + 5);
    parts.push(
      `<line x1="${startX.toFixed(2)}" y1="${startY.toFixed(2)}" x2="${endX.toFixed(2)}" y2="${endY.toFixed(2)}" class="tree-edge" stroke="#90caf9" stroke-width="2.2" opacity="0.76" marker-end="url(#${markerId})"/>`,
    );
  }

  for (const node of tree.visibleNodes) {
    const position = positions.get(node.index);
    const color = MASTER_COLORS[node.master] ?? "#f7f1d0";
    const title = escapeXml(nodeTitle(tree, node));

    if (node.parentRequired === false) {
      const size = nodeRadius * 1.25;
      const points = [
        `${position.x.toFixed(2)},${(position.y - size).toFixed(2)}`,
        `${(position.x + size).toFixed(2)},${position.y.toFixed(2)}`,
        `${position.x.toFixed(2)},${(position.y + size).toFixed(2)}`,
        `${(position.x - size).toFixed(2)},${position.y.toFixed(2)}`,
      ].join(" ");
      parts.push(
        `<g class="tree-node"><title>${title}</title><polygon points="${points}" fill="${color}" stroke="#f8fafc" stroke-width="1.5"/></g>`,
      );
    } else {
      parts.push(
        `<g class="tree-node"><title>${title}</title><circle cx="${position.x.toFixed(2)}" cy="${position.y.toFixed(2)}" r="${nodeRadius}" fill="${color}" stroke="#f8fafc" stroke-width="1.5"/></g>`,
      );
    }

    if (showIndex) {
      parts.push(
        `<text x="${position.x.toFixed(2)}" y="${(position.y + 3.6).toFixed(2)}" class="node-index" text-anchor="middle">${node.index}</text>`,
      );
    }
  }

  return {
    svg: parts.join("\n"),
    bounds: projector.bounds,
    positions,
    byIndex,
  };
}

function commonDefinitions(markerIds) {
  const markers = markerIds.map((markerId) => `
    <marker id="${markerId}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,4 L0,8 z" fill="#90caf9" opacity="0.82"/>
    </marker>`).join("\n");

  return `
  <defs>
    <radialGradient id="backgroundGlow" cx="50%" cy="38%" r="72%">
      <stop offset="0%" stop-color="#162b4a"/>
      <stop offset="55%" stop-color="#081321"/>
      <stop offset="100%" stop-color="#03070d"/>
    </radialGradient>
    <filter id="nodeGlow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="3.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    ${markers}
  </defs>`;
}

function commonStyles() {
  return `
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .title { fill: #f8fafc; font-size: 28px; font-weight: 600; }
    .subtitle { fill: #a8b3c4; font-size: 14px; }
    .tree-heading { fill: #f8fafc; font-size: 22px; font-weight: 600; }
    .tree-meta { fill: #a8b3c4; font-size: 13px; }
    .tree-edge { stroke: #90caf9; stroke-width: 2.2; opacity: 0.76; }
    .tree-node { filter: url(#nodeGlow); }
    .node-index { fill: #08111e; font-size: 9px; font-weight: 700; pointer-events: none; }
    .legend-heading { fill: #f8fafc; font-size: 17px; font-weight: 600; }
    .legend-text { fill: #d9e2ef; font-size: 12px; }
    .legend-muted { fill: #91a0b5; font-size: 12px; }
    .panel { fill: #07111e; fill-opacity: 0.54; stroke: #29415f; stroke-width: 1; }
    .divider { stroke: #29415f; stroke-width: 1; }
  </style>`;
}

function renderOverview(trees, sourceHash, sourceName) {
  const panelWidth = 760;
  const panelHeight = 690;
  const panelGap = 30;
  const left = 30;
  const top = 120;
  const columns = Math.min(3, trees.length);
  const rows = Math.ceil(trees.length / columns);
  const width = left * 2 + columns * panelWidth + (columns - 1) * panelGap;
  const height = top + rows * panelHeight + (rows - 1) * panelGap + 70;
  const markerIds = trees.map((tree) => `overview-arrow-${tree.editorId}`);
  const body = [];

  trees.forEach((tree, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = left + column * (panelWidth + panelGap);
    const y = top + row * (panelHeight + panelGap);
    const plotArea = {
      x: x + 38,
      y: y + 86,
      width: panelWidth - 76,
      height: panelHeight - 128,
      padding: 30,
    };
    const rendered = renderTreeMarks(tree, plotArea, {
      nodeRadius: 10,
      showIndex: true,
      markerId: markerIds[index],
    });

    body.push(`
      <g>
        <rect x="${x}" y="${y}" width="${panelWidth}" height="${panelHeight}" rx="18" class="panel"/>
        <text x="${x + 28}" y="${y + 38}" class="tree-heading">${escapeXml(tree.displayName)} · ${escapeXml(tree.editorId)}</text>
        <text x="${x + 28}" y="${y + 64}" class="tree-meta">可见节点 ${tree.visibleNodes.length} · CNAM ${tree.allConnections.length} · 可见连线 ${tree.visibleConnections.length} · 根节点 → [${tree.root?.connections.join(", ") ?? ""}]</text>
        ${rendered.svg}
      </g>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="overview-title overview-desc">
  <title id="overview-title">${escapeXml(sourceName)} 技能树总览</title>
  <desc id="overview-desc">从目标插件的 AVIF 节点、坐标和连接直接解析的 ${trees.length} 棵技能树。各面板独立缩放，但保持各自横纵坐标比例。</desc>
  ${commonDefinitions(markerIds)}
  ${commonStyles()}
  <rect width="${width}" height="${height}" fill="url(#backgroundGlow)"/>
  ${deterministicStars(width, height, 300, 0x4f4b5249)}
  <text x="40" y="48" class="title">${escapeXml(sourceName)} · 技能树布局总览</text>
  <text x="40" y="78" class="subtitle">源文件 SHA-256 ${sourceHash} · 各面板独立缩放，节点位置由 XNAM/YNAM/HNAM/VNAM 计算</text>
  ${body.join("\n")}
  <text x="40" y="${height - 26}" class="subtitle">圆形：Parent Required · 菱形：Parent Required = false · 箭头：CNAM → INAM · 虚拟根节点不绘制</text>
</svg>
`;
}

function renderIndividual(tree, sourceHash, sourceName) {
  const width = 1920;
  const height = 1200;
  const markerId = `individual-arrow-${tree.editorId}`;
  const plotArea = { x: 40, y: 120, width: 1130, height: 1020, padding: 55 };
  const rendered = renderTreeMarks(tree, plotArea, {
    nodeRadius: 15,
    showIndex: true,
    markerId,
  });
  const legendX = 1215;
  const legendTop = 154;
  const rowHeight = Math.min(21, 940 / Math.max(tree.visibleNodes.length, 1));
  const legend = [];

  for (const [position, node] of tree.visibleNodes.entries()) {
    const y = legendTop + position * rowHeight;
    const color = MASTER_COLORS[node.master] ?? "#f7f1d0";
    const label = node.perkEditorId ?? node.formKey;
    const trimmedLabel = label.length > 44 ? `${label.slice(0, 41)}…` : label;
    const source = MASTER_ABBREVIATIONS[node.master] ?? node.master ?? "NULL";
    legend.push(`
      <g>
        <circle cx="${legendX + 9}" cy="${(y - 4).toFixed(1)}" r="5.5" fill="${color}"/>
        <text x="${legendX + 22}" y="${y.toFixed(1)}" class="legend-text">${String(node.index).padStart(2, "0")} · ${escapeXml(trimmedLabel)}</text>
        <text x="${legendX + 420}" y="${y.toFixed(1)}" class="legend-muted" text-anchor="end">${escapeXml(source)}</text>
        <text x="${legendX + 635}" y="${y.toFixed(1)}" class="legend-muted" text-anchor="end">(${node.logicalX.toFixed(3)}, ${node.logicalY.toFixed(3)})</text>
      </g>`);
  }

  const masterLegend = Object.entries(MASTER_COLORS)
    .filter(([master]) => tree.visibleNodes.some((node) => node.master === master))
    .map(([master, color], index) => `
      <g transform="translate(${legendX + (index % 2) * 310}, ${1090 + Math.floor(index / 2) * 24})">
        <circle cx="6" cy="-4" r="6" fill="${color}"/>
        <text x="18" y="0" class="legend-muted">${escapeXml(MASTER_ABBREVIATIONS[master] ?? master)}</text>
      </g>`)
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tree-title tree-desc">
  <title id="tree-title">${escapeXml(tree.displayName)} ${escapeXml(tree.editorId)} 技能树</title>
  <desc id="tree-desc">从 ${escapeXml(sourceName)} 的 AVIF 记录直接解析。节点编号为 INAM，箭头由 CNAM 指向目标 INAM。</desc>
  ${commonDefinitions([markerId])}
  ${commonStyles()}
  <rect width="${width}" height="${height}" fill="url(#backgroundGlow)"/>
  ${deterministicStars(width, height, 260, tree.formId)}
  <text x="40" y="48" class="title">${escapeXml(tree.displayName)} · ${escapeXml(tree.editorId)}</text>
  <text x="40" y="78" class="subtitle">可见节点 ${tree.visibleNodes.length} · CNAM ${tree.allConnections.length} · 可见连线 ${tree.visibleConnections.length} · 根节点 → [${tree.root?.connections.join(", ") ?? ""}]</text>
  <text x="40" y="101" class="subtitle">逻辑范围 X ${rendered.bounds.minX.toFixed(3)}…${rendered.bounds.maxX.toFixed(3)} · Y ${rendered.bounds.minY.toFixed(3)}…${rendered.bounds.maxY.toFixed(3)} · SHA-256 ${sourceHash.slice(0, 16)}…</text>
  <rect x="26" y="112" width="1160" height="1042" rx="18" class="panel"/>
  ${rendered.svg}
  <line x1="1200" y1="120" x2="1200" y2="1150" class="divider"/>
  <text x="${legendX}" y="132" class="legend-heading">节点索引 · PERK · 来源 · 逻辑坐标</text>
  ${legend.join("\n")}
  ${masterLegend}
  <text x="${legendX}" y="1174" class="legend-muted">圆形：Parent Required · 菱形：false · 虚拟根节点不绘制</text>
</svg>
`;
}

function safeFileName(editorId) {
  return editorId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

const sourceBuffer = fs.readFileSync(inputPath);
const sourceHash = crypto.createHash("sha256").update(sourceBuffer).digest("hex");
const sourceName = path.basename(inputPath);
const records = parseRecords(sourceBuffer);
const masters = getMasters(records);
const perkNameIndex = buildPerkNameIndex([...new Set([...masters, sourceName])]);
const trees = parseSkillTrees(records, masters, sourceName, perkNameIndex);

if (trees.length === 0) {
  throw new Error("No AVIF records with perk trees were found");
}

fs.mkdirSync(outputDirectory, { recursive: true });

const overviewPath = path.join(outputDirectory, "skill-trees-overview.svg");
fs.writeFileSync(overviewPath, renderOverview(trees, sourceHash, sourceName));

const outputFiles = [];
for (const tree of trees) {
  const filePath = path.join(outputDirectory, `${safeFileName(tree.editorId)}.svg`);
  fs.writeFileSync(filePath, renderIndividual(tree, sourceHash, sourceName));
  outputFiles.push(filePath);
}

const nodesPath = path.join(outputDirectory, "perk-tree-nodes.json");
const nodeExport = {
  schemaVersion: 2,
  source: inputPath,
  sourceSha256: sourceHash,
  generatedAt: new Date().toISOString(),
  masters,
  trees: trees.map((tree) => ({
    editorId: tree.editorId,
    displayName: tree.displayName,
    formId: `0x${tree.formId.toString(16).padStart(8, "0").toUpperCase()}`,
    formKey: tree.formKey,
    unresolvedFormIdSlot: tree.unresolvedFormIdSlot,
    maxGridX: tree.maxGridX,
    nodes: tree.nodes.map((node) => ({
      index: node.index,
      invisibleRoot: node === tree.root,
      perkFormKey: node.formKey,
      perkEditorId: node.perkEditorId,
      unresolvedFormIdSlot: node.unresolvedSlot,
      parentRequired: node.parentRequired,
      associatedSkill: node.associatedSkill,
      gridX: node.gridX,
      gridY: node.gridY,
      horizontalOffset: node.horizontalOffset,
      verticalOffset: node.verticalOffset,
      logicalX: node.logicalX ?? null,
      logicalY: node.logicalY ?? null,
      connections: node.connections,
      incomingConnections: tree.nodes
        .filter((candidate) => candidate.connections.includes(node.index))
        .map((candidate) => candidate.index),
    })),
    validation: tree.validation,
  })),
};
fs.writeFileSync(nodesPath, `${JSON.stringify(nodeExport, null, 2)}\n`);

const manifest = {
  source: inputPath,
  sourceSha256: sourceHash,
  generatedAt: new Date().toISOString(),
  masters,
  overview: overviewPath,
  nodes: nodesPath,
  trees: trees.map((tree, index) => ({
    editorId: tree.editorId,
    displayName: tree.displayName,
    formId: `0x${tree.formId.toString(16).padStart(8, "0").toUpperCase()}`,
    formKey: tree.formKey,
    unresolvedFormIdSlot: tree.unresolvedFormIdSlot,
    visibleNodes: tree.visibleNodes.length,
    allConnections: tree.allConnections.length,
    visibleConnections: tree.visibleConnections.length,
    rootConnections: tree.root?.connections ?? [],
    svg: outputFiles[index],
    validation: tree.validation,
  })),
};

fs.writeFileSync(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(JSON.stringify(manifest, null, 2));
