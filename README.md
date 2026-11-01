# Jobfill

根据自己的资料核对网申表单、填写有明确来源的字段，并检查页面读回结果。

Jobfill 包含一个项目级 Codex Skill 和 Node.js 批量执行工具。它使用 [Huashu Chrome](https://github.com/alchaincyf/huashu-chrome) 连接用户自己的 Chrome，由 Agent 观察页面、确定字段与资料的对应关系，再通过工具执行和核验。

## 能做什么

- 读取用户提供的 Markdown 资料，按学校、公司或项目的身份对应经历。
- 对照已有值和空字段，批量填写来源明确、控件支持的内容；异常项保留待处理。
- 汇总页面读回结果，让用户检查后自己保存或提交。

不同招聘网站和控件的结构会变化。填写计划需要结合当前页面生成，复杂弹层、日期、附件和多选可能需要人工或浏览器工具处理。一次字段读回成功不代表网站已经保存，也不代表整份申请已完成。

## 准备

1. 安装 Node.js 22.19 或更新版本；本仓库的本地回归在 Node.js 24.14.1 运行。运行脚本只使用 Node 内置模块。
2. 安装并配置 [Huashu Chrome](https://github.com/alchaincyf/huashu-chrome)，按其说明连接自己的 Chrome。运行 `npx huashu-chrome doctor` 检查桥接和扩展状态。安装命令可能更改本机 Agent 的 MCP 配置，请先阅读该项目说明。
3. 克隆本仓库，在 Codex 中以仓库根目录打开项目。项目级 Skill 位于 `.agents/skills/fill-job-application/SKILL.md`。在会话中指定使用 `$fill-job-application`；若没有出现，可重新打开项目并检查是否存在同名 Skill。有关项目级 Skill 的发现方式见 [OpenAI 文档](https://developers.openai.com/codex/skills/)。
4. 将 [资料示例](examples/profile.example.md) 复制到本地 `data/profile.md`，用本人确认的信息填写，并在会话中提供资料路径和当前网申页面。不要把真实资料提交到仓库。

示例提示：

> 使用 $fill-job-application，根据 data/profile.md 核对并填写我当前打开的招聘页面；先保留有冲突的已有内容，填写后列出需要我检查的项目。

Skill 会根据当次授权和页面状态组织工作；它不会替用户点击网站的保存、下一步或提交，也不会默认修改用户的资料或投递跟进表。

## 资料与请求

资料格式参见 [profile.example.md](examples/profile.example.md)：Markdown 中包含一个 `jobfill: 1` JSON 块；经历记录使用组内唯一的 `identity`。未知事实留空。

可单独检查资料解析：

```powershell
node tools/profile-converter.js data/profile.md data/profile.profile.json
```

输出的 JSON 含个人资料，应仅保存在本机。批量请求的字段结构见 [request.example.json](examples/request.example.json)。该示例使用虚构地址和选择器，仅解释格式；Agent 必须根据当前页面观察生成自己的请求，然后从仓库根目录执行：

```powershell
node tools/jobfill-batch-cli.js --request-file data/request.json
```

请求与报告都可能包含个人信息。不要把真实资料、请求、报告、浏览器配置或截图提交到 GitHub。`data/` 已列入 `.gitignore`，但请自行检查其他存放位置。Agent 和浏览器工具会读取所需资料，其数据处理取决于使用的服务与配置。

## 结果与边界

- `attempted` 表示本次写入后读回匹配；`skipped_existing` 表示已有值与目标匹配。
- `pending`、`unsupported`、`blocked`、`write_unverified` 需要继续检查或处理；进程退出成功不代表整页完成。
- 页面已有值与资料冲突、来源不清、记录无法唯一匹配时，保留现值并交用户确认。不能把未知事实补成确定事实。
- 网页可能自动保存或发生联动；请以页面和网站实际状态为准。验证码、协议、网站保存与最终提交由用户处理。

本项目不是独立 Chrome 扩展；`extension/` 中仅保留供脚本调用的解析和控件模块。批量运行依赖 Huashu Chrome bridge，当前包的本地回归不能证明任意真实网站均可用。

## 本地回归

```powershell
node tests/profile-converter.cjs
node tests/semantic-mapper.cjs
node tests/site-hints.cjs
node tests/tab-resolver.cjs
node tests/huashu-bridge.cjs
node tests/widget-executor.cjs
node tests/jobfill-independent-checker.cjs
node tests/jobfill-runtime.cjs
node tests/jobfill-cli-process.cjs
```

这些测试使用虚构资料或模拟桥接，不会提交真实网申。另用虚构资料在本地测试页面验证过真实 Chrome 与 Huashu Chrome 的连接、一个普通文本框的填写及页面读回；招聘网站和复杂控件的兼容性仍须以实际页面为准。

## 致谢

浏览器交互依赖 [Huashu Chrome](https://github.com/alchaincyf/huashu-chrome)；控件识别和操作思路曾参考 [auto-ws](https://github.com/happy-q123/auto-ws)。

本仓库尚未指定开源许可证；需要再分发或二次使用时，请先联系项目所有者确认授权。
