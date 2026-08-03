# Skyrim Perk Tree Workflow for Codex

`skyrim-perk-tree-workflow` 是一个用于读取、比较、说明和安全编辑《上古卷轴 5》
TES5/SSE 技能树的 Codex Skill。当前版本为 `0.6.0`。

它把两类数据严格分开：

- `AVIF`：技能点位置、父级要求、节点编号和连接关系。
- `PERK`：名称、描述、等级、获取条件、效果和效果条件。

源 ESP/ESM/ESL 始终只读。需要修改时，只能通过固定版本的 Mutagen 创建一个新的
补丁 ESP，不能覆盖原插件。

## 能做什么

| 用途 | 适用场景 | 主要输入 | 主要产物 |
|---|---|---|---|
| 只读解析技能树 | 查看一个插件实际包含的技能树布局及每个节点的名称和等级 | ESP/ESM/ESL | 名称/等级 SVG、节点 JSON、详情 JSON、manifest |
| 生成完整技能点说明 | 需要逐技能点查看名称、条件、效果和来源 | `perk-tree-details.json` | Markdown 手册 |
| 校验树结构 | 排查重复索引、断线、环路、不可达节点 | 只读解析结果 | 结构校验结论 |
| 证明 winning override | 确认某个 AVIF 在冻结 MO2 配置中的最终来源 | `plugins.txt`、路径映射、插件文件 | winner 证明 JSON |
| 比较两个 Mod | 找出确定重复、语义冲突、独有节点和未解析项 | 两份完整详情 JSON | 合并评审 SVG/Markdown/JSON |
| 确认合并决策 | 把用户逐项选择绑定到评审报告的内容哈希 | 评审 JSON、决策 JSON | 已验证决策结论 |
| 创建补丁 ESP | 移动、增删或连接技能点 | winning base、change-set、冻结配置 | 新 ESP、writer 报告、回读证据 |
| 独立核对写入结果 | 证明新 ESP 与批准的 change-set 完全一致 | 基线/补丁节点 JSON、change-set | 对账报告 JSON |

## 安装要求

- Codex。
- Node.js 18 或更高版本。
- 只读解析、SVG、JSON、Markdown 和合并评审不需要 npm 依赖。
- 创建补丁 ESP 时需要 .NET SDK 9 或更高版本。
- writer 固定使用 `Mutagen.Bethesda.Skyrim` 0.54.2。

## 安装

### 获取项目

```bash
git clone https://github.com/wangyufengsky/skyrim-perkTree-workflow.git
cd skyrim-perkTree-workflow
```

也可以从 GitHub 下载 ZIP 并解压。

### 安装到 Codex

macOS 或 Linux：

```bash
sh scripts/install.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\install.ps1"
```

默认安装位置：

- macOS/Linux：`${CODEX_HOME:-$HOME/.codex}/skills/skyrim-perk-tree-workflow`
- Windows：`%CODEX_HOME%\skills\skyrim-perk-tree-workflow`
- Windows 未设置 `CODEX_HOME` 时：`%USERPROFILE%\.codex\skills\skyrim-perk-tree-workflow`

指定其他安装目录：

```bash
sh scripts/install.sh "/custom/path/skyrim-perk-tree-workflow"
```

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\install.ps1" `
  -Destination "D:\Codex\skills\skyrim-perk-tree-workflow"
