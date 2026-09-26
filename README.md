# Kando

Kando 读作「看到」。它是一块看板：你在上面记下要做的事，交给 Claude Code 或 Codex 去执行，每个任务在独立的 worktree 里跑，互不干扰，你随时能看到每一个的进度和结果。英文读者会把它读成 can do，这也没错。

任务与自由会话并行的多 agent 管理工具。任务适合**记下标题 → 完善详情 → 交给 Claude Code / Codex 在独立 worktree 中执行**；自由会话适合持续聊天及在两个 agent 之间移交。

```
未执行 pending ──执行──▶ 执行中 running ──退出──▶ 待验收 review ──接受──▶ 已完成 done
                                                        │
                                                        ├──继续修改──▶ 执行中（同一个 worktree）
                                                        └──重做──▶ 已废弃 abandoned ＋ 新建一个继承它的任务（未执行）
```

## 架构

```
┌──────────── 客户端（可以有多个）────────────┐
│  desktop  Electron + React + xterm.js     │
│  cli      kando add / ls / edit / run ... │
└────────────────┬───────────────────────────┘
                 │ JSON-RPC 2.0 over WebSocket（127.0.0.1 + token）
┌────────────────▼───────────────────────────┐
│  core    纯 Node 服务，不依赖 Electron       │
│   ├─ TaskStore / ConversationStore  持久化 │
│   ├─ TaskService   状态流转、worktree、启动 │
│   ├─ ConversationService  会话与移交       │
│   └─ RpcServer     推送 changed 等          │
└────────────────┬───────────────────────────┘
                 │ NDJSON over Unix socket / named pipe
┌────────────────▼───────────────────────────┐
│  daemon  持有所有 PTY（node-pty）            │
│          core / 桌面端重启，agent 不会断     │
└────────────────────────────────────────────┘
```

| 包 | 职责 |
|---|---|
| `packages/protocol` | 唯一的类型来源：Task / Conversation 模型、状态流转规则、RPC 方法与通知的 zod schema、客户端。`/node` 子入口放路径、端点发现、daemon 协议 |
| `packages/core` | 独立的任务与自由会话存储及业务逻辑；任务创建 git worktree；通过 daemon 启动 agent CLI |
| `packages/daemon` | PTY 宿主，独立进程，缓存最近输出，供重新连接时回放 |
| `packages/cli` | 命令行客户端 |
| `packages/desktop` | Electron 桌面端：看板、详情编辑、内嵌终端 |

运行时数据在 `~/.kando/`（可用 `KANDO_HOME` 覆盖）：`kando.db`、`core.json`（端口与 token，权限 0600）、`worktrees/`、`sessions/`。

## 快速开始

需要 Node ≥ 22.13 和 pnpm 12（`npm i -g pnpm@12` 或 `brew install pnpm`）。

```bash
pnpm install
pnpm dev          # 同时启动 daemon、core 和桌面端
```

也可以分开启动，方便单独看日志：

```bash
pnpm dev:daemon
pnpm dev:core
pnpm dev:desktop
```

命令行：

```bash
pnpm kando add 重构登录模块
pnpm kando ls
pnpm kando edit 76b8 --details "拆分 AuthService，保留旧接口" --repo ~/code/api --repo ~/code/web --agent claude
pnpm kando edit 9c1e --dep 76b8   # 76b8 执行完之后才能执行 9c1e
pnpm kando run 76b8
pnpm kando continue 76b8       # 不太满意：在原来的 worktree 上开新会话接着改
pnpm kando redo 76b8 --reason "不该改表结构"   # 方向错了：废弃，新建一个继承的任务从头来
```

任务 id 可以只写前几位。执行前需要填好项目和 agent，详情可以不写（只用标题作 prompt）。

### 执行之后

agent 退出后，任务进入「待验收」，不管退出码是多少：交互式 agent 做完和中途被叫停都以 0 退出，所以退出码只作提示（非 0 或未知时显示「异常退出」「已中断」）。看过结果后三选一：

- **接受**：任务进入「已完成」，依赖它的任务这时才能执行。
- **继续修改**：在原来的 worktree 和分支上开一个新的 agent 会话，可以写下验收时发现要改的地方，agent 会按这些意见接着改；不写的话，它先总结上次做了什么，再等你的新要求。
- **重做**：把这个任务标记为「已废弃」（worktree 保留），自动新建一个继承标题、详情、项目、agent 和依赖的任务，从干净的分支开始；依赖原任务的任务改为依赖新任务。可以填一句废弃原因，细化和执行新任务时会告诉 agent，让它参考但不照搬上次的尝试。

