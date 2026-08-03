# Skyrim 技能树精确读取、文档化与 Mutagen 编辑工作流

## 1. 证据层级

| 层级 | 所需证据 | 允许的结论 |
|---|---|---|
| L1 静态读取 | 源 SHA、AVIF/PERK 输出 | 已读取指定文件与可用 master |
| L2 结构校验 | 图校验、节点档案覆盖率 | 树结构有效，缺失项已明确 |
| L3 Mutagen 写回 | 新补丁、writer reopen 比较 | Mutagen 写出的目标 AVIF 与内存模型一致 |
| L4 独立回读 | Node 解析结果等于 change-set | 补丁实际图与批准设计一致 |
| L5 负载/xEdit | 最终 winner、可选 Check for Errors | 最终 profile 中目标记录有效 |
| L6 游戏验证 | 对应补丁 SHA 的截图/录屏 | 运行时 UI 已验证 |

任何层级不能替代下一层。Windows 不是 L3/L4 的前提，仅在选择 SSEEdit 或
运行 Windows 版 Skyrim 验证时使用。

## 2. AVIF 与 PERK

布局位于 `AVIF`：`PNAM` PERK、`FNAM` 父级要求、`XNAM/YNAM` 网格、
`HNAM/VNAM` 偏移、`SNAM` Actor Value、`CNAM` 目标索引、`INAM` 当前索引。
显示坐标为：

```text
logicalX = maxGridX - XNAM - HNAM
logicalY = YNAM + VNAM
```

`PNAM=NULL, INAM=0` 是不可见根。连接方向只以 CNAM 为准。名称、描述、
rank、Next Perk、获取条件和效果位于 `PERK`，不可从几何推断。

## 3. 状态机

```text
CREATED -> PROFILE_FROZEN -> WINNERS_RESOLVED -> TWO_BASELINES_PARSED
-> TWO_BASELINES_VALIDATED -> MERGE_ANALYSIS_RENDERED -> USER_REVIEWED
-> DECISION_HASH_VALIDATED -> CHANGESET_PROPOSED -> CHANGESET_APPROVED
-> MUTAGEN_PATCH_WRITTEN -> MUTAGEN_REOPENED -> PATCH_REPARSED
-> POST_MERGE_RENDERED -> USER_FINAL_CONFIRMED
-> LOAD_ORDER_VALIDATED -> XEDIT_VALIDATED(optional) -> RUNTIME_VERIFIED
```

## 4. 基线

1. 记录目标绝对路径、大小、mtime、SHA-256。
2. 固定 MO2 profile、活动 plugins.txt 与相关 master 版本。
3. 对 MO2 同名文件使用 plugin-path-map；不同 SHA 时禁止按目录猜 winner。
4. 确认目标 AVIF 的 winning plugin。
5. 运行 `run-readonly-workflow.mjs`。
6. 检查单根、重复 INAM、悬空 CNAM、自环、环路和不可达节点。
7. 逐节点检查 `perkResolution`：`origin-record-only`、
   `winning-override-from-complete-load-order`、
   `best-known-record-from-incomplete-load-order`、`unresolved` 或
   `invisible-root`。

Master 缺失不否定目标插件内已有的几何，但名称、描述、条件和最终覆盖结论
必须保持未解析。

## 5. 文档产物

用 `generate-skill-tree-manual.mjs` 从 `perk-tree-details.json` 生成 Markdown。
每个可见节点至少列出：

- 树、INAM、PERK FormKey、EDID、名称和描述；
- 网格、偏移、逻辑坐标、入边、出边、Parent Required；
- level/rank/Next Perk；
- 顶层获取 CTDA、每个效果及效果 CTDA；
- 解析状态、覆盖链和明确的缺失原因。

生成器以 summary 的 visibleNodes 为闭合校验，漏一个节点即失败。

## 6. 双 Mod 合并评审与首次确认

对两个待合并插件都执行第 4 节的基线步骤，并且必须使用同一个冻结的 MO2
profile、`plugins.txt`、`plugin-path-map.json` 和 master 路径。分别保留：原始
SVG、每树 SVG、`perk-tree-details.json` 和完整说明。

随后执行 `analyze-perk-tree-merge.mjs`。它产生合并评审 SVG、Markdown 和 JSON：

- 同一稳定 `PERK FormKey` 是 `exact-duplicate`：默认保留基树，禁止重复导入；
- FormKey 不同但所有已解析 PERK 证据指纹相同是 `equivalent-review`：仍由用户决定；
- 同 EDID/名称而证据不同是 `semantic-conflict`：只能手工决定，禁止自动覆盖；
- 独有/邻近节点是候选，必须逐项审查坐标、CNAM、入边、`FNAM` 与 PERK 条件；
- 任一侧 winner 未验证、PERK 未解析或跨 AVIF 未指定目标，保持未决，禁止写入。

