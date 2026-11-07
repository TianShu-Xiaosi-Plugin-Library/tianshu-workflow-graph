import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { openLedger, memoryGet, memorySet, memoryList } from '../lib/ledger.mjs'
import { OPS } from '../lib/nodes.mjs'
import { load } from '../lib/graph.mjs'

const dbf = () => join(tmpdir(), `twg-mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`)
const clean = (f) => { for (const s of [f, f + '-wal', f + '-shm']) if (existsSync(s)) rmSync(s, { force: true }) }
const work = () => {
  const d = join(tmpdir(), `twg-memw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(d, { recursive: true }); return d
}

test('memorySet/memoryGet: 写入后读回', () => {
  const f = dbf(); const db = openLedger(f)
  memorySet(db, 'brand', 'teal', 'run-1')
  const got = memoryGet(db, 'brand')
  assert.equal(got.value, 'teal')
  assert.equal(got.run_id, 'run-1')
  db.close(); clean(f)
})

test('memorySet: 同 key 覆盖而不是报错', () => {
  const f = dbf(); const db = openLedger(f)
  memorySet(db, 'k', 'v1', 'r1')
  memorySet(db, 'k', 'v2', 'r2')
  assert.equal(memoryGet(db, 'k').value, 'v2')
  assert.equal(memoryList(db).length, 1)
  db.close(); clean(f)
})

test('memoryGet: 不存在的 key 返回 null', () => {
  const f = dbf(); const db = openLedger(f)
  assert.equal(memoryGet(db, 'nope'), null)
  db.close(); clean(f)
})

test('memory.set 节点: 存上游产物内容', async () => {
  const f = dbf(); const db = openLedger(f); const d = work()
  const src = join(d, 'in.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(src, 'upstream-value')
  const out = OPS['memory.set'].run({
    node: { id: 'm', params: { key: 'k1' } }, inputs: [{ file: src }], db, runId: 'r9',
  })
  assert.equal(out.key, 'k1')
  assert.equal(memoryGet(db, 'k1').value, 'upstream-value')
  db.close(); clean(f); rmSync(d, { recursive: true, force: true })
})

test('memory.get 节点: 读回并落盘', () => {
  const f = dbf(); const db = openLedger(f); const d = work()
  memorySet(db, 'k2', 'stored', 'r1')
  const out = OPS['memory.get'].run({ node: { id: 'm', params: { key: 'k2' } }, workDir: d, db })
  assert.equal(out.fromMemory, true)
  assert.equal(readFileSync(out.file, 'utf8'), 'stored')
  db.close(); clean(f); rmSync(d, { recursive: true, force: true })
})

test('memory.get 节点: 缺 key 且无 defaultValue 时抛错', () => {
  const f = dbf(); const db = openLedger(f); const d = work()
  assert.throws(
    () => OPS['memory.get'].run({ node: { id: 'm', params: { key: 'missing' } }, workDir: d, db }),
    /记忆里没有 key: missing/,
  )
  db.close(); clean(f); rmSync(d, { recursive: true, force: true })
})

test('memory.get 节点: 有 defaultValue 时用默认值', () => {
  const f = dbf(); const db = openLedger(f); const d = work()
  const out = OPS['memory.get'].run({
    node: { id: 'm', params: { key: 'missing', defaultValue: 'fallback' } }, workDir: d, db,
  })
  assert.equal(out.fromMemory, false)
  assert.equal(readFileSync(out.file, 'utf8'), 'fallback')
  db.close(); clean(f); rmSync(d, { recursive: true, force: true })
})

test('memory 节点: 没有 db 时大声失败', () => {
  const d = work()
  assert.throws(
    () => OPS['memory.get'].run({ node: { id: 'm', params: { key: 'x' } }, workDir: d }),
    /需要证据账本/,
  )
  rmSync(d, { recursive: true, force: true })
})

test('memory 节点确定性: get=stochastic, set=deterministic', () => {
  assert.equal(OPS['memory.get'].determinism, 'stochastic')
  assert.equal(OPS['memory.set'].determinism, 'deterministic')
  assert.equal(OPS['memory.get'].kind, 'memory')
  assert.equal(OPS['memory.set'].kind, 'memory')
})

// ── 二进制往返与传播 ──────────────────────────────────────

test('memory.set/get base64: 二进制往返逐字节一致', () => {
  const f = dbf(); const db = openLedger(f); const d = work()
  // 含 0x00 / 0xFF / PNG 魔数，utf8 读会失真
  const bin = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfe, 0x00])
  const src = join(d, 'x.bin')
  writeFileSync(src, bin)
  OPS['memory.set'].run({
    node: { id: 'm', params: { key: 'bin', valueType: 'base64' } },
    inputs: [{ file: src }], db, runId: 'r',
  })
  const stored = memoryGet(db, 'bin').value
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(stored), '存储值应为 base64')
  const out = OPS['memory.get'].run({
    node: { id: 'g', params: { key: 'bin', valueType: 'base64' } }, workDir: d, db,
  })
  const round = readFileSync(out.file)
  assert.equal(round.length, bin.length)
  assert.deepEqual([...round], [...bin])
  db.close(); clean(f); rmSync(d, { recursive: true, force: true })
})

test('memory 节点: 非法 valueType 报错', () => {
  const f = dbf(); const db = openLedger(f); const d = work()
  assert.throws(
    () => OPS['memory.get'].run({ node: { id: 'g', params: { key: 'k', valueType: 'hex' } }, workDir: d, db }),
    /valueType 只能是 text 或 base64/,
  )
  db.close(); clean(f); rmSync(d, { recursive: true, force: true })
})

test('memory.get 的 stochastic 传播到下游 deterministic 节点', async () => {
  const { execute } = await import('../lib/executor.mjs')
  const f = dbf(); const db = openLedger(f); const d = work()
  const g = load({
    id: 'prop',
    nodes: [
      { id: 'read', type: 'memory', op: 'memory.get', params: { key: 'nope', defaultValue: 'v' } },
      { id: 'save', type: 'memory', op: 'memory.set', inputs: ['read'], params: { key: 'copy' } },
    ],
    outputs: { final: 'save' },
  })
  const r = await execute(g, { workDir: d, ledger: db })
  // save 自身 deterministic，但它依赖 read（stochastic）
  assert.equal(r.determinism.perOutput.final, 'stochastic')
  assert.equal(r.determinism.overall, 'stochastic')
  db.close(); clean(f); rmSync(d, { recursive: true, force: true })
})
