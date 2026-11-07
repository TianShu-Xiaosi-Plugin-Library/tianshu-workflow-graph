import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { weakest, pathDeterminism, graphDeterminism } from '../lib/determinism.mjs'
import { openLedger, recordRun, getRun, listRuns, lastSuccessfulRun } from '../lib/ledger.mjs'

const dbfile = (name) => join(tmpdir(), `twg-test-${name}-${Date.now()}.db`)
const clean = (f) => { for (const s of [f, f + '-wal', f + '-shm']) if (existsSync(s)) rmSync(s, { force: true }) }

// ── 确定性传播 ────────────────────────────────────────────

test('weakest: deterministic + stochastic = stochastic', () => {
  assert.equal(weakest('deterministic', 'stochastic'), 'stochastic')
  assert.equal(weakest('seeded', 'deterministic'), 'seeded')
  assert.equal(weakest('deterministic', 'deterministic'), 'deterministic')
})

test('weakest: 未知等级按最不确定处理', () => {
  assert.equal(weakest('deterministic', 'bogus'), 'stochastic')
})

test('pathDeterminism: 线性图取上游最弱', () => {
  const g = {
    nodes: [
      { id: 'a', type: 'compute', op: 'x' },
      { id: 'b', type: 'render', op: 'y', inputs: ['a'] },
      { id: 'c', type: 'render', op: 'z', inputs: ['b'] },
    ],
  }
  const det = new Map([['a', 'deterministic'], ['b', 'seeded'], ['c', 'deterministic']])
  assert.equal(pathDeterminism(g, 'c', det), 'seeded')
})

test('pathDeterminism: 菱形图取所有路径的最弱', () => {
  const g = {
    nodes: [
      { id: 'root', type: 'compute', op: 'x' },
      { id: 'left', type: 'render', op: 'y', inputs: ['root'] },
      { id: 'right', type: 'render', op: 'z', inputs: ['root'] },
      { id: 'join', type: 'render', op: 'w', inputs: ['left', 'right'] },
    ],
  }
  const det = new Map([
    ['root', 'deterministic'], ['left', 'deterministic'],
    ['right', 'stochastic'], ['join', 'deterministic'],
  ])
  assert.equal(pathDeterminism(g, 'join', det), 'stochastic')
})

test('graphDeterminism: 多输出分别计算并汇总', () => {
  const g = {
    nodes: [
      { id: 'a', type: 'compute', op: 'x' },
      { id: 'b', type: 'compute', op: 'y' },
    ],
    outputs: { clean: 'a', risky: 'b' },
  }
  const det = new Map([['a', 'deterministic'], ['b', 'seeded']])
  const r = graphDeterminism(g, det)
  assert.equal(r.perOutput.clean, 'deterministic')
  assert.equal(r.perOutput.risky, 'seeded')
  assert.equal(r.overall, 'seeded')
})

// ── 账本 ──────────────────────────────────────────────────

test('ledger: 写入后能原样读回', () => {
  const f = dbfile('rw'); clean(f)
  const db = openLedger(f)
  recordRun(db, {
    runId: 'r1', graphId: 'g1', graphHash: 'abc123',
    startedAt: 1000, finishedAt: 2000, status: 'ok', determinism: 'seeded',
    nodes: [
      { nodeId: 'n1', op: 'ffmpeg.testsrc', kind: 'compute', determinism: 'deterministic', params: { duration: 2 }, inputs: null, outputFile: '/x/a.mp4', durationMs: 12.5, ok: true },
    ],
    outputs: { main: '/x/a.mp4' },
    error: null,
  })
  const got = getRun(db, 'r1')
  assert.equal(got.run.status, 'ok')
  assert.equal(got.run.graph_hash, 'abc123')
  assert.equal(got.nodes.length, 1)
  assert.equal(got.nodes[0].node_id, 'n1')
  assert.equal(JSON.parse(got.nodes[0].params_json).duration, 2)
  db.close(); clean(f)
})

