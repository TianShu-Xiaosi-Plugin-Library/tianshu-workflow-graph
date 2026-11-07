// 节点实现：compute / render 两类，全部落到外部 ffmpeg（用户自备，不打包）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync, realpathSync } from 'node:fs'
import { join, isAbsolute, resolve, relative } from 'node:path'
import { memoryGet, memorySet } from './ledger.mjs'

const ENV_PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 展开 ${env:NAME} 占位符，密钥由此进进程而不是进图。
 * 缺变量直接抛错——静默变成空串会把请求打到错误地址，比失败更难查。
 * 返回新值，不改动入参：调用方（账本）记录的是原始 node.params。
 */
export function resolveEnvVars(value, ctx = '') {
  if (typeof value === 'string') {
    return value.replace(ENV_PLACEHOLDER, (_, name) => {
      const v = process.env[name]
      if (v === undefined || v === '') throw new Error(`${ctx}环境变量 ${name} 未设置`)
      return v
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvVars(v, ctx))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvVars(v, ctx)
    return out
  }
  return value
}

/**
 * 从上游产物里取正文。上游可能是纯文本，也可能是各家模型的 JSON 响应。
 * 取不到正文时返回 null——把整串 JSON 画到画面上是更糟的失败。
 */
export function pickText(body) {
  const s = String(body ?? '').trim()
  if (!s) return ''
  if (!s.startsWith('{') && !s.startsWith('[')) return s

  let j
  try {
    j = JSON.parse(s)
  } catch {
    return s
  }
  if (typeof j === 'string') return j

  // 各家响应结构不同，按常见程度依次探测。顺序有意义：OpenAI 兼容最普遍，排最前。
  const picks = [
    () => j?.choices?.[0]?.message?.content,               // OpenAI 兼容（DeepSeek / Moonshot / 智谱…）
    () => j?.message?.content,                             // Ollama
    () => textBlocks(j?.content),                          // Anthropic：content[] {type:'text', text}
    () => textBlocks(j?.candidates?.[0]?.content?.parts),  // Gemini：candidates[0].content.parts[].text
    () => j?.output_text,                                  // OpenAI Responses API
    () => j?.text,                                         // Cohere
  ]
  for (const pick of picks) {
    const v = pick()
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/** 拼接文本块数组，跳过非文本块（tool_use / image 等） */
function textBlocks(blocks) {
  if (!Array.isArray(blocks)) return undefined
  const out = blocks
    .filter((b) => b && typeof b.text === 'string' && (b.type === undefined || b.type === 'text'))
    .map((b) => b.text)
  return out.length ? out.join('') : undefined
}

/**
 * drawtext 的 text 落在 filter 串里：单引号会闭合参数、冒号是参数分隔符、
 * 反斜杠会触发转义、换行会截断整条 filter。一律清掉再拼。
 */
export function sanitizeDrawtext(s, maxChars = 120) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[':\\]/g, '')
    .trim()
    .slice(0, maxChars)
}

/**
 * 文本里有没有需要中文字形的字符。drawtext 默认字体不含 CJK，
 * 不换字体会渲染成空心方块——静默画方块比报错更难查。
 */
export function needsCjkFont(s) {
  return /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(String(s ?? ''))
}

/**
 * 选字体文件：显式指定优先，否则在平台常见路径里找一个存在的中文字体。
 * 找不到返回 null，由调用方决定是报错还是继续。
 */
export function pickFontFile(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`字体不存在: ${explicit}`)
    return explicit
  }
  const candidates = process.platform === 'win32'
    ? ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc']
    : ['/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc']
  return candidates.find((p) => existsSync(p)) ?? null
}

/** fontfile 在 filter 串里的写法：正斜杠，冒号转义（否则会被当参数分隔符） */
function fontFileArg(p) {
  const norm = String(p).replace(/\\/g, '/')
  return `:fontfile='${norm.replace(/:/g, '\\:')}'`
}

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
  'ffmpeg.input': {
    kind: 'compute',
    determinism: 'deterministic',
    inputs: 0,
    run({ node, workDir, ffmpeg, cwd }) {
      const { path: src, start, duration } = node.params ?? {}
      if (!src) throw new Error(`[${node.id}] ffmpeg.input 需要 params.path`)

      // 路径守卫：只允许读基准目录内（root:"workspace" → 会话工作区；root:"graph" → 图文件目录）。
      // 图可能由 agent 生成，不能让它读整盘。
      const root = cwd ?? process.cwd()
      const abs = isAbsolute(src) ? src : resolve(root, src)
      const rel = relative(root, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`[${node.id}] 素材在基准目录外，拒绝读取: ${src}（基准目录: ${root}）`)
      }
      if (!existsSync(abs)) throw new Error(`[${node.id}] 素材不存在: ${src}`)

      // 符号链接可以绕过上面的字面路径检查：基准目录内的软链指向外部文件时，
      // 字面路径合法、真实路径越界。所以解析一次真实路径再判。
      // root 也解析一次——root 自身含软链时，不解析会误判。
      let realRoot
      let realFile
      try {
        realRoot = realpathSync(root)
        realFile = realpathSync(abs)
      } catch (err) {
        throw new Error(`[${node.id}] 素材路径无法解析: ${src}（${err.code ?? err.message}）`)
      }
      const realRel = relative(realRoot, realFile)
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new Error(`[${node.id}] 素材经符号链接指向基准目录外，拒绝读取: ${src}（真实路径: ${realFile}）`)
      }

      const outFile = join(workDir, `${node.id}.mp4`)
      const args = ['-hide_banner', '-loglevel', 'error']
      if (start != null) args.push('-ss', String(start))
      args.push('-i', abs)
      if (duration != null) args.push('-t', String(duration))
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', outFile)

      const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 300000, windowsHide: true })
      if (r.status !== 0) throw new Error(`[${node.id}] 读取素材失败: ${(r.stderr || '').slice(0, 300)}`)
      return { file: outFile }
    },
  },

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
    inputs: -1, // 1 个视频，可选再给 1 个文本来源
    run({ node, inputs, workDir, ffmpeg }) {
      if (inputs.length < 1 || inputs.length > 2) {
        throw new Error(`[${node.id}] drawtext 需要 1 个视频输入（可选再加 1 个文本来源），实际 ${inputs.length} 个`)
      }
      const src = inputs[0].file
      const { text, size = 40, x = 10, y = 10, maxChars = 120, fontfile } = node.params ?? {}

      // 文本来源：第二个输入优先于 params.text——上游给了文件就不再吃静态文案
      let raw = text
      if (inputs.length === 2) {
        const picked = pickText(readFileSync(inputs[1].file, 'utf8'))
        if (picked === null) {
          throw new Error(`[${node.id}] 上游 JSON 里取不到正文（支持 OpenAI 兼容 / Anthropic / Gemini / Ollama / Responses / Cohere 的响应结构），且未给 params.text`)
        }
        raw = picked
      }
      if (raw == null) throw new Error(`[${node.id}] drawtext 需要 params.text 或第二个输入（文本来源）`)

      const safe = sanitizeDrawtext(raw, maxChars)

      // 含 CJK 字符就得换字体，否则默认字体只能画出方块
      const font = (fontfile || needsCjkFont(safe)) ? pickFontFile(fontfile) : null
      if (needsCjkFont(safe) && !font) {
        throw new Error(`[${node.id}] 文本含中文但本机找不到中文字体，请用 params.fontfile 指定`)
      }
      const fontArg = font ? fontFileArg(font) : ''

      const outFile = join(workDir, `${node.id}.mp4`)
      const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-i', src,
        '-vf', `drawtext=text='${safe}'${fontArg}:fontsize=${size}:fontcolor=white:x=${x}:y=${y}`,
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

      const ctx = `[${node.id}] `
      const target = resolveEnvVars(url, ctx)
      const extraHeaders = resolveEnvVars(headers, ctx)

      let parsed
      try {
        parsed = new URL(target)
      } catch {
        // 报错用未展开的模板：展开结果里可能含密钥，不能进错误信息
        throw new Error(`[${node.id}] url 非法: ${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`[${node.id}] 只允许 http/https，收到 ${parsed.protocol}`)
      }

      // 有上游输入且没显式给 body 时，把第一个产物文件当请求体
      let payload = body === undefined ? null : resolveEnvVars(body, ctx)
      if (payload == null && inputs.length > 0 && inputs[0].file) {
        payload = readFileSync(inputs[0].file, 'utf8')
      }

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(parsed, {
          method,
          headers: extraHeaders,
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
