import { LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Separate this plugin's picker routes from other subscription adapters. */
export function subscriptionRoute(provider) {
  return `subscriptions-${provider}`
}

function vendorRoute(route) {
  if (!route.startsWith('subscriptions-')) throw new Error(`Unknown subscription route: ${route}`)
  return route.slice('subscriptions-'.length)
}

/** Keep durable model routes distinct while preserving vendor request fields. */
export class NamespacedAdapter extends LlmAdapter {
  constructor(adapter) {
    super()
    this.adapter = adapter
  }
  providerInfo(route) {
    const info = this.adapter.providerInfo(vendorRoute(route))
    return { ...info, id: route, name: `${info.name} (Subscriptions+)` }
  }
  providerRetryPolicy(route) {
    return this.adapter.providerRetryPolicy(vendorRoute(route))
  }
  async listModels(route) {
    return (await this.adapter.listModels(vendorRoute(route))).map(model => ({ ...model, provider: route }))
  }
  async resolveModel(route, model, signal) {
    return { ...await this.adapter.resolveModel(vendorRoute(route), model, signal), provider: route }
  }
  async prepareCall(route, model, signal) {
    const prepared = await this.adapter.prepareCall(vendorRoute(route), model, signal)
    return {
      ...prepared,
      model: { ...prepared.model, provider: route },
      stream: options => prepared.stream({ ...options, provider: vendorRoute(route) }),
    }
  }
  stream(options) {
    return this.adapter.stream({ ...options, provider: vendorRoute(options.provider) })
  }
  imageRequestPricing(route, model) {
    return this.adapter.imageRequestPricing(vendorRoute(route), model)
  }
}
