// 服务注入：把"不属于本模块"的能力挡在外面
// executor 只认接口，不认来源——插件传宿主的 sidePathLLM，测试传桩，CLI 传 whatever。
// 这样内核不绑定宿主。

/**
 * 校验图所需的服务是否齐备，返回可用的 services。
 * 只检查图上真正用到的服务——没用到的能力缺失不该拦住整张图。
 * 缺失即抛错：静默降级会让确定性等级说谎（agent 节点没调模型却仍标 stochastic）。
 */
export function requireServices(graph, services = {}) {
  const used = new Set(graph.nodes.map((n) => n.op))
  const missing = []
  if (used.has('agent.llm') && typeof services.complete !== 'function') {
    missing.push('complete（agent.llm 节点需要）')
  }
  if (used.has('human.approve') && typeof services.approve !== 'function') {
    missing.push('approve（human.approve 节点需要）')
  }
  if (missing.length) {
    throw new Error(`图需要以下服务但未注入: ${missing.join(', ')}`)
  }
  return services
}
