---
name: tianshu-workflow-graph
description: 用 TWG 把视频/内容生产流程写成可执行、可查证的节点图。当用户要求做「多步骤的视频处理」「批量生成」「需要能复现或能追责的产出」时使用。
---

# Tianshu Workflow Graph

把生产流程写成一张 JSON 图，按依赖顺序执行，每次运行留下可查证的记录。

## 什么时候用它

**用**：
- 用户要的是一条**流水线**：生成 → 加工 → 门禁 → 合成，多步骤有依赖
- 用户要**批量**：同一套流程跑 N 次，参数不同
- 用户要**可追责**：这条视频怎么来的、上次为什么失败、能不能重跑出一样的
- 用户要**跨运行状态**：这次的品牌色，下次还要用

**不用**：
- 只是生成一段视频 → 直接调模型 API，别绕图
- 只是剪辑一段素材 → 用剪辑工具
- 用户要「一句话出片」且不在意过程 → TWG 的价值在过程，不在出片速度

## 图的骨架

```json
{
  "id": "my-workflow",
  "nodes": [
    { "id": "gen", "type": "compute", "op": "ffmpeg.color",
      "params": { "duration": 2, "size": "1280x720", "rate": 25, "color": "teal" } },
    { "id": "title", "type": "render", "op": "ffmpeg.drawtext",
      "inputs": ["gen"], "params": { "text": "标题", "size": 64, "x": 40, "y": 40 } },
    { "id": "gate", "type": "verify", "op": "verify.media",
      "inputs": ["title"], "params": { "minDuration": 1.5, "minSize": 1000 } }
  ],
  "outputs": { "main": "gate" }
}
```

规则：
- `root` 声明 `params.path` 相对谁：`"workspace"`（默认，相对会话工作区）或 `"graph"`（相对图文件所在目录）。**分享图给别人时必须写 `"graph"`**，否则对方的工作区不同，路径会解析到别处
- `id` 节点唯一，`inputs` 声明依赖（引擎做拓扑排序 + 环检测）
- `type` 必须与 `op` 的类型一致，否则报错
- `outputs` 是产物的命名出口，指向节点 id

## op 速查

| op | type | 要什么输入 | 关键 params | 确定性 |
|---|---|---|---|---|
| `ffmpeg.testsrc` | compute | 无 | `duration` `size` `rate` | deterministic |
| `ffmpeg.input` | compute | 无 | `path`（**必须在基准目录内**，基准由 `root` 决定）`start` `duration` | deterministic |
| `ffmpeg.color` | compute | 无 | `duration` `size` `rate` `color` | deterministic |
| `ffmpeg.concat` | render | 1+ 个视频 | 无（按 inputs 顺序拼接） | deterministic |
| `ffmpeg.drawtext` | render | 1 个视频（可选再给 1 个文本来源） | `text` `size` `x` `y` `maxChars` `fontfile` | deterministic |
| `verify.media` | verify | 1 个文件 | `minDuration` `maxDuration` `minSize` `maxSize` | deterministic |
| `agent.llm` | agent | 0+（路径会拼进 prompt） | `prompt` `maxChars` | **stochastic** |
| `human.approve` | human | 0+ | `message` | deterministic |
| `service.http` | service | 0+（有输入则作为 body） | `url` `method` `headers` `body` `timeoutMs`；三个文本字段支持 `${env:NAME}` | **stochastic** |
| `memory.get` | memory | 无 | `key` `defaultValue` `valueType` | **stochastic** |
| `memory.set` | memory | 0+（有输入则存其内容） | `key` `valueType` | deterministic |

## 五个必须记住的约束

**1. `agent.llm` 不是永远可用**

它依赖宿主注入 `sidePathLLM`。如果没装配，跑图会报「图需要以下服务但未注入」。这是设计如此，不要试图绕过——用 `verify` 或 `service` 替代。

**2. `memory.set` 和 `human.approve` 不产出文件**

它们的 `file` 是 `null`。**不能把它们当作下游节点的输入**，否则报「不产出文件，不能作为下游输入」。它们是链路的末端或旁路。

**3. `verify.media` 不通过会中断整图**

这是设计目的。想在门禁失败后继续，就不要把它放在主路径上，或者把阈值放宽。

**4. 密钥用 `${env:NAME}`，不要写进图**

`service.http` 的 `url`、`headers`、`body` 里可以写 `${env:NAME}`，执行时从进程环境变量展开，账本记的是占位符本身（密钥不落库）。变量没设会直接报错并点名，不会静默变成空串。直接写明文也能跑——但它会原样进证据账本的 params。

**5. 中文文本要指定 `fontfile`，否则自动选系统字体**

`drawtext` 的默认字体不含中文字形。文本里出现中文时，会自动在平台常见路径里找一款中文字体（Windows 用 `msyh.ttc` / `simhei.ttf`，macOS 用 `PingFang.ttc`）。想固定字体就传 `params.fontfile`（路径不存在会直接报错，不会静默回退）。两边都找不到时会报「文本含中文但本机找不到中文字体」，而不是静默画出一片方块。

## 常见组合

**用自己的素材**：`ffmpeg.input`（读基准目录内文件）→ `ffmpeg.drawtext` → `verify.media`
**片头**：`ffmpeg.color` → `ffmpeg.drawtext` → `verify.media`
**多段拼接**：N 个 `ffmpeg.color`/`testsrc` → `ffmpeg.concat` → `verify.media`
**带判断的流水线**：`ffmpeg.color` → `agent.llm`（判断风格）→ `memory.set`（存结论）+ `ffmpeg.concat`（合成）
**拉数据存证**：`service.http` → 落盘 + 入账本
**AI 文案上屏**：`service.http`（调模型）→ `ffmpeg.drawtext`（第二输入）+ `ffmpeg.color`（第一输入）→ 自动把模型返回的正文画上去（OpenAI 兼容响应的 `choices[0].message.content` 会被自动取出）

## 怎么跑

```
twg_validate  { graph: "<工作区内的路径>.twg.json" }   # 先校验，不执行
twg_run       { graph: "...", workDir: "..." }          # 执行
twg_runs      { } 或 { runId: "run-xxx" }               # 查历史
```

**图文件必须在工作区内**——宿主的路径守卫会拒绝工作区外的路径。

## 怎么读结果

`twg_run` 返回：

```json
{
  "ok": true, "runId": "run-xxx",
  "order": ["gen","title","gate"],
  "timings": [{ "id":"gen","ms":90.3,"determinism":"deterministic" }],
  "outputs": { "main": "..." },
  "determinism": { "overall": "deterministic", "perOutput": { "main": "..." } },
  "ledger": "written"
}
```

- `determinism.overall` 是**整图最弱**的等级：`deterministic` < `seeded` < `stochastic` < `null`（失败没跑完）
- `ledger: "written"` 表示证据已入账；`"unavailable"` 表示宿主没给 storage
- 失败时返回 `isError: true`，错误信息**带节点名**，如 `[gate] 时长过短: 1.7 < 2`

## 给用户解释结果时

- 如果 `overall` 是 `stochastic`，告诉用户「这条结果依赖模型/网络，重跑可能不同」
- 如果某条输出路径是 `deterministic`，可以承诺「同样的图、同样的输入，重跑结果一致」
- 失败时用错误里的节点名定位，不要让用户猜
