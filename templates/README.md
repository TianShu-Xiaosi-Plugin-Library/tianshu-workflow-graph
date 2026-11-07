# 模板图

三个开箱能跑的模板。**你只需要改 `params`，不用动结构。**

| 模板 | 做什么 | 主要改哪里 |
|---|---|---|
| `title-card.twg.json` | 纯色背景 + 一行大字，带门禁 | `text` 里的标题、`size`、`bg` 的 `color` |
| `subtitle-burn.twg.json` | 烧一行字幕到画面上 | `text`、`size`、`y`（垂直位置） |
| `concat-clips.twg.json` | 三段拼成一条 | 各 `clipN` 的 `color` / `duration`，或加更多 `clip` |

## 怎么跑

```
twg_validate { graph: "twg/templates/title-card.twg.json" }   # 先看结构有没有问题
twg_run      { graph: "twg/templates/title-card.twg.json" }   # 真跑
```

命令行也行：

```bash
cd D:\pro\twg
node run.mjs templates/title-card.twg.json
```

## 改的时候注意

**改标题**：只改 `params.text`，别动 `id` 和 `inputs`——那两条决定连线。

**改时长**：同时改 `duration` 和 `gate` 的 `minDuration`。只改前者，门禁会拦下（这是它的用途）。

**加一段素材**：复制一个 `clip` 节点，改 `id`（必须唯一），把新 id 加进 `final` 的 `inputs` 数组。

**换背景色**：`ffmpeg.color` 的 `color` 认 ffmpeg 的颜色名（`black` / `teal` / `navy` / `purple` / `white` 等）或 `0xRRGGBB`。

**想换成自己的素材**：现在没有「读取本地视频」的 op，只有生成类的。要接真实素材，得先加一个 `ffmpeg.input` 之类的 op——这是已知能力缺口。

## 跑出来在哪

`twg_run` 返回的 `outputs.main` 就是成片路径。默认落在插件数据目录的 `runs/<图 id>/` 下，可以用 `workDir` 参数改。

## 失败怎么办

返回的 `isError: true` 里带节点名，比如：

```
[gate] 时长过短: 1.7 < 2
```

说明 `gate` 节点没通过。要么把视频做长一点，要么把 `minDuration` 调小。