```

安装脚本不会覆盖已存在的目标目录。更新已有安装时，应先确认旧目录是否需要备份，
再由用户明确执行替换。安装完成后重启 Codex。

## 在 Codex 中使用

最简单的方式是直接调用 Skill，并提供绝对路径：

```text
$skyrim-perk-tree-workflow 只读解析这个 ESP，生成技能树 SVG、节点 JSON 和完整技能点说明：/absolute/path/MyPerkMod.esp
```

双 Mod 评审示例：

```text
$skyrim-perk-tree-workflow 使用同一个 MO2 plugins.txt 和 plugin-path-map.json，对 Base.esp 与 Incoming.esp 做只读技能树合并评审。先给我重复、冲突、未解析项和导入候选，不要写补丁。
```

编辑示例：

```text
$skyrim-perk-tree-workflow 根据我批准的 change-set 创建新的补丁 ESP。先证明 base 是目标 AVIF 的 winner，写后独立回读并逐字段对账，不要覆盖源文件。
```

下面各节给出直接运行脚本的方法。

## 使用前准备

完整来源证明和写入流程通常需要以下文件：

### `plugins.txt`

使用目标 MO2 profile 的真实活动插件列表，顺序必须与最终配置一致。例如：

```text
*Skyrim.esm
*Update.esm
*Ordinator - Perks of Skyrim.esp
*MyPerkMod.esp
```

只要文件中存在 `*` 行，工作流就仅把带 `*` 的插件视为活动插件。

### `plugin-path-map.json`

键是精确插件文件名，值必须是绝对物理路径。同名插件存在于多个 MO2 Mod 目录时，
必须明确映射实际启用的文件。

```json
{
  "Skyrim.esm": "/absolute/path/Skyrim.esm",
  "Ordinator - Perks of Skyrim.esp": "/absolute/path/Ordinator - Perks of Skyrim.esp",
  "MyPerkMod.esp": "/absolute/path/MyPerkMod.esp"
}
```

Windows 示例见 [examples/plugin-path-map.json](examples/plugin-path-map.json)。

### Master 搜索根目录

`--master-root` 可以重复指定。通常传入 Skyrim `Data` 目录和 MO2 `mods` 目录：

```text
--master-root "/absolute/path/Skyrim Special Edition/Data"
--master-root "/absolute/path/ModOrganizer/mods"
```

找不到 master 不会改变已读取的 AVIF 几何，但名称、描述、条件、效果或最终 winner
必须保持未解析，不能根据截图、EDID 或目录顺序猜测。

## 用途一：只读解析一个插件

### 快速布局解析

只关心目标文件自身的技能树形状时，可以只提供输入和输出目录：

```bash
node scripts/run-readonly-workflow.mjs \
  --input "/absolute/path/MyPerkMod.esp" \
  --output "/absolute/path/analysis"
```

这种方式可以证明目标文件中的 AVIF 几何，但没有完整 load order 时，不能把解析到的
PERK 记录称为游戏中的最终 winning override。

### 完整来源解析

需要名称、描述、条件、覆盖链和冻结环境证据时：

```bash
node scripts/run-readonly-workflow.mjs \
  --input "/absolute/path/MyPerkMod.esp" \
  --output "/absolute/path/analysis" \
  --master-root "/absolute/path/Skyrim/Data" \
  --master-root "/absolute/path/ModOrganizer/mods" \
  --plugin-map "/absolute/path/plugin-path-map.json" \
  --load-order "/absolute/path/plugins.txt" \
  --language "English" \
  --expected-sha256 "目标插件的64位小写SHA256"
```

主要产物：

- `manifest.json`：源 SHA、master、树列表、结构校验和产物路径。
- `perk-tree-nodes.json`：稳定 AVIF/PERK FormKey、INAM、坐标、FNAM、SNAM、CNAM。
- `perk-tree-details.json`：PERK 文本、等级、CTDA、效果、引用记录和来源链。
- `skill-trees-overview.svg`：紧凑几何总览。
- `skill-trees-overview-names-levels.svg`：可独立打开的名称/等级完整总览。
- `<tree-edid>.svg`：每棵树的独立 SVG；每个可见节点按 INAM 列出名称、技能等级、阶数、来源和逻辑坐标。
- `perk-tree-svg-annotations.json`：逐树名称/等级标注覆盖率、门槛解析状态和 SVG SHA。

图片中的 `Lv30+` 等标签来自该 PERK 获取条件里与当前技能树匹配的
`GetBaseActorValue >= 30` CTDA。工作流不会使用通常为 0 的 `PERK.DATA.level`
冒充技能等级门槛。已解析 PERK 没有显式技能门槛时显示 `Lv—`；PERK 或门槛
证据未解析时显示 `Lv?`。`validate-output.mjs` 要求 legend 和悬浮 title 对全部
visible nodes 闭合，漏一个节点即失败。

`perk-tree-details.json` 中的重要状态：

- `origin-only`：仅看到了 FormKey 来源插件，不是最终覆盖证明。
- `explicit-load-order-incomplete`：提供了 load order，但仍有缺失或歧义。
- `explicit-load-order-complete`：活动插件均已解析，可以证明 PERK winner。
- `tree.avifResolution.winningOverrideVerified`：当前源插件是否为该 AVIF 的 winner。
- `resolution.frozenContextSha256`：load order、路径映射、语言、roots 和物理插件
  SHA 的冻结环境指纹。

## 用途二：生成完整 Markdown 手册

只读解析完成后运行：

```bash
node scripts/generate-skill-tree-manual.mjs \
  --details "/absolute/path/analysis/perk-tree-details.json" \
  --output "/absolute/path/analysis/skill-tree-manual.md" \
  --title "MyPerkMod 技能树完整说明"
