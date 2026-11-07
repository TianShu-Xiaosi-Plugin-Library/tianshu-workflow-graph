# Tianshu Workflow Graph

> 一个跑在天枢（Tianshu）里的节点图工作流引擎。
> 每个节点除了输入输出，还要回答三个问题：**谁做的、凭什么信、失败了算谁的**。

<sub>私有仓库 · 未公开授权</sub>

---

## 为什么需要它

ComfyUI 的节点是**纯函数**——张量进、张量出。这让它在算子层极致灵活，但也让它无法表达：

- 「第 7 步让一个人确认」
- 「这条路径的结果能不能重跑出一样的」
- 「上次卡在哪个节点、为什么」

TWG 把节点重新定义成**工作单元**，给每个节点补上三样东西：**确定性等级、执行证据、失败记录**。

一句话：**TWG 卖的不是「能生成」，是「能说清楚怎么来的」。**

## 架构

```mermaid
graph TB
    subgraph L1["意图层"]
        G[".twg.json 图<br/>唯一真相"]
    end

    subgraph L2["执行层"]
        S["调度器<br/>Kahn 拓扑排序 + 环检测"]
        N1["compute"]
        N2["render"]
        N3["verify"]
        N4["agent"]
        N5["human"]
        N6["service"]
        N7["memory"]
    end

    subgraph L3["证据层"]
        D[("SQLite<br/>runs / node_runs / memory")]
        DET["确定性传播<br/>路径上最弱节点"]
    end

    subgraph OUT["进程外（用户自备）"]
        X1["FFmpeg"]
        X2["HTTP API"]
        X3["LLM"]
        X4["人"]
    end

    G --> S
    S --> N1 & N2 & N3 & N4 & N5 & N6 & N7
    N1 --> X1
    N6 --> X2
    N4 --> X3
    N5 --> X4
    N1 & N2 & N3 & N4 & N5 & N6 & N7 --> D
    S --> DET
    DET --> D
```

三层职责不越界：**L1 只描述，L2 只执行，L3 只记录**。

## 四个工具

插件给天枢提供 4 个工具：

| 工具 | 作用 |
|---|---|
| `twg_help` | **不确定怎么用时先调它**——返回完整用法（何时用、op 清单、必记约束、常见组合） |
| `twg_validate` | 只校验图结构，不执行 |
| `twg_run` | 执行图，返回产物路径、各节点耗时、确定性、runId |
| `twg_runs` | 查证据账本：列最近运行，或按 runId 取完整节点记录 |

## 快速开始

### 前置

- 天枢 **4.0.2+**（实测 4.0.4）
- **FFmpeg**（TWG 不打包二进制，需自备）
  - 设 `TWG_FFMPEG` 指向 `ffmpeg.exe`，或把 `bin` 加进 PATH，或放到 `D:/Tools/ffmpeg/bin/`
  - Windows 下载：<https://www.gyan.dev/ffmpeg/builds/>（essentials build 即可）
  - 找不到时**不会静默回退**，会在第一个 ffmpeg 节点报错并给出三条解决路径

### 安装

把本仓库复制到天枢的插件目录，目录名用插件 id `twg`：

```
<TianshuData>/.rivet/plugins/twg/
```

