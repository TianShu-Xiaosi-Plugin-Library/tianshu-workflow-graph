import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { OPS, pickText, sanitizeDrawtext } from '../lib/nodes.mjs'

const work = () => {
  const d = join(tmpdir(), `twg-txt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(d, { recursive: true })
  return d
}

// ── 纯函数：从上游响应里取正文 ──────────────────────────

test('pickText: 纯文本原样返回', () => {
  assert.equal(pickText('ripe grapes'), 'ripe grapes')
})

test('pickText: OpenAI 兼容 JSON 取 choices[0].message.content', () => {
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'Deep purple clusters.' } }],
  })
  assert.equal(pickText(body), 'Deep purple clusters.')
})

test('pickText: JSON 对象里取不到正文时返回 null', () => {
  assert.equal(pickText('{"status":"ok"}'), null)
})

test('pickText: 不是 JSON 的文本按原文返回', () => {
  assert.equal(pickText('{not json'), '{not json')
})

// ── 纯函数：drawtext filter 参数清洗 ────────────────────
//
// filter 语法是 drawtext=text='...':fontsize=...，文本里出现单引号会闭合、
// 冒号会被当参数分隔符、反斜杠会转义、换行会破坏整行——都必须处理掉。

test('sanitizeDrawtext: 换行与制表折叠成单空格', () => {
  assert.equal(sanitizeDrawtext('line one\nline two\ttabbed'), 'line one line two tabbed')
})

test('sanitizeDrawtext: 单引号、冒号、反斜杠被移除', () => {
  assert.equal(sanitizeDrawtext("it's a:b\\c"), 'its abc')
})

test('sanitizeDrawtext: 超长文本按 maxChars 截断', () => {
  const long = 'a'.repeat(200)
  assert.equal(sanitizeDrawtext(long, 20).length, 20)
})

test('sanitizeDrawtext: 首尾空白被去掉', () => {
  assert.equal(sanitizeDrawtext('  ripe  '), 'ripe')
})

// ── 节点输入契约（错误路径不需要碰 ffmpeg）──────────────

test('drawtext: 没有输入时报错', () => {
  assert.throws(
    () => OPS['ffmpeg.drawtext'].run({ node: { id: 'd', params: { text: 'x' } }, inputs: [], workDir: work() }),
    /需要 1 个视频输入/,
  )
})

test('drawtext: 三个输入时报错', () => {
  const d = work()
  const f = join(d, 'a.txt')
  writeFileSync(f, 'x')
  assert.throws(
    () => OPS['ffmpeg.drawtext'].run({
      node: { id: 'd', params: { text: 'x' } },
      inputs: [{ file: f }, { file: f }, { file: f }],
      workDir: d,
    }),
    /需要 1 个视频输入/,
  )
  rmSync(d, { recursive: true, force: true })
})

test('drawtext: 两个输入但上游 JSON 取不到正文时报错', () => {
  const d = work()
  const video = join(d, 'v.mp4')
  const txt = join(d, 't.out')
  writeFileSync(video, '')
  writeFileSync(txt, '{"status":"ok"}')
  assert.throws(
    () => OPS['ffmpeg.drawtext'].run({
      node: { id: 'd', params: {} },
      inputs: [{ file: video }, { file: txt }],
      workDir: d,
    }),
    /取不到正文|需要 params\.text/,
  )
  rmSync(d, { recursive: true, force: true })
})

test('drawtext: 既无 params.text 也只有一个输入时报错', () => {
  const d = work()
  const video = join(d, 'v.mp4')
  writeFileSync(video, '')
  assert.throws(
    () => OPS['ffmpeg.drawtext'].run({
      node: { id: 'd', params: {} },
      inputs: [{ file: video }],
      workDir: d,
    }),
    /需要 params\.text/,
  )
  rmSync(d, { recursive: true, force: true })
})
