<div align="center">

# Jobfill

### 一份资料，多次复用；填写之后，核对结果。

让 Agent 根据你的资料核对网申页面，填写有依据的字段，<br>
并把未完成和需要确认的地方清楚交还给你。

[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Codex Skill](https://img.shields.io/badge/Codex-Agent%20Skill-333333)](https://developers.openai.com/codex/skills/)
[![Huashu Chrome](https://img.shields.io/badge/Browser-Huashu%20Chrome-4285F4?logo=googlechrome&logoColor=white)](https://github.com/alchaincyf/huashu-chrome)

[快速开始](#快速开始) · [工作方式](#工作方式) · [验证与边界](#验证与边界)

</div>

```bash
git clone https://github.com/K0848/jobfill.git
```

> **使用前提：** Node.js、Codex 和已连接自己 Chrome 的 [Huashu Chrome](https://github.com/alchaincyf/huashu-chrome)。按已有授权完成填写、核对和模块保存，最终提交由你确认。

## 为什么做 Jobfill

投递不同公司的岗位时，同一份教育、实习和项目经历往往要反复填写。网页自动解析也可能漏字段、填错位置，或者把不同经历混在一起。

Jobfill 基于你准备的一份 Markdown 资料，由 Agent 结合**当前页面**生成填写计划。批量工具检查资料来源、目标字段和页面读回结果；不确定的部分留给你处理。

| 网申中常见的问题 | Jobfill 如何处理 |
| --- | --- |
| 同一份经历反复输入 | 复用用户提供的 Markdown 资料，缺少依据的字段留空。 |
| 多条学校、公司或项目容易填串 | Agent 按经历身份核对；计划提供记录身份时，工具会校验是否与资料对应。 |
| 页面已有内容不确定是否正确 | 比较页面现值与资料；有冲突时保留现值，列入待确认。 |
| 点了填写却不知道是否生效 | 读取页面结果，分别报告已匹配、待确认、未支持和未验证等状态。 |

## 工作方式

```mermaid
flowchart LR
    A["个人 Markdown 资料"] --> B["Agent 观察页面<br/>并生成填写计划"]
    C["Chrome 当前网申页面"] --> B
    B --> D["Jobfill 批量执行"]
    D --> E["页面读回<br/>与结果报告"]
    E --> F["按授权保存模块<br/>用户确认最终提交"]
```

- **资料来源：** 使用你指定的文件，支持基本信息、教育、工作、项目等记录。经历通过 `identity` 区分；缺少依据的字段应保持空白。
- **页面操作：** 通过 Huashu Chrome 使用你自己的浏览器；普通字段和部分已适配控件可交给批量工具，复杂或不确定的控件需要进一步检查。
- **结果核对：** `attempted` 表示本次写入后读回匹配；`skipped_existing` 表示已有值与目标匹配。`pending`、`unsupported`、`blocked` 和 `write_unverified` 需要继续检查。
- **人工接管：** 资料冲突、选项歧义或无法可靠读回时，保留问题供用户确认。网页可能自动保存或联动，实际状态以页面为准。

## 快速开始

### 1. 准备环境

安装 Node.js 22.19 或更新版本，并按 [Huashu Chrome 的安装说明](https://github.com/alchaincyf/huashu-chrome)配置浏览器连接。安装过程可能修改本机 Agent 的 MCP 配置，请先阅读该项目说明。

```powershell
npx huashu-chrome doctor
```

确认桥接和浏览器扩展在线后，克隆本仓库并进入目录：

```powershell
git clone https://github.com/K0848/jobfill.git
cd jobfill
```

### 2. 准备自己的资料

运行初始化命令，生成本机资料和个人配置模板；重复执行会保留已有文件，不覆盖个人内容：

```powershell
node tools/init-local.cjs
```

编辑 `data/profile.md`，把[虚构示例](examples/profile.example.md)替换为本人**已经确认**的信息，未知字段留空。编辑 `data/personal-workflow.md` 配置个人偏好；如需 Excel 跟进，填写本人工作簿路径并确认自动更新授权和状态口径。未配置跟进表不影响网页填写。不要直接用虚构示例申请岗位。

资料中需包含一个 `jobfill: 1` JSON 块。每条教育、工作或项目记录使用组内唯一的 `identity`；详细格式可直接参考示例。

如需单独检查资料解析：

```powershell
node tools/profile-converter.js data/profile.md data/profile.profile.json
```

生成的 JSON 包含个人信息，请留在受保护的本机位置。

### 3. 在 Codex 中开始

在 Codex 中以本仓库为项目根目录，打开你的招聘表单，并在会话中说明资料路径。例如：

> 使用 $fill-job-application，根据 data/profile.md 核对并填写我当前打开的招聘页面；先保留有冲突的已有内容，填写后列出需要我检查的项目。

项目级 Skill 位于 [`.agents/skills/fill-job-application/SKILL.md`](.agents/skills/fill-job-application/SKILL.md)。如果 Skill 未出现，可重新打开项目并检查是否存在同名 Skill。

执行流程只维护在上述公开 Skill 中；它会读取本机配置 `data/personal-workflow.md` 中的路径、偏好和已确认授权。该配置不复制执行步骤。本机别名入口先读取配置，再引用同一个公开 Skill。需要 `.codex`、`.claude`、`.workbuddy-ai` 入口时，先完成上述初始化，再在具备软链接权限的 Windows PowerShell 中运行：

```powershell
./tools/convert-skill-links.ps1
```

脚本既可创建缺失入口，也可转换已有同源硬链接；不覆盖内容不同的文件。这些入口只在本机生成，不随仓库分发。复制或移动整个仓库后需重新核对入口目标。

## 一次填写的结果是什么样的？

以下是一次**本地测试页面**的精简结果：使用虚构资料，通过真实 Chrome 和 Huashu Chrome 写入一个普通文本框，再读取页面中的值。

```json
{
  "profileValidated": true,
  "snapshotCaptured": true,
  "items": [
    {
      "pageLabel": "姓名",
      "value": "示例姓名",
      "status": "attempted",
      "readback": "matched"
    }
  ]
}
```

这说明该测试字段写入后读回匹配。实际网申的页面结构、控件和保存方式可能不同，**不能把一个字段的成功当作整份申请已完成**。

Agent 根据页面观察生成批量请求；请求结构可参考 [request.example.json](examples/request.example.json)。示例中的网址、标签和选择器均为虚构内容，不能直接用于真实申请。准备好自己的请求后，可在仓库根目录运行：

```powershell
node tools/jobfill-batch-cli.js --request-file data/request.json
```

## 隐私与操作边界

- 仓库只提供工具和虚构示例。请勿提交真实资料、请求、报告、浏览器配置、凭据或网申截图。
- `.gitignore` 默认忽略未列入公开白名单的本地文件；新增公开文件需审查后放行。已被 Git 跟踪的文件仍需在提交前检查内容。
- 公开内容包含运行模块、站点规则、虚构模板、测试和使用说明。真实简历与附件、联系方式、证件信息、家庭及经历资料、薪资和城市偏好、投递表、浏览器身份及 token、填写请求和报告、截图、备份均属于私人或本机内容，放在 `data/` 或项目外，不加入公开白名单。忽略规则不会清除历史提交，也不会自动清除已跟踪文件中的个人信息。
- Agent 和浏览器工具会读取所需资料，数据处理取决于所用服务与配置。
- 保存、下一步、预览、附件和跟进表操作以当前指令或本机配置中的已确认授权为准，授权范围内不逐次询问；未经授权不执行。默认不修改长期个人资料，不生成跟进表备份。验证码与缺少事实依据的声明由用户处理；最终提交、投递和邮件发送须本次明确授权。
- 本项目以 Codex Skill 和 Node.js 脚本协同工作；`extension/` 是脚本使用的模块集合，不是可独立安装的 Chrome 扩展。

## 验证与边界

### 多聊天更新投递跟进表

经用户授权后，统一使用 `tools/update-job-tracker.py` 更新 Excel，避免不同聊天用旧快照互相覆盖。该入口需要 Windows 和 Python 3，仅依赖标准库；写入前取得跨进程锁，随后读取最新文件、按岗位去重并读回真实超链接。只维护公司、岗位、链接、状态，保留其他内容及格式。请求与状态口径见 [跟进表更新说明](docs/job-tracker.md)。

```powershell
python -B tests/test_job_tracker.py
```

本机个人资料与配置放在被 Git 忽略的 `data/` 中；所有用户共享同一份公开执行流程。本机配置使用 `data/personal-workflow.md`，只保存路径、偏好和已确认授权；本机各 Agent 入口可通过 `tools/convert-skill-links.ps1` 转为指向该配置的软链接，配置再引用共享 Skill。提交 Git 时只收录公开流程、工具和虚构示例，检查实际提交内容，无需另维护脱敏流程副本。

### 浏览器填写回归

本仓库包含 **9 个回归脚本**，覆盖资料解析、语义匹配、站点规则、标签定位、桥接、控件执行和批量运行。以下命令使用虚构资料或模拟桥接：

```powershell
node --test tests/profile-converter.cjs tests/semantic-mapper.cjs tests/site-hints.cjs tests/tab-resolver.cjs tests/huashu-bridge.cjs tests/widget-executor.cjs tests/jobfill-independent-checker.cjs tests/jobfill-runtime.cjs tests/jobfill-cli-process.cjs tests/init-local.cjs
```

另有上文所述的真实浏览器本地表单验证。招聘网站、日期、多选、附件和复杂弹层的兼容性取决于当前页面，未适配或无法可靠读回时应由用户检查。

## 致谢与授权

浏览器交互依赖 [Huashu Chrome](https://github.com/alchaincyf/huashu-chrome)；控件识别与操作思路曾参考 [auto-ws](https://github.com/happy-q123/auto-ws)。

本仓库尚未指定开源许可证；需要再分发或二次使用时，请先联系项目所有者确认授权。
