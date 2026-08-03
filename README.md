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
- 在写入前对两棵待合并技能树进行逐 PERK 对比，生成重复/冲突/导入候选的 SVG 和详细 Markdown 评审。
- 以与评审报告 SHA 绑定的用户决策作为首次合并门禁；写后重新出图和说明，并等待最终确认。

## 安装要求

- Codex
- Node.js 18 或更高版本
- 创建补丁 ESP 时需要 .NET SDK 9 或更高版本

只进行技能树读取、SVG、JSON 和 Markdown 生成时不需要安装 npm 依赖。

### macOS：安装 .NET 9

Homebrew 的 `dotnet@9` 是 keg-only。安装后将其链接到 Homebrew 的公共命令路径：

```bash
brew install dotnet@9
brew link --force dotnet@9
dotnet --version
```

项目锁定到 .NET 9 与 `Mutagen.Bethesda.Skyrim` 0.54.2；不要用未锁定的依赖恢复
代替下方的开发验证。

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

## 两个 Mod 技能树合并

先对两个 ESP 分别运行只读工作流，且使用同一个冻结的 MO2 profile、`plugins.txt`
和 `plugin-path-map.json`。然后生成合并评审，不会写入任何 ESP：

```bash
node scripts/analyze-perk-tree-merge.mjs \
  --base-details "/analysis/base/perk-tree-details.json" \
  --incoming-details "/analysis/incoming/perk-tree-details.json" \
  --output "/analysis/merge-review"
```

将 `perk-tree-merge-analysis.svg` 和 `.md` 交给用户。只有用户逐项确认后，才用
下列命令校验已批准的 `merge-decision.json`，再生成 change-set 和新补丁：

```bash
node scripts/validate-merge-decision.mjs \
  --analysis "/analysis/merge-review/perk-tree-merge-analysis.json" \
  --decision "/analysis/merge-decision.json"
```

写后必须对输出补丁重新运行只读工作流、出图和生成完整说明；这些写后产物仍须等
用户最终确认。详情见 `references/workflow.md`。

对于确认导入的独有节点，change-set 使用 `addNode` 加入稳定 PERK FormKey、坐标
和 Parent Required，再以显式 `connect` 重建获批准的连接。该 PERK 必须来自基树
插件或它已有的 master；工具不会暗中添加新的主文件依赖。

## 开发验证

先恢复锁定的 NuGet 依赖，再构建 writer：

```bash
dotnet restore writer/SkyrimPerkTreeWriter/SkyrimPerkTreeWriter.csproj --locked-mode
dotnet build writer/SkyrimPerkTreeWriter/SkyrimPerkTreeWriter.csproj --configuration Release --no-restore
```

以下合成测试验证双树分类、用户决策完整性，以及错误的分析 SHA 会被拒绝：

```bash
node scripts/test-merge-workflow.mjs
```

在具备已验证基线 ESP 的机器上，运行隔离的 `addNode` 烟测。它只在临时目录创建
补丁，并验证 Mutagen reopen 与独立 Node 回读；不会修改基线文件：

```bash
node scripts/test-mutagen-add-node.mjs \
  --base "/absolute/path/to/verified-winner.esp"
```

该烟测证明 L3 写回与 L4 独立回读，不替代最终 MO2 load order、SSEEdit 或游戏内
验证。
