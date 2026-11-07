// 确定性传播：图级确定性 = 产物路径上最弱节点的确定性
// 这是 TWG 相对 ComfyUI 的核心增量——把"能不能重跑出一样结果"变成可检查的图属性。

/** 等级越高越不确定 */
export const RANK = { deterministic: 0, seeded: 1, stochastic: 2 }
const NAME = ['deterministic', 'seeded', 'stochastic']

/** 取两者中更弱的（更不确定的） */
export function weakest(a, b) {
  const ra = RANK[a] ?? 2
  const rb = RANK[b] ?? 2
  return NAME[Math.max(ra, rb)]
}

/**
 * 计算某个输出节点的路径确定性：递归取所有上游（含自身）的最弱等级。
 * @param {object} graph 已校验的图
 * @param {string} nodeId 目标输出节点
 * @param {Map<string,string>} opDeterminism nodeId -> determinism（来自 op 定义）
 */
export function pathDeterminism(graph, nodeId, opDeterminism) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const seen = new Set()
  let result = 'deterministic'

  const walk = (id) => {
    if (seen.has(id)) return
    seen.add(id)
    const node = nodes.get(id)
    if (!node) return
    result = weakest(result, opDeterminism.get(id) ?? 'stochastic')
    for (const dep of node.inputs ?? []) walk(dep)
  }

  walk(nodeId)
  return result
}

/**
 * 整图确定性 = 所有输出路径中最弱的一个。
 * @returns {{ overall: string, perOutput: Record<string,string> }}
 */
export function graphDeterminism(graph, opDeterminism) {
  const perOutput = {}
  let overall = 'deterministic'
  for (const [name, nodeId] of Object.entries(graph.outputs ?? {})) {
    const d = pathDeterminism(graph, nodeId, opDeterminism)
    perOutput[name] = d
    overall = weakest(overall, d)
  }
  return { overall, perOutput }
}