```

手册逐节点列出：

- stable AVIF/PERK FormKey、INAM 和 EDID。
- 名称、描述、等级、rank 和 Next Perk。
- 网格、偏移、逻辑坐标、入边、出边和 Parent Required。
- PERK 级获取 CTDA、效果、效果 CTDA 和引用记录。
- PERK winner、AVIF winner、覆盖链和未解析原因。

生成器会核对文档节点数与详情汇总；漏掉任何可见节点都会失败。

## 用途三：比较两个 Mod 的技能树

### 第一步：生成两份同环境基线

分别对 base 和 incoming 运行完整只读解析，并使用完全相同的：

- `plugins.txt`
- `plugin-path-map.json`
- `--master-root`
- `--language`

两个 `perk-tree-details.json` 必须是 schema v2、具有完整 PERK winner 证据，并且
`frozenContextSha256` 一致。

### 第二步：生成合并评审

```bash
node scripts/analyze-perk-tree-merge.mjs \
  --base-details "/absolute/path/base-analysis/perk-tree-details.json" \
  --incoming-details "/absolute/path/incoming-analysis/perk-tree-details.json" \
  --output "/absolute/path/merge-review" \
  --base-label "当前基树" \
  --incoming-label "待并入树"
```

产物：

- `perk-tree-merge-analysis.svg`
- `perk-tree-merge-analysis.md`
- `perk-tree-merge-analysis.json`

分类含义：

| 分类 | 含义 | 是否允许直接导入 |
|---|---|---|
| `exact-duplicate` | stable PERK FormKey 完全相同 | 否 |
| `equivalent-review` | FormKey 不同，但完整已解析证据指纹相同 | 用户确认后可选 |
| `semantic-conflict` | EDID/名称相同，但条件或效果证据不同 | 否，必须人工处理 |
| `unique-import-candidate` | 没有发现重复或语义冲突 | 用户确认后可选 |
| `distinct-nearby` | 位置接近，但 PERK 证据不同 | 用户确认后可选 |
| `unresolved-source` / `unresolved-base` | 任一侧来源证据不完整 | 否 |
| `target-tree-unmatched` | incoming AVIF FormKey 在 base 中不存在 | 否，需单独指定目标策略 |

树只按 stable AVIF FormKey 配对。相同 EDID、显示名或坐标不会被当作同一棵树的
充分证据。

## 用途四：记录并验证合并决策

阅读 SVG 和 Markdown 后，为评审 JSON 中的每一个 incoming 节点建立决策。
决策格式为 schema v2：

```json
{
  "version": 2,
  "analysisSha256": "复制 perk-tree-merge-analysis.json 中的 analysisSha256",
  "approved": true,
  "comment": "逐项检查完成",
  "decisions": [
    {
      "treeFormKey": "Skyrim.esm|0000044C",
      "treeEditorId": "AVOneHanded",
      "incomingIndex": 12,
      "action": "import",
      "note": "保留坐标并显式重建连接"
    }
  ]
}
```

支持的动作：

- `keep-base`：保留 base，不导入 incoming 节点。
- `import`：把已批准候选转成后续 `addNode`/`connect` 操作。
- `exclude`：明确排除。
- `manual`：仍需人工处理；只要存在 `manual`，最终验证就不会通过。

验证命令：

```bash
node scripts/validate-merge-decision.mjs \
  --analysis "/absolute/path/merge-review/perk-tree-merge-analysis.json" \
  --decision "/absolute/path/merge-decision.json"