> 实际根目录由宿主决定，也可能是 `%LOCALAPPDATA%\.rivet\plugins\`。装好后**重启天枢**，工具列表里应出现上表 4 个工具。

### 跑第一张图

```
twg_run { graph: "twg/examples/hello.twg.json" }
```

实测返回（宿主进程内，Node v24.22.1）：

```json
{
  "ok": true, "runId": "run-mw66le6w-z2av", "totalMs": 247.5,
  "order": ["intro", "solid", "title", "final"],
  "outputs": { "main": "...\\runs\\hello\\final.mp4" },
  "determinism": { "overall": "deterministic", "perOutput": { "main": "deterministic" } },
  "ledger": "written"
}
```

产物经 `ffprobe` 独立核验：h264 / 320×240 / 30 帧 / 3.000s，与图里 2s + 1s 拼接吻合。

**图文件必须在工作区内**——宿主的路径守卫会拒绝工作区外的路径。

## 模板：不用写 JSON 也能开始

`templates/` 下四个开箱能跑的图，**只改 `params`，不动结构**：

| 模板 | 做什么 |
|---|---|
| `title-card.twg.json` | 纯色背景 + 一行大字 |
| `subtitle-burn.twg.json` | 烧字幕到画面 |
| `concat-clips.twg.json` | 三段拼成一条 |
| `from-file.twg.json` | 读工作区内素材再加工（演示 `root` 语义） |

改法见 [`templates/README.md`](templates/README.md)。

## 图的写法

```json
{
  "version": "0.1",
  "id": "hello",
  "nodes": [
    { "id": "intro", "type": "compute", "op": "ffmpeg.color",
      "params": { "duration": 2, "size": "320x240", "rate": 10, "color": "teal" } },
    { "id": "title", "type": "render", "op": "ffmpeg.drawtext",
      "inputs": ["intro"], "params": { "text": "TWG", "size": 40 } },
    { "id": "gate", "type": "verify", "op": "verify.media",
      "inputs": ["title"], "params": { "minDuration": 1.5 } }
  ],
  "outputs": { "main": "gate" }
}
```

- `root` 声明 `params.path` 的基准：`"workspace"`（默认，相对会话工作区）或 `"graph"`（相对图文件目录）。**分享图时写 `"graph"`**，否则换个工作区就找不到素材
- `inputs` 声明依赖，引擎做拓扑排序并**检测环**
- `outputs` 是产物的命名出口
- 图是纯文本，可 diff、可 review、可进 git

## 节点类型（11 个 op）

| 类型 | op | 确定性 | 说明 |
|---|---|---|---|
| compute | `ffmpeg.testsrc` / `ffmpeg.color` | deterministic | 生成测试图案 / 纯色素材 |
| compute | `ffmpeg.input` | deterministic | 读基准目录内的素材（`path` 基准由 `root` 决定；`start`/`duration` 做时间裁剪；带符号链接守卫） |
| render | `ffmpeg.concat` | deterministic | 按 inputs 顺序拼接（`-c copy`） |
| render | `ffmpeg.drawtext` | deterministic | 加字。**支持第二个输入作为文本来源**，详见下节 |
| verify | `verify.media` | deterministic | 大小/时长门禁，不达标**中断整图** |
| agent | `agent.llm` | **stochastic** | 调模型判断（依赖宿主注入 `sidePathLLM`，见验证状态） |
| human | `human.approve` | deterministic | 人工审批（插件内**未开放**，见边界） |
| service | `service.http` | **stochastic** | 任意 HTTP(S)，有超时与响应上限；密钥可走环境变量 |
| memory | `memory.get` | **stochastic** | 跨运行读取（读外部状态，按不确定处理） |
| memory | `memory.set` | deterministic | 跨运行写入（只写不读，不影响下游确定性） |

## 密钥不写进图

`service.http` 的 `url`、`headers`、`body` 支持 `${env:NAME}` 占位符，执行时从进程环境变量展开：

```json
{ "id": "llm", "type": "service", "op": "service.http",
  "params": {
    "url": "https://api.deepseek.com/chat/completions",
    "method": "POST",
    "headers": { "Authorization": "Bearer ${env:DEEPSEEK_API_KEY}" },
    "body": "{...}",
    "timeoutMs": 30000 } }
```

- 变量没设会**直接报错并点名**（`[llm] 环境变量 DEEPSEEK_API_KEY 未设置`），不会静默变成空串
- **账本记的是占位符本身**。实测 `twg_runs` 查回的 `params_json` 为 `"Authorization":"Bearer ${env:DEEPSEEK_API_KEY}"`，密钥不落库
- 解析不改动 `node.params`，报错信息也用未展开的模板

直接写明文密钥也能跑——但它会原样进证据账本的 params。**别这么干。**

## AI 文案直接上屏

`ffmpeg.drawtext` 可以接第二个输入当文本来源，把上游产物里的正文画到画面上：

```json
{ "id": "cap", "type": "render", "op": "ffmpeg.drawtext",
  "inputs": ["bg", "llm"],
  "params": { "size": 40, "x": 80, "y": 330, "maxChars": 100 } }
