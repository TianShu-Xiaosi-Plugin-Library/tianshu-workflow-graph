#!/usr/bin/env node
// TWG CLI：跑一张图
//   node run.mjs examples/hello.twg.json
import { readFileSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from './lib/graph.mjs'
import { execute } from './lib/executor.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('用法: node run.mjs <graph.twg.json> [--workdir <dir>] [--ffmpeg <path>]')
    process.exit(2)
  }

  const graphPath = isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
  const raw = JSON.parse(readFileSync(graphPath, 'utf8'))

  const flag = (name) => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1] : undefined
  }

  const graph = load(raw)
  console.log(`图已加载: ${graph.id ?? '(未命名)'} | ${graph.nodes.length} 个节点`)

  const t0 = performance.now()
  const result = await execute(graph, {
    workDir: flag('--workdir') ?? resolve(HERE, '.twg-run', graph.id ?? 'run'),
    ffmpeg: flag('--ffmpeg'),
  })
  const total = +(performance.now() - t0).toFixed(1)

  console.log('\n执行顺序:', result.order.join(' → '))
  console.log('\n节点耗时:')
  for (const t of result.timings) {
    console.log(`  ${t.id.padEnd(12)} ${t.op.padEnd(18)} ${String(t.ms).padStart(8)} ms  [${t.determinism}]`)
  }
  console.log(`\n总计: ${total} ms`)
  console.log('\n产物:')
  for (const [name, file] of Object.entries(result.outputs)) {
    console.log(`  ${name}: ${file}`)
  }
  console.log(`\n工作目录: ${result.workDir}`)
}

main()
