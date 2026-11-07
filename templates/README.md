# 模板图

三个开箱能跑的模板。**你只需要改 `params`，不用动结构。**

| 模板 | 做什么 | 主要改哪里 |
|---|---|---|
| `title-card.twg.json` | 纯色背景 + 一行大字，带门禁 | `text` 里的标题、`size`、`bg` 的 `color` |
| `subtitle-burn.twg.json` | 烧一行字幕到画面上 | `text`、`size`、`y`（垂直位置） |
| `concat-clips.twg.json` | 三段拼成一条 | 各 `clipN` 的 `color` / `duration`，或加更多 `clip` |
| `from-file.twg.json` | **读你自己的素材**再加工 | `path`（基准由 `root` 决定，**必须落在基准目录内**）、`start` / `duration` |

## `from-file` 模板要改 path

它的 `path` 是 `.twg-run/hello/final.mp4`——先跑一次 `hello.twg.json` 才会有这个文件。用你自己的素材时：

1. 把视频放进工作区（比如 `<工作区>/assets/my.mp4`）
2. 把 `path` 改成 `assets/my.mp4`，并在图顶层加 `"root": "graph"` 让它相对**图文件所在目录**（不加则相对会话工作区）
3. 基准目录外的文件会被拒：`素材在基准目录外，拒绝读取`

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

**想换成自己的素材**：用 `ffmpeg.input`（`params.path` 指向视频，`start` / `duration` 可选裁剪），再用 `ffmpeg.concat` / `ffmpeg.drawtext` 加工。

## 跑出来在哪

`twg_run` 返回的 `outputs.main` 就是成片路径。默认落在插件数据目录的 `runs/<图 id>/` 下，可以用 `workDir` 参数改。

## 失败怎么办

返回的 `isError: true` 里带节点名，比如：

```
[gate] 时长过短: 1.7 < 2
```

说明 `gate` 节点没通过。要么把视频做长一点，要么把 `minDuration` 调小。
