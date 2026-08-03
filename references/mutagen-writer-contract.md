# 跨平台 Mutagen writer 契约

## 范围

writer 只为一个已批准的 AVIF change-set 创建新补丁 ESP。它不修改源插件，
不编辑 PERK 游戏逻辑，也不实现 Bethesda 二进制格式。

## 固定实现

- .NET 9；
- `Mutagen.Bethesda.Skyrim` 0.54.2；
- 版本由 csproj 与 `packages.lock.json` 双重固定；
- 支持 macOS、Linux、Windows 的 `dotnet` CLI。

## 输入门

1. `--base` 存在且是已验证 winning AVIF 所在插件。
2. `basePlugin`、`expectedWinnerPlugin` 均等于基线文件名。
3. 实际 SHA-256 等于 `baseSha256`。
4. `targetAvif` 是稳定 FormKey。
5. `outputPlugin` 等于 `--output` 文件名；输出必须是不存的新 `.esp`。
6. change-set schema 版本必须为 2，至少一个操作。
7. 编排器必须在启动 writer 前读取完整 `plugins.txt` 与
   `plugin-path-map.json`，解析 target AVIF 的活动覆盖链，并生成内容带 SHA 的
   `winner-proof.json`；最后 winner 的物理路径必须等于 `--base`。

## 写入语义

1. 以 Mutagen binary overlay 只读打开基线。
2. 找到 target AVIF，拒绝重复 INAM。
3. 通过 Mutagen `DeepCopy()` 创建 AVIF override。
4. 只允许：移动节点、增删有向连接、修改 Parent Required、删除节点，或新增一个
   显式给出 stable PERK FormKey 的节点。
5. 新节点的 PERK 必须来自已验证 base plugin 或它已经声明的 master；writer 不会
   静默添加依赖。新增节点继承该 AVIF 现有节点的 Associated Skill，所有 CNAM 必须
   由后续明确 `connect` 操作给出。
6. 所有引用节点必须存在；connect 不得重复；disconnect 必须原本存在。
7. 删除节点时同步移除指向它的 CNAM；结果不得有悬空连接。
8. 新插件只加入这一条 AVIF override。
9. 由 Mutagen 写临时同名 `.esp`，绝不写源路径或已有输出。

## 写后提交门

writer 必须用 Mutagen 重新打开临时输出，并验证：

- 恰好一条 AVIF override；
- stable FormKey、节点数和 INAM 一致；
- 每个节点的 PERK、FNAM、网格、偏移、Associated Skill 和 CNAM 一致。

全部通过后才移动到最终新路径，并返回 source/output SHA、Mutagen 版本、
目标 AVIF、操作数、节点数和连接数。编排器随后再用独立 Node 解析器回读。
独立回读必须从解析后的基线应用 change-set，再逐节点比较 PERK、FNAM、坐标、
Associated Skill 和 CNAM，生成 `change-set-reparse-verification.json`；仅做图结构
校验不足以达到 L4。

## 不成立的结论

writer 成功不代表最终 load order 正确、SSEEdit 全局无错误、Papyrus 语义已
验证或游戏 UI 已显示正确。这些必须分别取证。