先交付图和完整逐项分析，等待用户确认或修改。将用户确认保存为
`merge-decision.json`，它必须列出每一个待并入节点，并绑定分析 JSON 中的
`analysisSha256`。`validate-merge-decision.mjs` 必须通过；`manual`、遗漏、重复
决策或 SHA 不符均失败关闭。

## 7. 提案与合并写入

change-set 使用 schema v2 和稳定 FormKey `Plugin.ext|00ABCDEF`。必须包含：

- `basePlugin` 与精确 `baseSha256`；
- `expectedWinnerPlugin`；
- `targetAvif`；
- `outputPlugin`；
- 明确的 `moveNode`、`connect`、`disconnect`、
  `updateParentRequired`、`removeNode` 或 `addNode` 操作。

`addNode` 只用于用户已批准的独有节点：必须声明新 INAM、stable PERK FormKey、
XNAM/YNAM/HNAM/VNAM 和 Parent Required；源树 CNAM 必须转换为单独、明确的
`connect` 操作。PERK FormKey 只能属于已验证 base 或它已经声明的 master，不能
靠写入时暗中新增依赖。

用户批准前提供原图、拟议图、机器 diff、受影响记录和未解析项。

在通过首次确认后，由批准选择生成精确 change-set。现有 writer 的每项操作仍须
符合 schema：不会依据名称或坐标猜测记录，不会覆盖源插件，也不会在未指定目标
AVIF 时跨树合并。

## 8. Mutagen 写补丁

严格遵循 `mutagen-writer-contract.md`：

1. 用 `SkyrimMod.CreateFromBinaryOverlay` 只读打开已验证 winner。
2. 校验 SHA、文件名、target AVIF 和节点索引。
3. `DeepCopy()` 目标 AVIF 到新 `SkyrimMod`。
4. 只修改 change-set 声明的强类型字段。
5. 由 `Mutagen.Bethesda.Skyrim` 写到隔离临时目录中的同名 `.esp`。
6. Mutagen 重新打开临时补丁，逐节点比较 PERK、FNAM、坐标、技能和连接。
7. 仅在比较成功后移动为最终新文件；拒绝覆盖现有输出。
8. 重算源 SHA，确保源文件未变化。

这不是自制 ESP writer：TES4/GRUP、record size、master index 和二进制编码均
由 Mutagen 处理。

## 9. 写后验证与最终确认

1. `run-mutagen-write-workflow.mjs` 自动用独立 Node 解析器回读输出。
2. 比较节点数、全部坐标、FNAM、CNAM、结构错误和批准的 change-set。
3. 对补丁重新生成 affected-tree SVG、完整手册、机器 diff 和合并结论，交给用户。
4. 等待用户最终确认或进一步修改；未确认时保持在 `POST_MERGE_RENDERED`。
5. 把用户最终确认的补丁放到最终 MO2 profile，确认它是 target AVIF winner。
6. 可选：SSEEdit `Check for Errors` 并保存报告。
7. 进游戏逐棵受影响技能树截图；记录补丁 SHA 和 load order。

## 10. 失败关闭

- 源或 change-set SHA 不符：不写。
- winning AVIF 未证明：只读分析，不写。
- output 已存在或等于 source：拒绝。
- target/node 不存在、连接重复/缺失、结果有悬空连接：拒绝。
- Mutagen reopen 不一致：删除临时输出并失败。
- 独立回读不一致：不进入负载顺序验证。
- `winningOverrideVerified=false`：不得描述成最终游戏值。
- 未经首次用户确认、decision 未覆盖所有待并入节点、analysis SHA 不一致，或仍有
  `manual` 决策：不得生成/执行合并 change-set。
- 写后图、手册与独立回读未交给用户最终确认：不得称合并完成或 runtime-verified。
- 游戏截图缺失：不得称 runtime-verified。

## 10. 公开依据

- Mutagen 读写文档：<https://mutagen-modding.github.io/Mutagen/>
- Mutagen 写入 Mod 文档：<https://mutagen-modding.github.io/Mutagen/writing-mods/>
- Mutagen load order / winning override：<https://mutagen-modding.github.io/Mutagen/load-order/>
- xEdit TES5 AVIF 定义：<https://github.com/TES5Edit/TES5Edit/blob/fd1e36020b2b5b6217e553dc0038983146a2e2dd/Core/wbDefinitionsTES5.pas#L6184-L6225>
- xEdit TES5 PERK/CTDA 定义：<https://github.com/TES5Edit/TES5Edit/blob/dev-4.1.5/Core/wbDefinitionsTES5.pas#L8010-L8119>
- xEdit conflict/winner：<https://tes5edit.github.io/docs/5-conflict-detection-and-resolution.html>
