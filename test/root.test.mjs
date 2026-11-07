import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { resolveBaseDir } from '../lib/executor.mjs'
import { validate } from '../lib/graph.mjs'

test('resolveBaseDir: 默认相对会话工作区', () => {
  const cwd = process.platform === 'win32' ? 'D:/pro' : '/pro'
  assert.equal(resolveBaseDir({}, { cwd }), cwd)
  assert.equal(resolveBaseDir({ root: 'workspace' }, { cwd }), cwd)
})

test('resolveBaseDir: root=graph 时相对图文件所在目录', () => {
  const gp = process.platform === 'win32' ? 'D:/pro/twg/templates/a.twg.json' : '/pro/twg/templates/a.twg.json'
  assert.equal(resolveBaseDir({ root: 'graph' }, { graphPath: gp, cwd: 'D:/other' }), dirname(resolve(gp)))
})

test('resolveBaseDir: root=graph 但缺 graphPath 时报错', () => {
  assert.throws(() => resolveBaseDir({ root: 'graph' }, {}), /没传图文件路径/)
})

test('validate: root 只接受 graph / workspace，其他值报错', () => {
  const base = { nodes: [{ id: 'a', type: 'compute', op: 'ffmpeg.color' }] }
  assert.deepEqual(validate({ ...base, root: 'graph' }), [])
  assert.deepEqual(validate({ ...base, root: 'workspace' }), [])
  assert.deepEqual(validate({ ...base }), [])
  const errs = validate({ ...base, root: 'absolute' })
  assert.ok(errs.some((e) => e.includes('root 只能是')))
})
