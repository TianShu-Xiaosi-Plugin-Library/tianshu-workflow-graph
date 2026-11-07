import test from 'node:test'
import assert from 'node:assert/strict'
import { validate, topoSort, load } from '../lib/graph.mjs'

const node = (id, extra = {}) => ({ id, type: 'compute', op: 'ffmpeg.testsrc', ...extra })

test('validate: 空图报错', () => {
  assert.deepEqual(validate({ nodes: [] }), ['nodes 不能为空'])
})

test('validate: 缺 id 报错', () => {
  const errs = validate({ nodes: [{ type: 'compute', op: 'x' }] })
  assert.ok(errs.some((e) => e.includes('缺少 id')))
})

test('validate: id 重复报错', () => {
  const errs = validate({ nodes: [node('a'), node('a')] })
  assert.ok(errs.some((e) => e.includes('id 重复')))
})

test('validate: 非法类型报错', () => {
  const errs = validate({ nodes: [node('a', { type: 'bogus' })] })
  assert.ok(errs.some((e) => e.includes('类型非法')))
})

test('validate: 引用不存在的输入报错', () => {
  const errs = validate({ nodes: [node('a', { type: 'render', inputs: ['ghost'] })] })
  assert.ok(errs.some((e) => e.includes('不存在的输入')))
})

test('topoSort: 线性图按依赖排序', () => {
  const g = { nodes: [node('c', { type: 'render', inputs: ['b'] }), node('b', { type: 'render', inputs: ['a'] }), node('a')] }
  assert.deepEqual(topoSort(g).map((n) => n.id), ['a', 'b', 'c'])
})

test('topoSort: 菱形图保证依赖先于消费者', () => {
  const g = {
    nodes: [
      node('root'),
      node('left', { type: 'render', inputs: ['root'] }),
      node('right', { type: 'render', inputs: ['root'] }),
      node('join', { type: 'render', inputs: ['left', 'right'] }),
    ],
  }
  const order = topoSort(g).map((n) => n.id)
  assert.equal(order[0], 'root')
  assert.equal(order.at(-1), 'join')
  assert.ok(order.indexOf('left') < order.indexOf('join'))
  assert.ok(order.indexOf('right') < order.indexOf('join'))
})

test('topoSort: 有环必须抛错并点名', () => {
  const g = {
    nodes: [
      node('a', { type: 'render', inputs: ['b'] }),
      node('b', { type: 'render', inputs: ['a'] }),
    ],
  }
  assert.throws(() => topoSort(g), /图存在环/)
})

test('load: 合法图原样返回', () => {
  const g = { nodes: [node('a')], outputs: {} }
  assert.equal(load(g), g)
})

test('load: 非法图抛错并列出全部原因', () => {
  assert.throws(() => load({ nodes: [] }), /图校验失败/)
})
