# Windows / xEdit 可选验证契约（已被 Mutagen writer 取代）

> v0.3.0 起，本文件不再定义主要写入路径。跨平台写入必须使用
> `mutagen-writer-contract.md`。本页仅保留给选择 SSEEdit `Check for Errors`
> 的后续验证；不能把 xEdit 缺失当作 Mutagen 创建补丁的阻塞条件。

## 目的

下列旧 worker 接口仅用于兼容历史自动化。新 Agent 不应据此创建补丁。

## 输入

Worker 接收一个 JSON 对象：

- `requestId`：调用唯一标识。
- `basePluginPath`：源插件路径，只读。
- `baseSha256`：源文件哈希。
- `outputPatchPath`：必须是不存在的新路径。
- `loadOrder`：按实际顺序列出的插件名和 SHA-256。
- `changeSet`：符合 `schemas/change-set.schema.json`。

## 前置检查

Worker 必须：

1. 确认 Windows、xEdit/SSEEdit 版本并记录。
2. 验证源 SHA-256 和 change-set 中的 `baseSha256`。
3. 拒绝让 `outputPatchPath` 与任何输入插件相同。
4. 按提供的 load order 加载，并确认 `expectedWinner`。
5. 若任一步失败，返回非零结果且不留下半成品。

## 写入语义

- 只创建新补丁，复制 winning AVIF override 后修改。
- Stable FormKey 转为当前会话 FormID 时必须核对 master 索引。
- 修改位置时保留未指定字段。
- 修改边时保持 `CNAM` 顺序可重复。
- 除 change-set 声明的记录外不得产生覆盖。
- 保存应使用临时文件加原子替换；源文件永不写入。

## 输出

输出 JSON 必须包含：

- `requestId`
- `status`: `success` 或 `failed`
- `xeditVersion`
- `outputPatchPath`
- `outputSha256`
- `winningOverrides`
- `appliedOperations`
- `warnings`
- `logPath`

成功后仍只是“补丁已写出”，不是“补丁有效”或“游戏已验证”。

## 独立验收

Codex 随后必须：

1. 用只读解析器重读输出补丁；
2. 对比实际图与 change-set；
3. 在最终 load order 中运行 `Check for Errors`；
4. 保存 xEdit 报告；
5. 进行游戏内截图验证。
