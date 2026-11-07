// SQLite 证据账本：一次运行 = 一个事务
// 实测依据：逐条写 300 节点 477ms（阻塞宿主会话），事务批量 5.5ms。
// 所以这里的设计是"执行时收集到内存，结束时一次性落盘"，不是逐节点写。
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  graph_id      TEXT,
  graph_hash    TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,
  determinism   TEXT,
  outputs_json  TEXT,
  error         TEXT
);
CREATE TABLE IF NOT EXISTS node_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  op            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  determinism   TEXT NOT NULL,
  params_json   TEXT,
  inputs_json   TEXT,
  output_file   TEXT,
  duration_ms   REAL,
  ok            INTEGER NOT NULL,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_runs_run ON node_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_graph ON runs(graph_id);
CREATE TABLE IF NOT EXISTS memory (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  run_id      TEXT
);
`

/** 对已打开的 db 建表并设置 WAL——宿主经 host.storage.openDatabase() 给的连接走这里 */
export function initLedger(db) {
  // 并发打开同一个库时，切换 WAL 需要锁；不设 busy_timeout 会直接 database is locked。
  // 必须先设超时，再做任何需要写锁的 PRAGMA。
  db.exec('PRAGMA busy_timeout = 10000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * 轻量迁移：老库的 node_runs 没有 error 列，补上。
 * 只做"加列"这一种——不做破坏性变更（改名/删列会丢历史证据）。
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(node_runs)').all().map((c) => c.name)
  if (!cols.includes('error')) {
    db.exec('ALTER TABLE node_runs ADD COLUMN error TEXT')
  }
}

/** 打开（或创建）账本。WAL 是必须的——默认 journal 每条 4ms。 */
export function openLedger(dbPath) {
  return initLedger(new DatabaseSync(dbPath))
}

/**
 * 写入一次完整运行。所有 INSERT 在同一个事务里。
 * @param {DatabaseSync} db
 * @param {object} rec
 * @param {string} rec.runId
 * @param {string|null} rec.graphId
 * @param {string} rec.graphHash
 * @param {number} rec.startedAt
 * @param {number} rec.finishedAt
 * @param {'ok'|'failed'} rec.status
 * @param {string|null} rec.determinism
 * @param {Array} rec.nodes  每个节点的执行记录
 * @param {object|null} rec.outputs
 * @param {string|null} rec.error
 */
export function recordRun(db, rec) {
  const insertRun = db.prepare(`
    INSERT INTO runs (id, graph_id, graph_hash, started_at, finished_at, status, determinism, outputs_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertNode = db.prepare(`
    INSERT INTO node_runs (run_id, node_id, op, kind, determinism, params_json, inputs_json, output_file, duration_ms, ok, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  db.exec('BEGIN')
  try {
    insertRun.run(
      rec.runId,
      rec.graphId ?? null,
      rec.graphHash,
      rec.startedAt,
      rec.finishedAt ?? null,
      rec.status,
      rec.determinism ?? null,
      rec.outputs ? JSON.stringify(rec.outputs) : null,
      rec.error ?? null,
    )
    for (const n of rec.nodes ?? []) {
      insertNode.run(
        rec.runId,
        n.nodeId,
        n.op,
        n.kind,
        n.determinism,
        n.params ? JSON.stringify(n.params) : null,
        n.inputs ? JSON.stringify(n.inputs) : null,
        n.outputFile ?? null,
        n.durationMs ?? null,
        n.ok ? 1 : 0,
        n.error ?? null,
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 读一次运行的完整记录 */
export function getRun(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (!run) return null
  const nodes = db.prepare('SELECT * FROM node_runs WHERE run_id = ? ORDER BY id').all(runId)
  return { run, nodes }
}

/** 列最近的运行 */
export function listRuns(db, limit = 20) {
  return db.prepare(
    'SELECT id, graph_id, status, determinism, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT ?',
  ).all(limit)
}

/**
 * 取某张图最近一次成功运行——用于"同图复现"检查。
 */
export function lastSuccessfulRun(db, graphId) {
  return db.prepare(
    `SELECT * FROM runs WHERE graph_id = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 1`,
  ).get(graphId) ?? null
}

// ── 跨运行状态（memory 节点用） ─────────────────────────────
// 注意边界：这是 TWG 自己的状态，不是天枢的记忆系统。
// 宿主没有开放记忆能力给插件，跨插件读 xiaosi-axiom 的库不成立。

/** 读一个键；不存在返回 null（调用方决定这是错误还是默认值） */
export function memoryGet(db, key) {
  const row = db.prepare('SELECT key, value, updated_at, run_id FROM memory WHERE key = ?').get(key)
  return row ?? null
}

/** 写一个键（覆盖） */
export function memorySet(db, key, value, runId) {
  db.prepare(
    `INSERT INTO memory (key, value, updated_at, run_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, run_id = excluded.run_id`,
  ).run(key, value, Date.now(), runId ?? null)
  return { key, value, updated_at: Date.now(), run_id: runId ?? null }
}

/** 列出所有键（调试与人工检查用） */
export function memoryList(db, limit = 100) {
  return db.prepare('SELECT key, updated_at, run_id, length(value) AS bytes FROM memory ORDER BY updated_at DESC LIMIT ?').all(limit)
}