test('ledger: 失败的运行也留档', () => {
  const f = dbfile('fail'); clean(f)
  const db = openLedger(f)
  recordRun(db, {
    runId: 'r2', graphId: 'g1', graphHash: 'h', startedAt: 1, finishedAt: 2,
    status: 'failed', determinism: null, nodes: [], outputs: null, error: 'ffmpeg 挂了',
  })
  const got = getRun(db, 'r2')
  assert.equal(got.run.status, 'failed')
  assert.equal(got.run.error, 'ffmpeg 挂了')
  db.close(); clean(f)
})

test('ledger: 同一 run_id 重复写入必须整体失败（主键冲突）', () => {
  const f = dbfile('dup'); clean(f)
  const db = openLedger(f)
  const rec = {
    runId: 'dup1', graphId: 'g', graphHash: 'h', startedAt: 1, finishedAt: 2,
    status: 'ok', determinism: 'deterministic', nodes: [], outputs: null, error: null,
  }
  recordRun(db, rec)
  assert.throws(() => recordRun(db, rec))
  // 事务回滚后账本里仍只有 1 条
  assert.equal(listRuns(db).length, 1)
  db.close(); clean(f)
})

test('ledger: lastSuccessfulRun 跳过失败记录', () => {
  const f = dbfile('last'); clean(f)
  const db = openLedger(f)
  const base = { graphId: 'gg', graphHash: 'h', nodes: [], outputs: null, error: null }
  recordRun(db, { ...base, runId: 'a', startedAt: 10, finishedAt: 11, status: 'failed', determinism: null })
  recordRun(db, { ...base, runId: 'b', startedAt: 20, finishedAt: 21, status: 'ok', determinism: 'deterministic' })
  const last = lastSuccessfulRun(db, 'gg')
  assert.equal(last.id, 'b')
  db.close(); clean(f)
})

// ── schema 迁移 ───────────────────────────────────────────

test('迁移: 老库缺少 error 列时自动补齐，历史数据不丢', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const f = dbfile('migrate'); clean(f)

  // 手工造一个"旧版"库：node_runs 没有 error 列
  const old = new DatabaseSync(f)
  old.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, graph_id TEXT, graph_hash TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
      determinism TEXT, outputs_json TEXT, error TEXT
    );
    CREATE TABLE node_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
      op TEXT NOT NULL, kind TEXT NOT NULL, determinism TEXT NOT NULL,
      params_json TEXT, inputs_json TEXT, output_file TEXT, duration_ms REAL,
      ok INTEGER NOT NULL
    );
  `)
  old.prepare(`INSERT INTO node_runs (run_id,node_id,op,kind,determinism,ok) VALUES (?,?,?,?,?,?)`)
    .run('r-old', 'n1', 'ffmpeg.color', 'compute', 'deterministic', 1)
  const before = old.prepare('PRAGMA table_info(node_runs)').all().map((c) => c.name)
  assert.ok(!before.includes('error'), '前提：旧库确实没有 error 列')
  old.close()

  // 走正常入口，应触发 migrate
  const db = openLedger(f)
  const after = db.prepare('PRAGMA table_info(node_runs)').all().map((c) => c.name)
  assert.ok(after.includes('error'), '迁移后必须有 error 列')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM node_runs').get().c, 1, '历史记录不能丢')
  assert.equal(db.prepare('SELECT node_id FROM node_runs').get().node_id, 'n1')
  db.close(); clean(f)
})

test('迁移: 幂等——重复 openLedger 不出错', () => {
  const f = dbfile('migrate'); clean(f)
  openLedger(f).close()
  const db = openLedger(f)   // 第二次打开，error 列已存在
  const cols = db.prepare('PRAGMA table_info(node_runs)').all().map((c) => c.name)
  assert.equal(cols.filter((c) => c === 'error').length, 1, 'error 列不能重复添加')
  db.close(); clean(f)
})
