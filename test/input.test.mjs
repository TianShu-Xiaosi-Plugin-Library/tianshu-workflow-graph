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

test('ffmpeg.input: start/duration 裁剪生效（需 ffmpeg）', async (t) => {
  const { resolveFfmpeg } = await import('../lib/executor.mjs')
  const { spawnSync } = await import('node:child_process')
  let ff
  try {
    ff = resolveFfmpeg()
  } catch {
    t.skip('本机无 ffmpeg')
    return
  }
  const d = work()
  const src = join(d, 'src5s.mp4')
  const gen = spawnSync(ff, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=teal:duration=5:size=160x120:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', src],
  { encoding: 'utf8', timeout: 60000, windowsHide: true })
  if (gen.status !== 0) {
    rmSync(d, { recursive: true, force: true })
    t.skip(`生成素材失败: ${(gen.stderr || '').slice(0, 80)}`)
    return
  }

  const out = OPS['ffmpeg.input'].run({
    node: { id: 'cut', params: { path: 'src5s.mp4', start: 1, duration: 2 } },
    inputs: [], workDir: d, cwd: d, ffmpeg: ff,
  })

  // 用 ffprobe 读数（与 ffmpeg 同目录）
  const { resolveFfprobe } = await import('../lib/executor.mjs')
  const probe = spawnSync(resolveFfprobe(undefined, ff),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out.file],
    { encoding: 'utf8', timeout: 30000, windowsHide: true })
  const dur = Number.parseFloat((probe.stdout || '').trim())
  assert.ok(Math.abs(dur - 2) < 0.2, `裁剪后时长应约 2 秒，实际 ${dur}`)
  rmSync(d, { recursive: true, force: true })
})
