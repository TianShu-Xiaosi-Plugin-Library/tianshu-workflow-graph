// 执行器：按拓扑序逐节点求值，产物落 workDir，可选写证据账本
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { topoSort } from './graph.mjs'
import { getOp } from './nodes.mjs'
import { graphDeterminism } from './determinism.mjs'
import { recordRun } from './ledger.mjs'
import { requireServices } from './services.mjs'

/** 图指纹：同一张图必须得到同一个 hash */
export function graphHash(graph) {
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 16)
}

/** 找 ffmpeg。显式指定不存在时立即报错——静默回退会掩盖配置错误。 */
export function resolveFfmpeg(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`指定的 ffmpeg 不存在: ${explicit}`)
    return explicit
  }
  const env = process.env.TWG_FFMPEG
  if (env) {
    if (!existsSync(env)) throw new Error(`TWG_FFMPEG 指向的文件不存在: ${env}`)
    return env
  }
  const known = join('D:', 'Tools', 'ffmpeg', 'bin', 'ffmpeg.exe')
  if (existsSync(known)) return known

  // 回退 PATH 之前先探一次：否则每个节点都会抛一句空的 "[xx] ffmpeg 失败: "
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (probe.error || probe.status !== 0) {
    throw new Error([
      '找不到 ffmpeg。三选一：',
      '  1) 设环境变量 TWG_FFMPEG 指向 ffmpeg.exe 的完整路径',
      '  2) 把 ffmpeg 的 bin 目录加进 PATH',
      '  3) 把 ffmpeg.exe 放到 D:/Tools/ffmpeg/bin/',
      'Windows 下载：https://www.gyan.dev/ffmpeg/builds/ （essentials build 即可）',
    ].join('\n'))
  }
  return 'ffmpeg'
}

function newRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 找 ffprobe：显式 > 与 ffmpeg 同目录的兄弟文件 > PATH 回退 */
export function resolveFfprobe(explicit, ffmpegPath) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`指定的 ffprobe 不存在: ${explicit}`)
    return explicit
  }
  if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
    const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    const sibling = join(dirname(ffmpegPath), name)
    if (existsSync(sibling)) return sibling
  }
  return 'ffprobe'
}

/**
 * 执行一张图。
 * @param {object} graph 已校验的图
 * @param {object} [opts]
 * @param {string} [opts.workDir]
 * @param {string} [opts.ffmpeg]
 * @param {import('node:sqlite').DatabaseSync} [opts.ledger] 传入则写证据账本
 * @returns {{ outputs, order, workDir, timings, ffmpeg, runId, determinism }}
 */
export async function execute(graph, opts = {}) {
  const runId = opts.runId ?? newRunId()
  const startedAt = Date.now()
  const results = new Map()
  const timings = []
  const nodeRecords = []
  const opDet = new Map()

  const finish = (status, extra) => {
    // 失败的运行"没跑完" ≠ "结果不确定"：determinism 记 null，
    // 不要用 stochastic 冒充——那会让账本的确定性列失真。
    const det = status === 'ok'
      ? graphDeterminism(graph, opDet)
      : { overall: null, perOutput: {}, incomplete: true }
    if (opts.ledger) {
      try {
        recordRun(opts.ledger, {
          runId,
          graphId: graph.id ?? null,
          graphHash: graphHash(graph),
          startedAt,
          finishedAt: Date.now(),
          status,
          determinism: det.overall,
          nodes: nodeRecords,
          outputs: extra.outputs ?? null,
          error: extra.error ?? null,
        })
      } catch (ledgerErr) {
        // 账本失败不吞结果，但必须能被看见
        extra.ledgerError = String(ledgerErr.message ?? ledgerErr)
      }
    }
    return { ...extra, determinism: det, runId }
  }

  try {
    // ffmpeg 解析与目录创建也在 try 内——配置错误同样要留档
    const ffmpeg = resolveFfmpeg(opts.ffmpeg)
    const ffprobe = resolveFfprobe(opts.ffprobe, ffmpeg)
    const services = requireServices(graph, opts.services ?? {})
    const workDir = resolve(opts.workDir ?? join(process.cwd(), '.twg-run', graph.id ?? 'run'))
    mkdirSync(workDir, { recursive: true })
    const order = topoSort(graph)

    for (const node of order) {
      // 失败节点也要留档：账本要能回答"卡在哪个节点"，
      // 而不只是从 runs.error 的文本里猜
      let op = null
      try {
        op = getOp(node)
        opDet.set(node.id, op.determinism)

        const inputs = (node.inputs ?? []).map((id) => {
          const r = results.get(id)
          if (!r) throw new Error(`节点 ${node.id} 的输入 ${id} 尚无产物`)
          // 上游不产出文件（memory.set / human.approve）时，错误必须指向真正原因
          if (r.file === null || r.file === undefined) {
            throw new Error(`节点 ${node.id} 的输入 ${id} 不产出文件，不能作为下游输入`)
          }
          return r
        })

        if (op.inputs >= 0 && inputs.length !== op.inputs) {
          throw new Error(`节点 ${node.id}（${node.op}）需要 ${op.inputs} 个输入，实际 ${inputs.length} 个`)
        }

        const t0 = performance.now()
        const out = await op.run({ node, inputs, workDir, ffmpeg, ffprobe, services, db: opts.ledger, runId, cwd: opts.cwd ?? process.cwd() })
        const ms = +(performance.now() - t0).toFixed(1)

        results.set(node.id, out)
        timings.push({ id: node.id, op: node.op, kind: op.kind, determinism: op.determinism, ms })
        nodeRecords.push({
          nodeId: node.id,
          op: node.op,
          kind: op.kind,
          determinism: op.determinism,
          params: node.params ?? null,
          inputs: node.inputs ?? null,
          outputFile: out.file,
          durationMs: ms,
          ok: true,
        })
      } catch (nodeErr) {
        nodeRecords.push({
          nodeId: node.id,
          op: node.op ?? null,
          kind: op?.kind ?? node.type ?? null,
          determinism: op?.determinism ?? null,
          params: node.params ?? null,
          inputs: node.inputs ?? null,
          outputFile: null,
          durationMs: null,
          ok: false,
          error: String(nodeErr.message ?? nodeErr),
        })
        throw nodeErr
      }
    }

    const outputs = {}
    for (const [name, nodeId] of Object.entries(graph.outputs ?? {})) {
      const r = results.get(nodeId)
      if (!r) throw new Error(`输出 ${name} 指向的节点 ${nodeId} 没有产物`)
      outputs[name] = r.file
    }

    return finish('ok', {
      outputs,
      order: order.map((n) => n.id),
      workDir,
      timings,
      ffmpeg,
    })
  } catch (err) {
    // 失败的运行也要留档——否则无法回答"上次为什么没跑出来"
    finish('failed', { error: String(err.message ?? err) })
    throw err
  }
}
