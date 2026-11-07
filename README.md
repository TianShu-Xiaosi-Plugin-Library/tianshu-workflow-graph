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
| `twg_help` | **不确定怎么用时先调它**——返回完整用法（何时用、op 清单、三个必记约束、常见组合） |
| `twg_validate` | 只校验图结构，不执行 |
| `twg_run` | 执行图，返回产物路径、各节点耗时、确定性、runId |
| `twg_runs` | 查证据账本：列最近运行，或按 runId 取完整节点记录 |

## 快速开始

### 前置

- 天枢 **4.0.2+**（实测 4.0.4）
- **FFmpeg**（TWG 不打包二进制，需自备）
  - 设 `TWG_FFMPEG` 指向 `ffmpeg.exe`，或把 `bin` 加进 PATH，或放到 `D:/Tools/ffmpeg/bin/`
  - Windows 下载：<https://www.gyan.dev/ffmpeg/builds/>（essentials build 即可）

### 安装

把本仓库复制到天枢的用户插件目录，重启天枢：

```
<TianshuData>/.rivet/plugins/tianshu-workflow-graph/
```

> 实际目录由宿主的 `RIVET_HOME` 决定，也可能是 `%LOCALAPPDATA%\.rivet\plugins\`。装好后重启，工具列表里应出现上表 4 个工具。

### 跑第一张图

```
twg_run { graph: "twg/templates/title-card.twg.json" }
```

实测返回（宿主进程内，运行时 v24.22.1）：

```json
{
  "ok": true, "runId": "run-mw64iknr-nnzh", "totalMs": 302.9,
  "order": ["intro","solid","title","final"],
  "timings": [{ "id":"intro","op":"ffmpeg.testsrc","ms":90.3,"determinism":"deterministic" }, ...],
  "outputs": { "main": "...\\final.mp4" },
  "determinism": { "overall": "deterministic", "perOutput": { "main": "deterministic" } },
  "ledger": "written"
}
```

**图文件必须在工作区内**——宿主的路径守卫会拒绝工作区外的路径（实测报 `Path rejected`）。

## 模板：不用写 JSON 也能开始

`templates/` 下三个开箱能跑的图，**只改 `params`，不动结构**：

| 模板 | 做什么 | 实测产物 |
|---|---|---|
| `title-card.twg.json` | 纯色背景 + 一行大字 | 3.0s / 6380 B |
| `subtitle-burn.twg.json` | 烧字幕到画面 | 5.0s / 8968 B |
| `concat-clips.twg.json` | 三段拼成一条 | 6.0s / 11359 B |

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

## 七类节点

| 类型 | op | 确定性 | 说明 |
|---|---|---|---|
| compute | `ffmpeg.testsrc` / `ffmpeg.color` | deterministic | 生成测试/纯色素材 |
| compute | `ffmpeg.input` | deterministic | **读基准目录内的素材文件**（`path` 的基准由 `root` 决定） |
| render | `ffmpeg.concat` / `ffmpeg.drawtext` | deterministic | 拼接、加字 |
| verify | `verify.media` | deterministic | 大小/时长门禁，不达标**中断整图** |
| agent | `agent.llm` | **stochastic** | 调模型判断（依赖宿主注入 `sidePathLLM`） |
| human | `human.approve` | deterministic | 人工审批（插件内**未开放**，见边界） |
| service | `service.http` | **stochastic** | 第三方 HTTP（仅 http/https，有超时与响应上限） |
| memory | `memory.get` / `memory.set` | **stochastic** / deterministic | 跨运行状态，支持 `text` / `base64` |

## 确定性：四态

一条输出路径的等级 = 路径上**最弱**的那个节点。

| 等级 | 含义 |
|---|---|
| `deterministic` | 同输入必同输出 |
| `seeded` | 给定种子必定同输出 |
| `stochastic` | 同输入可能不同输出（模型、网络） |
| **`null`** | **没跑完**——失败时记 null |

最后一条是设计上的关键取舍：**「结果不确定」和「根本没跑完」不是一回事**。混在一起，账本的确定性列就会说谎。

实测（同一张图，两条路径）：

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

`human.approve` 在插件里会明确报错——**不是 bug，是能力边界**。伪造自动批准会让确定性等级说谎。

## 关于 skill（如实说明）

`skills/tianshu-workflow-graph/SKILL.md` 存在，manifest 里也声明了 `contributes.skills`，但**当前宿主（4.0.4）不加载插件的 skill**。

实测依据：连宿主内置插件 `trace-lab` 的 skill 也无法通过 `skill` 工具找到，可用 skill 列表只有 `galaxy` / `skill-creator` / `skill-management`（均为宿主自带）。

因此用法改由 **`twg_help` 工具**提供——内容仍以该 SKILL.md 为唯一数据源。若将来宿主支持插件 skill，这份文件可直接生效。

## 开发

```bash
node --test test/*.test.mjs       # 55 项
```

| 文件 | 职责 |
|---|---|
| `index.mjs` | 插件入口，4 个工具 |
| `tianshu.plugin.json` | TPI 1.0 清单 |
| `lib/graph.mjs` | 图校验 + Kahn 拓扑排序 + 环检测 |
| `lib/executor.mjs` | 执行器、ffmpeg 解析、确定性汇总、账本写入 |
| `lib/nodes.mjs` | 10 个 op 的实现 |
| `lib/determinism.mjs` | 等级合成与路径传播 |
| `lib/ledger.mjs` | SQLite 账本（runs / node_runs / memory）+ schema 迁移 |
| `lib/services.mjs` | 服务注入，内核不绑定宿主 |
| `run.mjs` | 命令行入口（不经宿主也能跑） |

> 安装目录里有一份 `lib/` 运行副本，改内核后需同步过去。

## 验证状态

| 项 | 状态 |
|---|---|
| 单元测试 | **55 项**，本机 Node v24.22.2 与宿主运行时 v24.22.1 **均全过** |
| 宿主进程内执行 | **已验证**：`twg_run` 返回 `ledger: "written"`，产物落盘 |
| 宿主路径守卫 | **已验证**：工作区外路径被拒 |
| 失败入账 | **已验证**：`status=failed` + `determinism=null` + 节点级 error |
| 并发写 memory | **已验证**：10 进程全成功，last-write-wins |
| 三个模板 | **已验证**：产物时长与字节均符合预期 |
| 插件 skill 加载 | **不可用**：宿主不加载（见上节） |
| 真实模型调用 | **未验证**：宿主未给本会话装配 `sidePathLLM` |
| 节点级人工审批 | **未实现**：宿主无此通道 |

## 文档

- [架构设计](docs/architecture.md) — 完整设计、边界、取舍、代价
- [视频工作流调研](docs/video-workflow-research.md) — 应用与六种范式的分析
- [v0.1 设计（已废弃）](docs/architecture-v0.1-superseded.md) — 保留仅供追溯
