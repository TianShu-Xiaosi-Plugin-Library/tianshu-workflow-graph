import { defineTianshuPlugin } from './tpi.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, validate } from './lib/graph.mjs'
import { execute } from './lib/executor.mjs'
import { initLedger, listRuns, getRun } from './lib/ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_NAME = 'twg.db'

function resolveGraphPath(p, cwd) {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

export default defineTianshuPlugin({
  id: 'twg',
  activate(host) {
    const workRoot = (() => {
      try {
        if (host.storage?.dataDir) return join(host.storage.dataDir(), 'runs')
      } catch { /* storage 不可用时回落到插件目录 */ }
      return join(HERE, '.runs')
    })()

    // 账本惰性打开：宿主没给 storage 时静默降级为"无账本"
    let ledger = null
    let ledgerTried = false
    const getLedger = () => {
      if (ledgerTried) return ledger
      ledgerTried = true
      try {
        if (host.storage?.openDatabase) {
          ledger = initLedger(host.storage.openDatabase(DB_NAME))
        }
      } catch (err) {
        host.log?.warn?.(`[twg] 账本打开失败，本次运行不留存证: ${err?.message ?? err}`)
        ledger = null
      }
      return ledger
    }

    // 服务注入：只用宿主真给的能力，缺什么就让 requireServices 把话说清楚
    const buildServices = () => {
      const s = {}
      try {
        if (host.sidePathLLM?.available?.()) {
          s.complete = (prompt, opts) => host.sidePathLLM.complete(prompt, {
            timeoutMs: Math.min(opts?.timeoutMs ?? 60000, 90000),
          })
        }
      } catch (err) {
        host.log?.warn?.(`[twg] sidePathLLM 探测失败: ${err?.message ?? err}`)
      }
      // human.approve 故意不注入：TPI 1.0 只有工具级 requiresApproval，
      // 没有节点级审批通道。伪造一个自动批准会让确定性等级说谎。
      return s
    }

    return {
      tools: [
        {
          name: 'twg_run',
          description: '执行一张 TWG 图，返回产物路径、各节点耗时与确定性等级，并写入证据账本',
          inputSchema: {
            type: 'object',
            properties: {
              graph: { type: 'string', description: '图 JSON 文件路径' },
              workDir: { type: 'string', description: '可选：产物目录，默认 <插件数据目录>/runs/<图 id>' },
              ffmpeg: { type: 'string', description: '可选：ffmpeg 可执行文件路径' },
            },
            required: ['graph'],
            additionalProperties: false,
          },
          pathParams: { graph: 'read', workDir: 'write' },
          concurrencySafe: false,
          timeoutMs: 600000,
          async execute({ args, cwd }) {
            const graphPath = resolveGraphPath(args.graph, cwd)
            let raw
            try {
              raw = JSON.parse(readFileSync(graphPath, 'utf8'))
            } catch (err) {
              return { isError: true, content: `读取图失败: ${graphPath}\n${err.message}` }
            }

            let graph
            try {
              graph = load(raw)
            } catch (err) {
              return { isError: true, content: String(err.message) }
            }

            const workDir = args.workDir ? args.workDir : join(workRoot, graph.id ?? 'run')
            mkdirSync(workDir, { recursive: true })

            const t0 = performance.now()
            let result
            try {
              result = await execute(graph, {
                workDir,
                ffmpeg: args.ffmpeg,
                ledger: getLedger(),
                services: buildServices(),
              })
            } catch (err) {
              return { isError: true, content: `执行失败: ${err.message}` }
            }
            const totalMs = +(performance.now() - t0).toFixed(1)

            return {
              content: JSON.stringify({
                ok: true,
                runId: result.runId,
                graph: graph.id ?? null,
                order: result.order,
                timings: result.timings,
                outputs: result.outputs,
                workDir: result.workDir,
                totalMs,
                ffmpeg: result.ffmpeg,
                determinism: result.determinism,
                ledger: ledger ? 'written' : 'unavailable',
              }, null, 1),
            }
          },
        },
        {
          name: 'twg_validate',
          description: '只校验图结构（不执行）',
          inputSchema: {
            type: 'object',
            properties: { graph: { type: 'string', description: '图 JSON 文件路径' } },
            required: ['graph'],
            additionalProperties: false,
          },
          pathParams: { graph: 'read' },
          concurrencySafe: true,
          async execute({ args, cwd }) {
            const graphPath = resolveGraphPath(args.graph, cwd)
            let raw
            try {
              raw = JSON.parse(readFileSync(graphPath, 'utf8'))
            } catch (err) {
              return { isError: true, content: `读取图失败: ${graphPath}\n${err.message}` }
            }
            const errors = validate(raw)
            if (errors.length) return { content: JSON.stringify({ ok: false, errors }, null, 1) }
            try {
              load(raw)
            } catch (err) {
              return { content: JSON.stringify({ ok: false, errors: [String(err.message)] }, null, 1) }
            }
            return {
              content: JSON.stringify({
                ok: true,
                nodes: raw.nodes.length,
                ops: [...new Set(raw.nodes.map((n) => n.op))],
              }, null, 1),
            }
          },
        },
        {
          name: 'twg_runs',
          description: '查询证据账本：列最近运行，或按 runId 取某次运行的完整节点记录',
          inputSchema: {
            type: 'object',
            properties: {
              runId: { type: 'string', description: '可选：指定则返回该次运行的完整记录' },
              limit: { type: 'number', description: '可选：列表条数，默认 20' },
            },
            additionalProperties: false,
          },
          concurrencySafe: true,
          async execute({ args }) {
            const db = getLedger()
            if (!db) {
              return { isError: true, content: '账本不可用（宿主未提供 storage）' }
            }
            if (args.runId) {
              const rec = getRun(db, args.runId)
              if (!rec) return { isError: true, content: `找不到 run: ${args.runId}` }
              return { content: JSON.stringify(rec, null, 1) }
            }
            const rows = listRuns(db, Math.min(Number(args.limit) || 20, 200))
            return { content: JSON.stringify({ count: rows.length, runs: rows }, null, 1) }
          },
        },
      ],
    }
  },
})