```

`inputs` 顺序是 `[视频, 文本来源]`。文本来源支持：

| 结构 | 厂商 |
|---|---|
| `choices[0].message.content` | OpenAI 兼容（DeepSeek / Moonshot / 智谱…） |
| `message.content` | Ollama |
| `content[].text`（拼接所有 `type:"text"` 块） | Anthropic |
| `candidates[0].content.parts[].text` | Gemini |
| `output_text` | OpenAI Responses API |
| `text` | Cohere |

探测按上表顺序进行，取第一个有内容的。**全部取不到就报错**，不会把整串 JSON 画到画面上。非文本块（`tool_use` / `image`）会被跳过。

文本在拼进 ffmpeg filter 前会清洗：换行折叠成空格，单引号 / 冒号 / 反斜杠移除以避免破坏 `drawtext=text='...'` 语法，超长按 `maxChars`（默认 120）截断。

### 中文

文本含 CJK 字符时自动选系统字体（Windows 查 `msyh.ttc` / `simhei.ttf` / `simsun.ttc`，macOS 查 `PingFang.ttc`，Linux 查 Noto / 文泉驿）。想固定字体传 `params.fontfile`，路径不存在会直接报错。两边都找不到时报「文本含中文但本机找不到中文字体」，而不是静默画出一片方块。

实测（宿主进程内）：`{"text":"葡萄成熟时","size":72}` → 五个汉字完整渲染，无方块。

## 确定性：四态

一条输出路径的等级 = 路径上**最弱**的那个节点。

| 等级 | 含义 |
|---|---|
| `deterministic` | 同输入必同输出 |
| `seeded` | 给定种子必定同输出 |
| `stochastic` | 同输入可能不同输出（模型、网络） |
| **`null`** | **没跑完**——失败时记 null |

最后一条是设计上的关键取舍：**「结果不确定」和「根本没跑完」不是一回事**。混在一起，账本的确定性列就会说谎。

实测（同一张图里两条路径）：

```json
{
  "overall": "stochastic",
  "perOutput": {
    "video":  "deterministic",
    "review": "stochastic"
  }
}
```

## 证据账本

每次运行写进 SQLite（`runs` / `node_runs` / `memory` 三张表）：

```sql
SELECT id, status, determinism, error FROM runs;
SELECT node_id, op, ok, error FROM node_runs WHERE run_id = ?;
```

**失败也一样留档**，并且精确到节点：

```
run: {"status":"failed","determinism":null,"error":"[gate] 时长过短: 1.7 < 2"}
  gen1..final  ok=1
  gate         ok=0  | [gate] 时长过短: 1.7 < 2