```

验证器会重新计算分析报告的规范化 SHA，检查是否遗漏或重复决策，并根据分类限制
动作。篡改报告、SHA 不符、未决项或禁止导入的分类都会失败。

决策通过只表示“可以据此制作 change-set”，不会自动创建或写入 ESP。

## 用途五：创建新的技能树补丁 ESP

### change-set

change-set 必须符合 [schemas/change-set.schema.json](schemas/change-set.schema.json)，
示例见 [examples/change-set.json](examples/change-set.json)。核心字段：

```json
{
  "version": 2,
  "basePlugin": "MyPerkMod.esp",
  "baseSha256": "64位小写SHA256",
  "expectedWinnerPlugin": "MyPerkMod.esp",
  "targetAvif": "Skyrim.esm|0000044C",
  "outputPlugin": "MyPerkTreePatch.esp",
  "reason": "经 SVG 和逐节点评审后调整技能树",
  "operations": []
}
```

支持的操作：

| 操作 | 用途 | 关键字段 |
|---|---|---|
| `moveNode` | 移动现有节点 | `nodeIndex`、`xnam/ynam/hnam/vnam` |
| `connect` | 新增 CNAM 有向连接 | `fromIndex`、`toIndex` |
| `disconnect` | 删除已有连接 | `fromIndex`、`toIndex` |
| `updateParentRequired` | 修改 FNAM | `nodeIndex`、`required` |
| `removeNode` | 删除节点并移除所有指向它的连接 | `nodeIndex` |
| `addNode` | 新增明确 PERK FormKey 的节点 | `nodeIndex`、`perkFormKey`、坐标、`required` |

`addNode` 的 PERK 必须属于 base 或 base 已声明的 master。工作流不会为了新增节点
暗中增加 master 依赖。所有新增连接必须使用独立的 `connect` 操作声明。

### 执行写入

```bash
node scripts/run-mutagen-write-workflow.mjs \
  --base "/absolute/path/verified-winner.esp" \
  --change-set "/absolute/path/change-set.json" \
  --output "/absolute/path/MyPerkTreePatch.esp" \
  --verification-output "/absolute/path/MyPerkTreePatch.verification" \
  --master-root "/absolute/path/Skyrim/Data" \
  --master-root "/absolute/path/ModOrganizer/mods" \
  --plugin-map "/absolute/path/plugin-path-map.json" \
  --load-order "/absolute/path/plugins.txt" \
  --language "English" \
  --game-release "SkyrimSE"
```

写入要求：

- `--plugin-map` 和 `--load-order` 是必填项。
- `--base` 必须是 `targetAvif` 在该冻结配置中的最终物理 winner。
- `baseSha256` 必须与实际 base 完全一致。
- `--output`、writer report 和 verification 目录都必须不存在。
- 输出必须是新的 `.esp`，不能等于或覆盖源文件。

成功产物：

- `MyPerkTreePatch.esp`：Mutagen 创建的新补丁。
- `MyPerkTreePatch.esp.writer-report.json`：Mutagen 版本、源/输出 SHA 和结构摘要。
- `winner-proof.json`：写入前 AVIF 覆盖链和物理 winner 证明。
- `base/`：写入前基线的独立 Node 解析结果。
- `patch/`：写入后补丁的独立 Node 解析结果和 SVG。
- `change-set-reparse-verification.json`：逐字段 change-set 对账报告。

只有 writer reopen 和独立 Node 对账全部成功，才能称“补丁已构建”。如果命令返回
非零，即使磁盘上留下 ESP，也必须视为未通过验证，不能安装到正式配置。

## 用途六：单独证明 AVIF winner

只想检查某个 base 是否真的是目标 AVIF winner，可以单独运行：

```bash
node scripts/verify-avif-winner.mjs \
  --base "/absolute/path/MyPerkMod.esp" \
  --target-avif "Skyrim.esm|0000044C" \
  --expected-winner "MyPerkMod.esp" \
  --plugin-map "/absolute/path/plugin-path-map.json" \
  --load-order "/absolute/path/plugins.txt" \
  --master-root "/absolute/path/ModOrganizer/mods" \
  --output "/absolute/path/winner-proof.json"
```

验证器会按活动 load order 扫描目标 AVIF 的覆盖链。最后一项的插件名和真实物理
路径都必须与 `--base` 相同；同名不同内容且未映射的插件会失败关闭。

## 用途七：单独核对 change-set 与补丁

已有基线和补丁的 `perk-tree-nodes.json` 时：

```bash
node scripts/verify-change-set-reparse.mjs \
  --base-nodes "/absolute/path/base/perk-tree-nodes.json" \
  --output-nodes "/absolute/path/patch/perk-tree-nodes.json" \
  --change-set "/absolute/path/change-set.json" \
  --output "/absolute/path/change-set-reparse-verification.json"