「已完成」的任务也可以继续或重做。执行过的任务不会回到「未执行」。

### 和 agent 细化任务

任务还不清楚时，在详情页点 💬 开一个**细化会话**：agent 以只读方式启动（Claude Code 的规划模式并禁用写文件的工具、Codex 的只读沙箱），读代码、提问，和你在终端里把任务聊清楚。细化不新建 worktree 和分支，直接只读访问所选项目。商定后，它通过 Kando 提供的 MCP 工具 `propose_task_details` 提交完整的任务详情，详情页会出现方案卡片，由你选择「替换详情」「追加到末尾」或「放弃」；替换后在下次编辑前都可以撤销。细化期间任务仍是「未执行」，结束会话（退出 agent）后再 ▷ 执行。

细化时 agent 会知道每个依赖任务的状态：待验收和已完成的只告诉它改动在哪（待验收的会注明结果还没验收）（已经进了当前代码，或还在某个分支上，可以用 git 查看），让它直接读代码；未执行的附上计划（每个最多 2000 字）。需要完整内容时，它可以用同一个 MCP 服务里的只读工具 `read_task_details` 读取依赖链上任意任务的详情。

`kando mcp --task <id>` 就是这个 MCP 服务，由 Kando 在启动细化会话时自动配置，一般不需要手动运行。

### 自由会话与 agent 移交

桌面端左侧同时显示上下排列的「任务」和「会话」两组列表；任务收件箱属于任务区，两组列表各自滚动。两个入口都把用户选择的代码目录称为「项目」，都可选多个。新建自由会话只需选 Claude Code 或 Codex；不选项目时使用持久的 `~/.kando/sessions/<会话 id>/workspace/`，不会在 home 或 Kando 仓库中隐式运行。选多个项目时，第一个作为终端当前目录，其余目录通过 agent 的 `--add-dir` 开放访问；所有目录均原地使用，不创建 worktree 或分支。后续继续或移交仍使用相同的项目列表和 agent 自身的交互审批。

关闭详情或桌面窗口不会停止 agent；「停止会话」才会结束当前 PTY。退出后可只读回放 `terminal.log` 的完整记录，再点击「继续」恢复当前 provider 的原生对话（Claude session / Codex thread）。这份记录按块读取；daemon 缓存之外的输出如果在 core 离线期间丢失，会在记录中留下缺口提示。

「移交」会先在运行中时请你确认停止，然后启动另一种 agent。Kando 将已记录的可见用户消息、最终回复和本次补充说明写入 `sessions/<id>/handoffs/`，提示新 agent 阅读文件并检查当前目录、Git 状态和测试。切回曾用过的 agent 时，恢复它原来的 provider 对话，并补上它离开期间的结构化历史。隐藏推理、未暴露上下文及 provider 专属能力无法移交。Claude hooks 在提交时就保存用户消息；Codex `notify` 在 turn 完成后才提供输入与回复，因此 Codex 首次 turn 若在完成前失败，其未上报的输入可能不在结构化交接包中，仍可从终端记录核对。Kando 不从 ANSI 输出猜测消息，也不会改写你的全局 Codex `notify`；已有的根配置 `notify` 命令由本次回调继续转发。

删除会话会删除数据库记录、结构化消息、交接文件和终端日志，但**无论外部还是 Kando 托管的工作目录都会保留**，因为其中可能有唯一的工作成果。

### 多项目与依赖

- **多个项目**：执行时每个 Git 仓库各建一个 worktree，放在 `~/.kando/worktrees/<任务id>/<项目名>/`，分支名相同。只有一个项目时 agent 直接在它的 worktree 里工作；有多个时在这个父目录里工作，Kando 会在 prompt 末尾写明每个子目录对应哪个项目。普通文件夹（非 Git）只能作为任务唯一的项目目录，原地执行。
- **依赖**：依赖的任务全部「已完成」（验收通过）后才能执行，「待验收」的不算，不能形成循环。同一个 Git 仓库里恰好有一个依赖留下了分支时，新 worktree 从那个分支拉出，直接用上前置任务的改动；prompt 里也会列出依赖任务和它们的分支。

### 任务图片

截图、设计稿这类图片不放进详情，而是作为任务的**图片**属性单独保存，像依赖一样在详情页单独一行：点「＋ 添加图片」选择文件，或者直接在任务页面上粘贴（包括在详情编辑器里）、拖进来都可以；新建任务对话框里也能贴图。图片自动编号（图 1、图 2…），详情里可以写"见图 2"；点缩略图看大图，名字可以改，当作图片说明。

