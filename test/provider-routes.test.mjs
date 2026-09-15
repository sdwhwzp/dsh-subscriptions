import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NamespacedAdapter, subscriptionRoute } from '../lib/provider-routes.js'

test('namespaced routes preserve vendor calls and model metadata', async () => {
  const calls = []
  const delegate = {
    providerInfo: provider => ({ id: provider, name: 'Claude' }),
    providerRetryPolicy: provider => ({ provider }),
    listModels: async provider => [{ id: 'claude-sonnet-5', provider }],
    resolveModel: async (provider, id) => ({ provider, id }),
    prepareCall: async (provider, id) => ({
      model: { provider, id },
      stream: async function* (options) { calls.push(options); yield { type: 'text-delta', text: 'OK' } },
    }),
    stream: async function* (options) { calls.push(options); yield { type: 'text-delta', text: 'OK' } },
    imageRequestPricing: provider => provider,
  }
  const adapter = new NamespacedAdapter(delegate)
  const route = subscriptionRoute('claude')
  assert.equal(route, 'subscriptions-claude')
  assert.equal(adapter.providerInfo(route).id, route)
  assert.deepEqual(adapter.providerRetryPolicy(route), { provider: 'claude' })
  assert.equal((await adapter.listModels(route))[0].provider, route)
  assert.equal((await adapter.resolveModel(route, 'claude-sonnet-5')).provider, route)
  const prepared = await adapter.prepareCall(route, 'claude-sonnet-5')
  assert.equal(prepared.model.provider, route)
  const input = { provider: route, model: 'claude-sonnet-5', messages: [] }
  for await (const _ of prepared.stream(input)) { /* Consume mocked stream. */ }
  for await (const _ of adapter.stream(input)) { /* Consume mocked stream. */ }
  assert.deepEqual(calls.map(call => call.provider), ['claude', 'claude'])
  assert.equal(input.provider, route)
  assert.equal(adapter.imageRequestPricing(route, input.model), 'claude')
  assert.throws(() => adapter.providerInfo('claude'), /Unknown subscription route/)
})
