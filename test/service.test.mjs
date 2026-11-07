import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OPS } from '../lib/nodes.mjs'

/** 起一个真实的本地 HTTP 服务，返回 { url, close } */
function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

const work = () => {
  const d = join(tmpdir(), `twg-svc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(d, { recursive: true })
  return d
}

test('service.http: GET 成功时把响应体落盘', async () => {
  const srv = await serve((req, res) => { res.writeHead(200); res.end('hello-tw') })
  const d = work()
  const out = await OPS['service.http'].run({
    node: { id: 's', params: { url: `${srv.url}/x` } }, inputs: [], workDir: d,
  })
  assert.equal(out.status, 200)
  assert.equal(readFileSync(out.file, 'utf8'), 'hello-tw')
  await srv.close(); rmSync(d, { recursive: true, force: true })
})

test('service.http: 非 2xx 抛错并带状态码', async () => {
  const srv = await serve((req, res) => { res.writeHead(503); res.end('down') })
  const d = work()
  await assert.rejects(
    OPS['service.http'].run({ node: { id: 's', params: { url: `${srv.url}/` } }, inputs: [], workDir: d }),
    /HTTP 503/,
  )
  await srv.close(); rmSync(d, { recursive: true, force: true })
})

test('service.http: 拒绝非 http/https 协议', async () => {
  const d = work()
  await assert.rejects(
    OPS['service.http'].run({ node: { id: 's', params: { url: 'file:///etc/passwd' } }, inputs: [], workDir: d }),
    /只允许 http\/https/,
  )
  rmSync(d, { recursive: true, force: true })
})

test('service.http: 非法 URL 抛错', async () => {
  const d = work()
  await assert.rejects(
    OPS['service.http'].run({ node: { id: 's', params: { url: 'not a url' } }, inputs: [], workDir: d }),
    /url 非法/,
  )
  rmSync(d, { recursive: true, force: true })
})

test('service.http: 超时中断', async () => {
  const srv = await serve((req, res) => { setTimeout(() => { res.writeHead(200); res.end('late') }, 2000) })
  const d = work()
  await assert.rejects(
    OPS['service.http'].run({
      node: { id: 's', params: { url: `${srv.url}/`, timeoutMs: 100 } }, inputs: [], workDir: d,
    }),
    /请求超时 100ms/,
  )
  await srv.close(); rmSync(d, { recursive: true, force: true })
})

test('service.http: 上游产物作为 POST body', async () => {
  let received = null
  const srv = await serve((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { received = Buffer.concat(chunks).toString('utf8'); res.writeHead(200); res.end('ok') })
  })
  const d = work()
  const f = join(d, 'in.txt')
  writeFileSync(f, 'payload-from-upstream')
  await OPS['service.http'].run({
    node: { id: 's', params: { url: `${srv.url}/`, method: 'POST' } },
    inputs: [{ file: f }],
    workDir: d,
  })
  assert.equal(received, 'payload-from-upstream')
  await srv.close(); rmSync(d, { recursive: true, force: true })
})

test('service.http: 缺 url 抛错', async () => {
  await assert.rejects(
    OPS['service.http'].run({ node: { id: 's', params: {} }, inputs: [], workDir: work() }),
    /需要 params\.url/,
  )
})

test('service.http: determinism 标为 stochastic', () => {
  assert.equal(OPS['service.http'].determinism, 'stochastic')
  assert.equal(OPS['service.http'].kind, 'service')
})

// ── 环境变量占位符：密钥不写进图、不进账本 ──────────────────

test('service.http: url 里的 ${env:NAME} 被替换成环境变量值', async (t) => {
  const srv = await serve((req, res) => { res.writeHead(200); res.end(`path=${req.url}`) })
  const d = work()
  t.after(async () => { await srv.close(); rmSync(d, { recursive: true, force: true }); delete process.env.TWG_TEST_HOST })
  process.env.TWG_TEST_HOST = srv.url
  const out = await OPS['service.http'].run({
    node: { id: 's', params: { url: '${env:TWG_TEST_HOST}/search?q=grape' } },
    inputs: [], workDir: d,
  })
  assert.equal(out.status, 200)
  assert.equal(readFileSync(out.file, 'utf8'), 'path=/search?q=grape')
})

test('service.http: headers 里的 ${env:NAME} 被替换成环境变量值', async (t) => {
  let seen = null
  const srv = await serve((req, res) => { seen = req.headers['x-api-key']; res.writeHead(200); res.end('ok') })
  const d = work()
  t.after(async () => { await srv.close(); rmSync(d, { recursive: true, force: true }); delete process.env.TWG_TEST_KEY })
  process.env.TWG_TEST_KEY = 'sk-from-env-123'
  await OPS['service.http'].run({
    node: { id: 's', params: { url: `${srv.url}/`, headers: { 'X-Api-Key': '${env:TWG_TEST_KEY}' } } },
    inputs: [], workDir: d,
  })
  assert.equal(seen, 'sk-from-env-123')
})

test('service.http: 环境变量缺失时明确报错并点名变量', async (t) => {
  delete process.env.TWG_TEST_MISSING
  const d = work()
  t.after(() => rmSync(d, { recursive: true, force: true }))
  await assert.rejects(
    OPS['service.http'].run({
      node: { id: 's', params: { url: 'http://127.0.0.1:1/${env:TWG_TEST_MISSING}' } },
      inputs: [], workDir: d,
    }),
    /TWG_TEST_MISSING/,
  )
})

test('service.http: 解析占位符不改动 node.params（账本只留占位符）', async (t) => {
  const srv = await serve((req, res) => { res.writeHead(200); res.end('ok') })
  const d = work()
  t.after(async () => { await srv.close(); rmSync(d, { recursive: true, force: true }); delete process.env.TWG_TEST_HOST2 })
  process.env.TWG_TEST_HOST2 = srv.url
  const params = Object.freeze({
    url: '${env:TWG_TEST_HOST2}/x',
    headers: Object.freeze({ 'X-Api-Key': '${env:TWG_TEST_HOST2}' }),
  })
  await OPS['service.http'].run({ node: { id: 's', params }, inputs: [], workDir: d })
  assert.equal(params.url, '${env:TWG_TEST_HOST2}/x')
  assert.equal(params.headers['X-Api-Key'], '${env:TWG_TEST_HOST2}')
})
