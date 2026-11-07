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

// ── 非 OpenAI 厂商的响应结构 ────────────────────────────

test('pickText: Anthropic 的 content[].text', () => {
  const body = JSON.stringify({ content: [{ type: 'text', text: 'Anthropic says ripe' }] })
  assert.equal(pickText(body), 'Anthropic says ripe')
})

test('pickText: Anthropic 多个 text 块拼接', () => {
  const body = JSON.stringify({ content: [{ type: 'text', text: 'ripe ' }, { type: 'text', text: 'grapes' }] })
  assert.equal(pickText(body), 'ripe grapes')
})

test('pickText: Anthropic 忽略非 text 块', () => {
  const body = JSON.stringify({ content: [{ type: 'tool_use', id: 'x' }, { type: 'text', text: 'only this' }] })
  assert.equal(pickText(body), 'only this')
})

test('pickText: Gemini 的 candidates[0].content.parts[].text', () => {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini says ripe' }] } }] })
  assert.equal(pickText(body), 'Gemini says ripe')
})

test('pickText: Ollama 的顶层 message.content', () => {
  const body = JSON.stringify({ message: { role: 'assistant', content: 'Ollama says ripe' } })
  assert.equal(pickText(body), 'Ollama says ripe')
})

test('pickText: OpenAI Responses 的 output_text', () => {
  const body = JSON.stringify({ output_text: 'Responses says ripe' })
  assert.equal(pickText(body), 'Responses says ripe')
})

test('pickText: Cohere 的顶层 text', () => {
  assert.equal(pickText(JSON.stringify({ text: 'Cohere says ripe' })), 'Cohere says ripe')
})

test('pickText: OpenAI 兼容优先于其他形状', () => {
  const body = JSON.stringify({
    choices: [{ message: { content: 'from choices' } }],
    text: 'from text',
  })
  assert.equal(pickText(body), 'from choices')
})

test('pickText: 空 content 数组仍返回 null', () => {
  assert.equal(pickText(JSON.stringify({ content: [] })), null)
})

test('pickText: 错误响应体仍返回 null', () => {
  assert.equal(pickText(JSON.stringify({ error: { message: 'rate limited' } })), null)
})
