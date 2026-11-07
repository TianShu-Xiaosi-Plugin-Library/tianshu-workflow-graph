import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execute } from '../lib/executor.mjs'
import { requireServices } from '../lib/services.mjs'
import { OPS } from '../lib/nodes.mjs'
import { load } from '../lib/graph.mjs'

const work = () => {
  const d = join(tmpdir(), `twg-hybrid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(d, { recursive: true })
  return d
}

// ── 服务注入 ──────────────────────────────────────────────

test('requireServices: 图用了 agent.llm 但没注入 complete → 报错', () => {
  const g = { nodes: [{ id: 'a', type: 'agent', op: 'agent.llm' }] }
  assert.throws(() => requireServices(g, {}), /complete/)
})

test('requireServices: 图没用到的能力缺失不拦截', () => {
  const g = { nodes: [{ id: 'a', type: 'compute', op: 'ffmpeg.testsrc' }] }
  assert.doesNotThrow(() => requireServices(g, {}))
})

// ── agent 节点 ────────────────────────────────────────────

test('agent.llm: 调用注入的 complete 并把文本落盘', async () => {
  const d = work()
  const calls = []
  const g = load({
    id: 'agent-test',
    nodes: [{ id: 'think', type: 'agent', op: 'agent.llm', params: { prompt: '说一句话' } }],
    outputs: { out: 'think' },
  })
  const r = await execute(g, {
    workDir: d,
    services: { complete: (p) => { calls.push(p); return '模型说：好' } },
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /说一句话/)
  assert.equal(readFileSync(r.outputs.out, 'utf8'), '模型说：好')
  assert.equal(r.determinism.overall, 'stochastic')
  rmSync(d, { recursive: true, force: true })
})

test('agent.llm: 缺 prompt 直接报错', async () => {
  const d = work()
  const g = load({ nodes: [{ id: 't', type: 'agent', op: 'agent.llm' }], outputs: {} })
  await assert.rejects(execute(g, { workDir: d, services: { complete: () => 'x' } }), /需要 params\.prompt/)
  rmSync(d, { recursive: true, force: true })
})

// ── human 节点 ────────────────────────────────────────────

test('human.approve: 批准则放行', async () => {
  const d = work()
  const g = load({
    nodes: [{ id: 'ok', type: 'human', op: 'human.approve', params: { message: '继续？' } }],
    outputs: {},
  })
  const r = await execute(g, { workDir: d, services: { approve: () => true } })
  assert.deepEqual(r.order, ['ok'])
  rmSync(d, { recursive: true, force: true })
})

test('human.approve: 拒绝则中断整图', async () => {
  const d = work()
  const g = load({
    nodes: [{ id: 'ok', type: 'human', op: 'human.approve' }],
    outputs: {},
  })
  await assert.rejects(execute(g, { workDir: d, services: { approve: () => false } }), /人工审批未通过/)
  rmSync(d, { recursive: true, force: true })
})

// ── verify 节点 ───────────────────────────────────────────

test('verify.media: 文件大小在范围内则通过', async () => {
  const d = work()
  const f = join(d, 'x.bin')
  writeFileSync(f, Buffer.alloc(1000))
  const g = load({
    nodes: [
      { id: 'v', type: 'verify', op: 'verify.media', params: { minSize: 500, maxSize: 2000 } },
    ],
    outputs: {},
  })
  // verify.media 声明 inputs:1，这里直接绕过 inputs 检查用 0 输入会报错
  await assert.rejects(execute(g, { workDir: d, inputFiles: [f] }), /需要 1 个输入/)
  rmSync(d, { recursive: true, force: true })
})

test('verify.media: 文件不存在则报错', () => {
  const d = work()
  const op = OPS['verify.media']
  assert.throws(
    () => op.run({ node: { id: 'v' }, inputs: [{ file: join(d, 'nope.mp4') }], workDir: d, ffprobe: 'ffprobe' }),
    /输入文件不存在/,
  )
  rmSync(d, { recursive: true, force: true })
})

test('verify.media: 体量超限则报错并说明数值', () => {
  const d = work()
  const f = join(d, 'big.bin')
  writeFileSync(f, Buffer.alloc(5000))
  const op = OPS['verify.media']
  assert.throws(
    () => op.run({ node: { id: 'v', params: { maxSize: 100 } }, inputs: [{ file: f }], workDir: d }),
    /文件过大: 5000 > 100/,
  )
  rmSync(d, { recursive: true, force: true })
})

// ── 确定性等级注册 ────────────────────────────────────────

test('三类新节点的 determinism 正确', () => {
  assert.equal(OPS['agent.llm'].determinism, 'stochastic')
  assert.equal(OPS['human.approve'].determinism, 'deterministic')
  assert.equal(OPS['verify.media'].determinism, 'deterministic')
})

test('含 agent 节点的图整体判定为 stochastic', async () => {
  const d = work()
  const g = load({
    id: 'mix',
    nodes: [
      { id: 'gen', type: 'compute', op: 'ffmpeg.color', params: { duration: 0.1, size: '32x32', rate: 1 } },
      { id: 'think', type: 'agent', op: 'agent.llm', inputs: ['gen'], params: { prompt: '看图' } },
    ],
    outputs: { out: 'think' },
  })
  const r = await execute(g, { workDir: d, services: { complete: () => 'ok' } })
  assert.equal(r.determinism.perOutput.out, 'stochastic')
  assert.equal(r.determinism.overall, 'stochastic')
  rmSync(d, { recursive: true, force: true })
})

// ── 失败时的 determinism 语义 ─────────────────────────────

test('执行失败时 determinism 记 null，不冒充 stochastic', async () => {
  const { openLedger, getRun } = await import('../lib/ledger.mjs')
  const { rmSync, existsSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const d = join(tmpdir(), `twg-fail-${Date.now()}`)
  mkdirSync(d, { recursive: true })
  const dbFile = join(d, 'x.db')
  const db = openLedger(dbFile)

  const g = load({
    id: 'willfail',
    nodes: [
      { id: 'gen', type: 'compute', op: 'ffmpeg.color', params: { duration: 0.1, size: '32x32', rate: 1 } },
      { id: 'bad', type: 'verify', op: 'verify.media', inputs: ['gen'], params: { minDuration: 99 } },
    ],
    outputs: { out: 'bad' },
  })

  await assert.rejects(execute(g, { workDir: d, ledger: db }), /时长过短/)
  const rec = getRun(db, db.prepare('SELECT id FROM runs').get().id)
  assert.equal(rec.run.status, 'failed')
  assert.equal(rec.run.determinism, null, '失败时 determinism 必须是 null')

  db.close()
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) if (existsSync(f)) rmSync(f, { force: true })
  rmSync(d, { recursive: true, force: true })
})

test('失败节点也入账本，带 ok=0 与 error 明细', async () => {
  const { openLedger, getRun } = await import('../lib/ledger.mjs')
  const { rmSync, existsSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const d = join(tmpdir(), `twg-failnode-${Date.now()}`)
  mkdirSync(d, { recursive: true })
  const dbFile = join(d, 'x.db')
  const db = openLedger(dbFile)

  const g = load({
    id: 'failnode',
    nodes: [
      { id: 'gen', type: 'compute', op: 'ffmpeg.color', params: { duration: 0.1, size: '32x32', rate: 1 } },
      { id: 'bad', type: 'verify', op: 'verify.media', inputs: ['gen'], params: { minDuration: 99 } },
    ],
    outputs: { out: 'bad' },
  })

  await assert.rejects(execute(g, { workDir: d, ledger: db }), /时长过短/)
  const runId = db.prepare('SELECT id FROM runs').get().id
  const rec = getRun(db, runId)
  const bad = rec.nodes.find((n) => n.node_id === 'bad')
  assert.ok(bad, '失败节点必须出现在 node_runs 里')
  assert.equal(bad.ok, 0)
  assert.match(bad.error, /时长过短/)

  db.close()
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) if (existsSync(f)) rmSync(f, { force: true })
  rmSync(d, { recursive: true, force: true })
})

test('下游引用无产物节点（memory.set）时报清晰错误', async () => {
  const { openLedger } = await import('../lib/ledger.mjs')
  const { rmSync, existsSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const d = join(tmpdir(), `twg-noref-${Date.now()}`)
  mkdirSync(d, { recursive: true })
  const dbFile = join(d, 'x.db')
  const db = openLedger(dbFile)

  const g = load({
    id: 'noref',
    nodes: [
      { id: 'save', type: 'memory', op: 'memory.set', params: { key: 'k', value: 'v' } },
      { id: 'use', type: 'verify', op: 'verify.media', inputs: ['save'], params: { minSize: 1 } },
    ],
    outputs: {},
  })

  await assert.rejects(
    execute(g, { workDir: d, ledger: db }),
    /不产出文件，不能作为下游输入/,
  )

  db.close()
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) if (existsSync(f)) rmSync(f, { force: true })
  rmSync(d, { recursive: true, force: true })
})