- **存储**：由 core 保存在 `~/.kando/attachments/<sha256>.<扩展名>`（权限 600），同一张图只存一份，重做任务时只复制引用。只接受 PNG、JPEG、GIF、WebP（不接受 SVG），单张不超过 10MB、4000 万像素；保存前会去掉 EXIF、文字块等元数据，免得位置之类的信息被发给模型。图片通过 RPC 分块传输，不会卡住终端输出。删除任务或移除图片不会删除图片文件。
- **交给 agent**：执行、继续、细化时，prompt 会按编号列出每张图片的本机路径，让 agent 开始前先查看。Claude Code 只被授权读取这几张图片（`--allowedTools Read(//…)`），不会拿到整个图片目录；Codex 会把图片直接附在第一条消息里（`--image`）。细化的 agent 回写方案时只改详情，图片属性保持不变。
- **导入的图片**：从 Jira 导入时，issue 里的图片附件也会下载下来（最多 20 张，单张 10MB，一共 50MB），显示在原文快照卡片的下方；正文里原来放图的地方写成「（图片：文件名）」。这些图片和原文一样属于外部内容：交给 agent 时它们和原文一起放在不可信数据块里，也不会通过 `--image` 附进消息。token 带权限范围但缺少 `read:attachment:jira` 时，图片下载不了，会在附件清单里注明。

命令行也能加图：`pnpm kando add 修复登录页 --image ~/Desktop/shot.png`，`pnpm kando edit 76b8 --image a.png --image b.png`。

### 任务来源与收件箱

任务除了手写，也可以从 issue 系统导入。每种系统是一个**任务来源**，目前内置 Jira；来源的接口是通用的，以后可以补充禅道等更多来源，下一步会开放成外部插件。

1. **设置**：在 设置 → 集成 → Jira 里填站点（如 `your-team.atlassian.net`）和 JQL（默认是分给你、还没完成的 issue），保存。
2. **登录**：点「登录」，按提示输入邮箱和 [API token](https://id.atlassian.com/manage-profile/security/api-tokens)（只需要读权限）。登录流程由来源驱动，界面和命令行都按同一套提示渲染：`pnpm kando source login jira` 也能在终端里登录。
3. **收件箱**：core 每 15 分钟同步一次，结果出现在左侧的收件箱里。每个 issue 可以**导入**成一个「未执行」任务，或者**忽略**（之后在「已忽略」里可以恢复）。

导入的任务详情是空的，留给你（或细化的 agent）写方案；issue 的描述、附件清单和最近 20 条评论作为**原文快照**单独保存，在任务详情里只读显示，可以「重新拉取」。交给 agent 时，原文快照被标记为**不可信的参考资料**包在 `<untrusted-source>` 里，其中的指令不会被当作你的要求。执行时分支名带上 issue key（`kando/PROJ-123-…`），Jira 靠这个把分支关联到 issue。删除导入的任务后 issue 会回到收件箱；重做出的新任务继承原任务的来源和快照。

**凭据**：设置（`~/.kando/sources.json`）里没有密钥，凭据单独存在 `~/.kando/credentials.json`（权限 600），只交给对应的来源，永远不会返回给界面或命令行，也不会交给 agent。修改站点会自动退出登录，保存的 token 不会发往新地址。没有界面的机器上可以用环境变量 `KANDO_JIRA_EMAIL` 和 `KANDO_JIRA_TOKEN`，它们优先于保存的凭据。旧版本的 `~/.kando/jira.json` 会在 core 启动时自动迁移。

```bash
pnpm kando source ls
pnpm kando source set jira site=your-team.atlassian.net
pnpm kando source login jira
pnpm kando source import jira PROJ-123 --agent claude
```

## 开发

```bash
pnpm typecheck    # 各包 tsc
pnpm test         # vitest
pnpm build        # 构建桌面端
```

## 下一步

- **agent 状态上报**：接入 Claude Code hooks / Codex notify，区分"等待输入"和"执行中"，不要靠解析终端输出
- **结果页**：待验收的任务查看 diff 和测试结果、合并分支、清理 worktree
- **打包**：桌面端启动时自动拉起 core 和 daemon，并用 electron-builder 打包
- **SSH / WSL 执行宿主**：给 git、PTY 操作加上 `hostId`
- **Windows**：`claude` / `codex` 的 `.cmd` shim 需要单独解析
