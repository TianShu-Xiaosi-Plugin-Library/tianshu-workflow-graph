// 节点实现：compute / render 两类，全部落到外部 ffmpeg（用户自备，不打包）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryGet, memorySet } from './ledger.mjs'

/**
 * 节点注册表。每个 op 描述：类型、需要几个输入、怎么从输入产出输出。
 * 确定性等级写在这里，供图级传播使用（Phase 2 会用到）。
 */
export const OPS = {
  // ── compute：生成一段素材 ──────────────────────────────
  'ffmpeg.testsrc': {
    kind: 'compute',
    determinism: 'deterministic',
    inputs: 0,
    run({ node, workDir, ffmpeg }) {
      const { duration = 2, size = '320x240', rate = 10 } = node.params ?? {}
      const outFile = join(workDir, `${node.id}.mp4`)
      const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=${size}:rate=${rate}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', outFile,
      ], { encoding: 'utf8', timeout: 60000, windowsHide: true })
      if (r.status !== 0) throw new Error(`[${node.id}] ffmpeg 失败: ${(r.stderr || '').slice(0, 300)}`)
      return { file: outFile }
    },
  },

  'ffmpeg.color': {
    kind: 'compute',
    determinism: 'deterministic',
    inputs: 0,
    run({ node, workDir, ffmpeg }) {
      const { duration = 2, size = '320x240', rate = 10, color = 'red' } = node.params ?? {}
      const outFile = join(workDir, `${node.id}.mp4`)
      const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${color}:duration=${duration}:size=${size}:rate=${rate}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', outFile,
      ], { encoding: 'utf8', timeout: 60000, windowsHide: true })
      if (r.status !== 0) throw new Error(`[${node.id}] ffmpeg 失败: ${(r.stderr || '').slice(0, 300)}`)
      return { file: outFile }
    },
  },

  // ── render：把多个输入合成为一个 ──────────────────────────
  'ffmpeg.concat': {
    kind: 'render',
    determinism: 'deterministic',
    inputs: -1, // 任意多个
    run({ node, inputs, workDir, ffmpeg }) {
      const files = inputs.map((i) => i.file)
      if (files.length < 1) throw new Error(`[${node.id}] concat 至少需要 1 个输入`)
      const listFile = join(workDir, `${node.id}.txt`)
      writeFileSync(listFile, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8')
      const outFile = join(workDir, `${node.id}.mp4`)
      const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-y', outFile,
      ], { encoding: 'utf8', timeout: 120000, windowsHide: true })
      if (r.status !== 0) throw new Error(`[${node.id}] concat 失败: ${(r.stderr || '').slice(0, 300)}`)
      return { file: outFile }
    },
  },

  'ffmpeg.drawtext': {
    kind: 'render',
    determinism: 'deterministic',
    inputs: 1,
    run({ node, inputs, workDir, ffmpeg }) {
      const src = inputs[0].file
      const { text = 'TWG', size = 40, x = 10, y = 10 } = node.params ?? {}
      const outFile = join(workDir, `${node.id}.mp4`)
      const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-i', src,
        '-vf', `drawtext=text='${text}':fontsize=${size}:fontcolor=white:x=${x}:y=${y}`,
        '-c:a', 'copy', '-y', outFile,
      ], { encoding: 'utf8', timeout: 60000, windowsHide: true })
      if (r.status !== 0) throw new Error(`[${node.id}] drawtext 失败: ${(r.stderr || '').slice(0, 300)}`)
      return { file: outFile }
    },
  },

  // ── verify：断言与门禁，不通过就中断整图 ─────────────────
  'verify.media': {
    kind: 'verify',
    determinism: 'deterministic',
    inputs: 1,
    run({ node, inputs, ffprobe }) {
      const src = inputs[0].file
      const { minDuration, maxDuration, minSize, maxSize } = node.params ?? {}
      if (!existsSync(src)) throw new Error(`[${node.id}] 输入文件不存在: ${src}`)

      const size = statSync(src).size
      if (minSize != null && size < minSize) throw new Error(`[${node.id}] 文件过小: ${size} < ${minSize}`)
      if (maxSize != null && size > maxSize) throw new Error(`[${node.id}] 文件过大: ${size} > ${maxSize}`)

      let duration = null
      if (minDuration != null || maxDuration != null) {
        const r = spawnSync(ffprobe, [
          '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src,
        ], { encoding: 'utf8', timeout: 30000, windowsHide: true })
        if (r.status !== 0) throw new Error(`[${node.id}] ffprobe 失败: ${(r.stderr || '').slice(0, 200)}`)
        duration = Number.parseFloat((r.stdout || '').trim())
        if (!Number.isFinite(duration)) throw new Error(`[${node.id}] 读不出时长: ${r.stdout}`)
        if (minDuration != null && duration < minDuration) throw new Error(`[${node.id}] 时长过短: ${duration} < ${minDuration}`)
        if (maxDuration != null && duration > maxDuration) throw new Error(`[${node.id}] 时长过长: ${duration} > ${maxDuration}`)
      }

      return { file: src, verified: { size, duration } }
    },
  },

  // ── agent：把判断交给模型（不确定） ───────────────────────
  'agent.llm': {
    kind: 'agent',
    determinism: 'stochastic',
    inputs: -1,
    async run({ node, inputs, workDir, services }) {
      const { prompt, maxChars = 4000 } = node.params ?? {}
      if (!prompt) throw new Error(`[${node.id}] agent.llm 需要 params.prompt`)
      const ctx = inputs.map((i) => i.file).join('\n')
      const full = ctx ? `${prompt}\n\n[上游产物]\n${ctx}` : prompt
      // 宿主的 sidePathLLM.complete 返回 Promise<string>，必须 await
      const text = await services.complete(full, { timeoutMs: node.params?.timeoutMs ?? 60000 })
      const outFile = join(workDir, `${node.id}.txt`)
      const clipped = String(text).slice(0, maxChars)
      writeFileSync(outFile, clipped, 'utf8')
      return { file: outFile, text: clipped }
    },
  },

  // ── service：调第三方 HTTP ────────────────────────────────
  'service.http': {
    kind: 'service',
    determinism: 'stochastic',
    inputs: -1,
    async run({ node, inputs, workDir }) {
      const {
        url, method = 'GET', headers = {}, body,
        timeoutMs = 30000, maxBytes = 5 * 1024 * 1024,
      } = node.params ?? {}
      if (!url) throw new Error(`[${node.id}] service.http 需要 params.url`)

      let parsed
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`[${node.id}] url 非法: ${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`[${node.id}] 只允许 http/https，收到 ${parsed.protocol}`)
      }

      // 有上游输入且没显式给 body 时，把第一个产物文件当请求体
      let payload = body
      if (payload == null && inputs.length > 0 && inputs[0].file) {
        payload = readFileSync(inputs[0].file, 'utf8')
      }

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(parsed, {
          method,
          headers,
          body: payload,
          signal: ctrl.signal,
        })
        const text = await res.text()
        if (text.length > maxBytes) {
          throw new Error(`[${node.id}] 响应过大: ${text.length} > ${maxBytes}`)
        }
        const outFile = join(workDir, `${node.id}.out`)
        writeFileSync(outFile, text, 'utf8')
        if (!res.ok) {
          throw new Error(`[${node.id}] HTTP ${res.status}: ${text.slice(0, 200)}`)
        }
        return { file: outFile, status: res.status, bytes: text.length }
      } catch (err) {
        if (err.name === 'AbortError') throw new Error(`[${node.id}] 请求超时 ${timeoutMs}ms`)
        throw err
      } finally {
        clearTimeout(timer)
      }
    },
  },

  // ── human：人在环，不批准就中断 ───────────────────────────
  'human.approve': {
    kind: 'human',
    determinism: 'deterministic',
    inputs: -1,
    run({ node, services }) {
      const { message = '确认继续？' } = node.params ?? {}
      const ok = services.approve(message, { nodeId: node.id })
      if (!ok) throw new Error(`[${node.id}] 人工审批未通过`)
      return { file: null, approved: true }
    },
  },

  // ── memory：跨运行状态（TWG 自己的，不是天枢记忆系统） ─────
  'memory.get': {
    kind: 'memory',
    // 读外部状态 → 同一张图在不同时刻可能拿到不同值，按不确定处理
    determinism: 'stochastic',
    inputs: -1,
    run({ node, workDir, db }) {
      if (!db) throw new Error(`[${node.id}] memory 节点需要证据账本（storage），当前没有`)
      const { key, defaultValue, valueType = 'text' } = node.params ?? {}
      if (!key) throw new Error(`[${node.id}] memory.get 需要 params.key`)
      if (valueType !== 'text' && valueType !== 'base64') {
        throw new Error(`[${node.id}] valueType 只能是 text 或 base64，收到 ${valueType}`)
      }
      const row = memoryGet(db, key)
      const value = row ? row.value : (defaultValue ?? null)
      if (value == null) throw new Error(`[${node.id}] 记忆里没有 key: ${key}，且未给 defaultValue`)
      const outFile = join(workDir, `${node.id}.mem`)
      if (valueType === 'base64') {
        writeFileSync(outFile, Buffer.from(String(value), 'base64'))
      } else {
        writeFileSync(outFile, String(value), 'utf8')
      }
      return { file: outFile, key, valueType, fromMemory: !!row }
    },
  },

  'memory.set': {
    kind: 'memory',
    // 只写不读：产物不依赖它，不影响下游确定性
    determinism: 'deterministic',
    inputs: -1,
    run({ node, inputs, db, runId }) {
      if (!db) throw new Error(`[${node.id}] memory 节点需要证据账本（storage），当前没有`)
      const { key, valueType = 'text' } = node.params ?? {}
      if (!key) throw new Error(`[${node.id}] memory.set 需要 params.key`)
      if (valueType !== 'text' && valueType !== 'base64') {
        throw new Error(`[${node.id}] valueType 只能是 text 或 base64，收到 ${valueType}`)
      }
      let value = node.params?.value
      if (inputs.length > 0 && inputs[0].file) {
        value = valueType === 'base64'
          ? readFileSync(inputs[0].file).toString('base64')
          : readFileSync(inputs[0].file, 'utf8')
      }
      if (value == null) throw new Error(`[${node.id}] memory.set 需要上游产物或 params.value`)
      const rec = memorySet(db, key, String(value), runId)
      return { file: null, key, valueType, bytes: String(value).length, updatedAt: rec.updated_at }
    },
  },
}

export function getOp(node) {
  const op = OPS[node.op]
  if (!op) throw new Error(`未知 op: ${node.op}（节点 ${node.id}）`)
  if (op.kind !== node.type) {
    throw new Error(`节点 ${node.id} 声明类型 ${node.type}，但 op ${node.op} 是 ${op.kind}`)
  }
  return op
}