```

连**图校验阶段被拒**的运行也会落库——这类失败没有节点执行，但 `runs.error` 会记下原因。

### 写入纪律

一次运行 = **一个事务**。实测（宿主运行时，WAL，1KB/行）：

| 方式 | 300 节点耗时 |
|---|---|
| 逐条写 | 477 ms（阻塞整个会话） |
| **事务批量** | **5.5 ms** |

并发打开同一个库时 `busy_timeout` 是必须的——否则 10 个进程同时切 WAL 会全部 `database is locked`（已修，实测 10 进程并发全成功）。

## 与其它工作流系统的关系

| 系统 | 节点是什么 | TWG 的差异 |
|---|---|---|
| ComfyUI | 纯函数 | 节点是工作单元；确定性是图属性；失败入账本 |
| n8n | 服务调用 | 有类型化端口与媒体算子；`verify` 能对视频做门禁 |
| Remotion / MoviePy | 代码 | TWG 是图；程序化渲染只是 `render` 节点的内部实现 |
| Shotstack | 云渲染 API | TWG 本地执行 + 证据层 |
| Sora / 可灵 | 端到端黑盒 | TWG 把黑盒当作一个 `compute` 节点 |
| Synthesia | 模板播报 | TWG 里它是一张参数化子图 |

**范式是节点的实现细节，不是图的类型。** 一旦把范式做成一等公民，图就分裂成六种互不兼容的东西。

## 边界（明确不做）

| 不做 | 原因 |
|---|---|
| 不做推理引擎 | 插件与宿主同进程，跑不了重推理 |
| 不打包 FFmpeg / ComfyUI | 80MB+ 二进制不该进插件包 |
| 不做 NLE 时间线 | DAG 与时间线是两种数据结构 |
| 不做云端账号 / 社区 | 用 git 分发工作流即可 |
| 不做节点级人工审批 | TPI 1.0 只有工具级 `requiresApproval` |
| **不做音频生成** | 没有音频节点；素材自带音轨能被 `ffmpeg.input` 保留，但插件造不出音乐 |
| **不做转场 / 动画 / 缩放 / 变速** | 没有对应滤镜节点，`drawtext` 只支持静态文字 |

`human.approve` 在插件里会明确报错——**不是 bug，是能力边界**。伪造自动批准会让确定性等级说谎。

## 关于 skill（如实说明）

`skills/tianshu-workflow-graph/SKILL.md` 存在，manifest 里也声明了 `contributes.skills`，但**当前宿主（4.0.4）不加载插件的 skill**。

实测依据：连宿主内置插件 `trace-lab` 的 skill 也无法通过 `skill` 工具找到，可用 skill 列表只有宿主自带的几个。

因此用法改由 **`twg_help` 工具**提供——内容仍以该 SKILL.md 为唯一数据源。若将来宿主支持插件 skill，这份文件可直接生效。

## 开发

```bash
node --test test/*.test.mjs       # 100 项
```

> 注意：`node --test test/` 在 Node 24 下会报 `Cannot find module`，必须用显式文件列表。

| 文件 | 职责 |
|---|---|
| `index.mjs` | 插件入口，4 个工具 |
| `tianshu.plugin.json` | TPI 1.0 清单 |
| `lib/graph.mjs` | 图校验 + Kahn 拓扑排序 + 环检测 |
| `lib/executor.mjs` | 执行器、ffmpeg 解析、确定性汇总、账本写入 |
| `lib/nodes.mjs` | **11 个 op** 的实现 + 文本提取 / 清洗 / 环境变量 / 字体选择 |
| `lib/determinism.mjs` | 等级合成与路径传播 |
| `lib/ledger.mjs` | SQLite 账本（runs / node_runs / memory）+ schema 迁移 |
| `lib/services.mjs` | 服务注入，内核不绑定宿主 |
| `run.mjs` | 命令行入口（不经宿主也能跑） |

> 安装目录里有一份 `lib/` 运行副本，改内核后需同步过去。

## 验证状态

| 项 | 状态 |
|---|---|
| 单元测试 | **100 项全过**（本机 Node v24.22.2） |
| 宿主进程内执行 | **已验证**：`twg_run` 返回 `ledger: "written"`，产物落盘 |
| 宿主路径守卫 | **已验证**：工作区外路径被拒 |
| 失败入账 | **已验证**：`status=failed` + `determinism=null` + 节点级 error |
| 并发写 memory | **已验证**：10 进程全成功，last-write-wins |
| 真实模型调用 | **已验证**：宿主内 `service.http` 调 DeepSeek 成功（1005 ms / 1219 ms 两次），密钥不落账本 |
| AI 文案上屏 | **已验证**：DeepSeek 返回正文直接画进画面，抽帧目视确认 |
| 中文字幕 | **已验证**：宿主内渲染 `葡萄成熟时`，字形完整 |
| 环境变量占位符 | **已验证**：宿主内展开成功；缺变量时报错并点名 |
| 插件 skill 加载 | **不可用**：宿主不加载（见上节） |
| `agent.llm` 节点 | **不可用**：宿主未注入 `sidePathLLM`（用 `service.http` 替代） |
| 节点级人工审批 | **未实现**：宿主无此通道 |
| 多厂商响应结构 | **部分验证**：Anthropic 结构做了端到端；Gemini / Ollama / Responses / Cohere 只有单元测试 |

## 文档

- [架构设计](docs/architecture.md) — 完整设计、边界、取舍、代价
- [视频工作流调研](docs/video-workflow-research.md) — 应用与六种范式的分析
- [v0.1 设计（已废弃）](docs/architecture-v0.1-superseded.md) — 保留仅供追溯