```

该步骤独立应用 change-set，再比较：

- PERK FormKey
- FNAM / Parent Required
- XNAM、YNAM、HNAM、VNAM
- SNAM / Associated Skill
- CNAM 顺序和全部连接
- 节点数、节点新增和删除

它不会调用 Mutagen，因此可作为 writer reopen 之外的独立 L4 证据。

## 验证层级与结论边界

| 层级 | 证据 | 可以声称 |
|---|---|---|
| L1 | 源 SHA、AVIF/PERK 输出 | 已读取指定文件和可用 master |
| L2 | 图结构校验、节点档案覆盖率 | 当前解析的树结构有效 |
| L3 | Mutagen 写入及 reopen 比较 | writer 输出与内存模型一致 |
| L4 | 独立 Node 回读等于 change-set | 补丁实际 AVIF 与批准设计一致 |
| L5 | 最终 MO2 winner、可选 xEdit | 最终 profile 中该记录胜出且通过对应检查 |
| L6 | 绑定补丁 SHA 的游戏截图/录屏 | 游戏运行时 UI 已验证 |

较低层级不能替代较高层级。尤其注意：

- 能启动游戏不代表技能树正确。
- writer 成功不代表最终 load order 正确。
- `origin-only` 不代表 winning override。
- xEdit `Check for Errors` 和游戏截图不由本项目自动提供。
- 未展开的 VMAD/Papyrus 和未映射 CTDA 必须继续标记为未解析。

## 运行自带测试

纯 Node 测试：

```bash
node scripts/test-change-set-reparse.mjs
node scripts/test-merge-workflow.mjs
node scripts/test-perk-tree-labels.mjs
```

构建固定依赖的 Mutagen writer：

```bash
dotnet restore writer/SkyrimPerkTreeWriter/SkyrimPerkTreeWriter.csproj --locked-mode
dotnet build writer/SkyrimPerkTreeWriter/SkyrimPerkTreeWriter.csproj \
  --configuration Release \
  --no-restore
```

使用真实 ESP 运行隔离写入冒烟测试：

```bash
node scripts/test-mutagen-add-node.mjs \
  --base "/absolute/path/Vokriinator_SCSI_MaoTan_NewTrees.esp"
```

该测试在系统临时目录创建并删除输出，不覆盖 base，并同时验证：

- 正确 winner 可以写入。
- 非 winner base 会被拒绝。
- `addNode` 和 `connect` 能被独立回读确认。
- 篡改后的 change-set 与输出不一致时会被拒绝。
- 源文件 SHA 在测试前后保持不变。

## 常见失败

### `origin-only` 或大量 PERK 未解析

缺少完整 `plugins.txt`、master 路径、路径映射或本地化字符串。几何仍可读取，但
不要把名称、条件、效果或 winner 当作最终游戏值。

### `ambiguous-different-content`

发现多个同名但 SHA 不同的插件。为该文件在 `plugin-path-map.json` 中指定实际
启用的绝对路径，不要依赖目录遍历顺序。

### `Frozen analysis contexts differ`

两份基线使用了不同的 load order、路径映射、语言、master roots 或物理插件版本。
冻结同一个 MO2 profile 后重新生成两份基线。

### `target-tree-unmatched`

incoming 的 stable AVIF FormKey 在 base 中不存在。不能仅凭相同 EDID 或显示名跨树
拼接；需要先明确目标 AVIF 和完整的新增/映射策略。

### `Output already exists`

工作流默认拒绝覆盖。选择一个新的输出 ESP 名称和新的 verification 目录。

### 写入成功但独立回读失败

该补丁没有达到 L4。保留报告用于排查，但不要安装或声称补丁已构建。

## 进一步文档

- [Skill 执行规则](SKILL.md)
- [完整工作流与证据层级](references/workflow.md)
- [Mutagen writer 契约](references/mutagen-writer-contract.md)
- [change-set Schema](schemas/change-set.schema.json)
- [merge-decision Schema](schemas/merge-decision.schema.json)
- [perk-tree-details Schema](schemas/perk-tree-details.schema.json)
