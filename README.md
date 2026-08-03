# Skyrim Perk Tree Workflow for Codex

这是一个用于分析和编辑《上古卷轴 5》技能树的 Codex Skill。

## 用途

- 从 Skyrim TES5/SSE 的 ESP、ESM 插件中读取 AVIF 技能树。
- 提取技能点位置、节点连接、父级要求和 PERK 引用。
- 解析 PERK 名称、描述、等级、前置条件、效果和效果条件。
- 生成技能树总览 SVG、单树 SVG、JSON 数据和完整 Markdown 说明。
- 检查重复节点、悬空连接、自环、环路和不可达节点。
- 根据 change-set 创建新的技能树补丁 ESP。
- 支持结合 MO2 插件顺序和插件路径映射分析 winning override。

## 安装要求

- Codex
- Node.js 18 或更高版本
- 创建补丁 ESP 时需要 .NET SDK 9 或更高版本

只进行技能树读取、SVG、JSON 和 Markdown 生成时不需要安装 npm 依赖。

## 安装方式

### 1. 获取项目

使用 Git：

```bash
git clone https://github.com/wangyufengsky/skyrim-perkTree-workflow.git
cd skyrim-perkTree-workflow
```

也可以从 GitHub 下载 ZIP 并解压。

### 2. 安装到 Codex

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

### 3. 指定安装目录

macOS 或 Linux：

```bash
sh scripts/install.sh "/custom/path/skyrim-perk-tree-workflow"
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\install.ps1" `
  -Destination "D:\Codex\skills\skyrim-perk-tree-workflow"
```

也可以手工将整个项目目录复制到 Codex 的 `skills` 目录。

### 4. 启用

安装完成后重启 Codex，然后在任务中调用：

```text
$skyrim-perk-tree-workflow 解析这个 ESP 的技能树并生成 SVG 和完整技能点说明
```
