import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OPS } from '../lib/nodes.mjs'

const work = () => {
  const d = join(tmpdir(), `twg-in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(d, { recursive: true })
  return d
}

const run = (params, cwd, workDir) => OPS['ffmpeg.input'].run({
  node: { id: 'src', params }, inputs: [], workDir, cwd, ffmpeg: 'ffmpeg',
})

test('ffmpeg.input: 缺 path 直接报错', () => {
  const d = work()
  assert.throws(() => run({}, d, d), /需要 params\.path/)
  rmSync(d, { recursive: true, force: true })
})

test('ffmpeg.input: 工作区外的绝对路径被拒', () => {
  const d = work()
  // 用系统目录里的真实文件，确保不是"文件不存在"导致的失败
  const outside = process.platform === 'win32' ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/hosts'
  assert.throws(() => run({ path: outside }, d, d), /素材在工作区外，拒绝读取/)
  rmSync(d, { recursive: true, force: true })
})

test('ffmpeg.input: ../ 相对逃逸被拒', () => {
  const d = work()
  assert.throws(() => run({ path: '../outside.mp4' }, d, d), /素材在工作区外，拒绝读取/)
  rmSync(d, { recursive: true, force: true })
})

test('ffmpeg.input: 工作区内但文件不存在时报"不存在"', () => {
  const d = work()
  assert.throws(
    () => run({ path: 'nope.mp4' }, d, d),
    /素材不存在: nope\.mp4/,
  )
  rmSync(d, { recursive: true, force: true })
})

test('ffmpeg.input: 存在的工作区内文件能通过守卫（不因路径被拒）', () => {
  const d = work()
  writeFileSync(join(d, 'fake.mp4'), '')   // 空文件，ffmpeg 会失败，但守卫应放行
  let err
  try {
    run({ path: 'fake.mp4' }, d, d)
  } catch (e) {
    err = e
  }
  assert.ok(err, '空文件应让 ffmpeg 失败')
  assert.doesNotMatch(String(err.message), /工作区外|素材不存在/, '守卫不应误拦工作区内存在的文件')
  rmSync(d, { recursive: true, force: true })
})

test('ffmpeg.input: determinism 标为 deterministic，类型为 compute', () => {
  assert.equal(OPS['ffmpeg.input'].determinism, 'deterministic')
  assert.equal(OPS['ffmpeg.input'].kind, 'compute')
  assert.equal(OPS['ffmpeg.input'].inputs, 0)
})

test('ffmpeg.input: 工作区内的符号链接指向外部时被拒', (t) => {
  const d = work()
  const outsideDir = work()
  const outside = join(outsideDir, 'secret.mp4')
  writeFileSync(outside, '')
  const link = join(d, 'link.mp4')
  try {
    symlinkSync(outside, link, 'file')
  } catch (e) {
    rmSync(d, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    t.skip(`无法创建符号链接（${e.code}）——Windows 需开发者模式或管理员`)
    return
  }
  assert.throws(
    () => run({ path: 'link.mp4' }, d, d),
    /经符号链接指向工作区外/,
  )
  rmSync(d, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

test('ffmpeg.input: 工作区内的普通文件不被符号链接检查误拦', () => {
  const d = work()
  writeFileSync(join(d, 'ok.mp4'), '')
  let err
  try {
    run({ path: 'ok.mp4' }, d, d)
  } catch (e) {
    err = e
  }
  assert.ok(err, '空文件应让 ffmpeg 失败')
  assert.doesNotMatch(String(err.message),
    /工作区外|素材不存在|符号链接|无法解析/,
    '守卫不应误拦工作区内的普通文件')
  rmSync(d, { recursive: true, force: true })
})
