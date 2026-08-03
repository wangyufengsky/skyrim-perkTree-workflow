# Skyrim Perk Tree Workflow for Codex

这是可迁移的 Codex Skill，用于读取 Skyrim TES5/SSE 插件中的 AVIF 技能树、
解析每个节点的 PERK/前置条件/效果、生成 SVG 和完整 Markdown，并通过
Mutagen 在 macOS、Linux、Windows 上安全创建新补丁 ESP。

## v0.3.0 能力

- 只读解析 ESP/ESM、压缩记录、AVIF 布局和 PERK 详情。
- 输出真实坐标、出入边、Parent Required、单树 SVG、总览 SVG。
- 解析名称、描述、rank、Next Perk、获取 CTDA、效果及效果 CTDA。
- 递归摘要可获得的 SPEL/MGEF 等引用；缺失项明确保留为 unresolved。
- 使用 `plugins.txt + plugin-path-map` 证明 winning override，拒绝猜测 MO2
  同名插件。
- 用 SHA-256 锁定源版本并完成图结构校验。
- 生成逐树、逐可见节点的中文 Markdown 说明。
- 内置 .NET 9 / Mutagen 0.54.2 writer；只生成新的单 AVIF override 补丁，
  不手写 ESP 二进制序列化。
- 写后先用 Mutagen 重新打开并比较，再由独立 Node 解析器回读和校验。

## 为什么不再依赖 Windows 写入

旧版只允许把 change-set 交给 Windows/xEdit worker。v0.3.0 改为
`Mutagen.Bethesda.Skyrim` 强类型模型负责读取、复制和序列化 AVIF，因此写入
流程可以在 .NET 支持的三个桌面平台执行，也不用维护容易损坏插件的自制
TES4/GRUP/子记录 writer。Windows 现在只在你选择用 SSEEdit 做额外
`Check for Errors` 或进行 Skyrim 游戏验证时需要。

## 环境

- 只读解析、SVG、JSON、Markdown：Node.js 18+，无 npm 依赖。
- 创建补丁 ESP：另需 .NET SDK 9+；NuGet 依赖由
  `packages.lock.json` 锁定，Mutagen 固定为 0.54.2。
- 游戏运行时验证：需要可运行 Skyrim 的环境。

## 导入另一台电脑

解压发布 ZIP。macOS/Linux：

```bash
sh skyrim-perk-tree-workflow/scripts/install.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File `
  ".\skyrim-perk-tree-workflow\scripts\install.ps1"
```

默认安装到 `${CODEX_HOME:-$HOME/.codex}/skills/skyrim-perk-tree-workflow`；
Windows 在未设置 `CODEX_HOME` 时使用
`%USERPROFILE%\.codex\skills\skyrim-perk-tree-workflow`。也可把目标目录作为
安装脚本参数，或手工复制整个目录。重启 Codex 后可请求：

```text
$skyrim-perk-tree-workflow 解析这个 ESP，生成 SVG、完整节点说明，并按我批准的 change-set 创建新补丁
```

## 只读分析

```bash
node "$HOME/.codex/skills/skyrim-perk-tree-workflow/scripts/run-readonly-workflow.mjs" \
  --input "/path/to/plugin.esp" \
  --output "/path/to/result" \
  --master-root "/path/to/ModOrganizer/mods" \
  --plugin-map "/path/to/plugin-path-map.json" \
  --load-order "/path/to/profiles/Profile Name/plugins.txt" \
  --language "English" \
  --expected-sha256 "64位小写SHA-256"
```

输出包含 `manifest.json`、`perk-tree-nodes.json`、
`perk-tree-details.json`、总览 SVG 与单树 SVG。没有完整 load order 时，
PERK 只能标为 `origin-record-only`，不会冒充游戏中的最终 winning override。

## 生成完整 Markdown

```bash
node scripts/generate-skill-tree-manual.mjs \
  --details "/path/to/result/perk-tree-details.json" \
  --output "/path/to/result/技能树完整说明.md" \
  --title "当前插件技能树完整说明"
```

文档逐棵树列出全部可见技能点、PERK FormKey/EDID、名称、描述、位置、入边、
出边、Parent Required、rank、Next Perk、获取条件、效果条件、来源链和解析状态。

## 创建新补丁 ESP

先编辑 `examples/change-set.json`，并确认原图、拟议图与机器 diff。然后：

```bash
node scripts/run-mutagen-write-workflow.mjs \
  --base "/path/to/verified-winning-plugin.esp" \
  --change-set "/path/to/change-set.json" \
  --output "/path/to/MyPerkTreePatch.esp" \
  --master-root "/path/to/ModOrganizer/mods" \
  --plugin-map "/path/to/plugin-path-map.json" \
  --load-order "/path/to/profiles/Profile Name/plugins.txt"
```

安全门：

- `--base` 只读且 SHA 必须与 change-set 相同；
- `--output` 必须是不存在的新 `.esp`，拒绝覆盖；
- `expectedWinnerPlugin` 必须和基线文件名一致；
- 输出只包含目标 AVIF override；
- 临时写出后由 Mutagen 重新打开并逐节点比较；
- 独立解析器再次验证节点、连接、环路和 SHA；
- 任何失败都返回非零结果。

写入成功会产生：

- 新补丁 ESP；
- `<补丁>.writer-report.json`；
- `<补丁>.verification/` 下的回读 JSON/SVG/manifest。

## 能力边界

Mutagen 写出并回读一致证明的是“目标 AVIF 补丁按 change-set 序列化成功”，不
自动证明最终 MO2 负载顺序、xEdit 全局错误检查或游戏 UI。VMAD/Papyrus 不做
完整语义反编译；没有映射的 CTDA 保留数值和原始字节，不猜测。

## 目录

- `SKILL.md`：Agent 入口规则。
- `scripts/`：只读解析、SVG、文档生成、写入编排、校验和安装工具。
- `writer/`：固定依赖的 Mutagen .NET writer 源码。
- `references/`：证据分层、完整 workflow、Mutagen writer 契约。
- `schemas/`：请求、插件路径映射、详情和 change-set JSON Schema。
- `examples/`：可复制的请求、load order、路径映射和变更集。
- `THIRD_PARTY_NOTICES.md`：Mutagen 依赖与许可证说明。
