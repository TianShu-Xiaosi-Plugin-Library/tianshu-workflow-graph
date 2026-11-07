// TWG 图内核：加载 / 校验 / 拓扑排序
// 图是唯一真相；任何视图（CLI、画布、agent）都只是它的读写器。

const NODE_TYPES = new Set(['compute', 'render', 'service', 'agent', 'human', 'verify', 'memory'])

/** 图校验：失败就大声失败，不做兜底。 */
export function validate(graph) {
  const errors = []
  if (!graph || typeof graph !== 'object') return ['图必须是对象']
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) errors.push('nodes 不能为空')
  if (graph.root != null && graph.root !== 'graph' && graph.root !== 'workspace') {
    errors.push(`root 只能是 "graph" 或 "workspace"，收到 ${JSON.stringify(graph.root)}`)
  }

  const ids = new Set()
  for (const n of graph.nodes ?? []) {
    if (!n.id) { errors.push('节点缺少 id'); continue }
    if (ids.has(n.id)) errors.push(`节点 id 重复: ${n.id}`)
    ids.add(n.id)
    if (!NODE_TYPES.has(n.type)) errors.push(`节点 ${n.id} 类型非法: ${n.type}`)
    if (!n.op) errors.push(`节点 ${n.id} 缺少 op`)
  }

  for (const n of graph.nodes ?? []) {
    for (const dep of n.inputs ?? []) {
      if (!ids.has(dep)) errors.push(`节点 ${n.id} 引用了不存在的输入: ${dep}`)
    }
  }

  // 环检测在 topoSort 里做，这里只报结构问题
  return errors
}

/** 拓扑排序：Kahn 算法。有环直接抛错。 */
export function topoSort(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]))
  const out = new Map(graph.nodes.map((n) => [n.id, []]))

  for (const n of graph.nodes) {
    for (const dep of n.inputs ?? []) {
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1)
      out.get(dep).push(n.id)
    }
  }

  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const next of out.get(id)) {
      const d = indeg.get(next) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }

  if (order.length !== graph.nodes.length) {
    const stuck = graph.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id)
    throw new Error(`图存在环，无法排序。涉及节点: ${stuck.join(', ')}`)
  }
  return order.map((id) => nodes.get(id))
}

/** 加载并做完整校验，返回规范化后的图。 */
export function load(graph) {
  const errors = validate(graph)
  if (errors.length) {
    throw new Error(`图校验失败:\n  - ${errors.join('\n  - ')}`)
  }
  topoSort(graph) // 提前触发环检测
  return graph
}
