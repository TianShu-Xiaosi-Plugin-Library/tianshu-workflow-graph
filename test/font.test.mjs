import test from 'node:test'
import assert from 'node:assert/strict'
import { needsCjkFont, pickFontFile } from '../lib/nodes.mjs'

// ── 何时需要中文字体 ────────────────────────────────────

test('needsCjkFont: 中文返回 true', () => {
  assert.equal(needsCjkFont('葡萄成熟时'), true)
})

test('needsCjkFont: 中文标点返回 true', () => {
  assert.equal(needsCjkFont('改我：这一行字幕'), true)
})

test('needsCjkFont: 纯英文返回 false', () => {
  assert.equal(needsCjkFont('Ripe grapes hang heavy'), false)
})

test('needsCjkFont: 空串返回 false', () => {
  assert.equal(needsCjkFont(''), false)
})

// ── 字体文件解析 ────────────────────────────────────────

test('pickFontFile: 显式路径不存在时报错并点名', () => {
  assert.throws(() => pickFontFile('D:/no-such-dir/none.ttc'), /字体不存在/)
})

test('pickFontFile: 不传参数时能在本机找到一款中文字体', () => {
  const f = pickFontFile()
  assert.ok(f, '本机未找到任何候选中文字体')
  assert.ok(f.length > 0)
})
