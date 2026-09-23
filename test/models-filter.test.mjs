import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SubscriptionAdapter } from '../lib/adapter.js'

function makeAdapter(hide) {
  return new SubscriptionAdapter({
    listAccounts: async () => [{ hasToken: true, ref: 'CLAUDE_OAUTH_1' }],
    loadBlob: async () => ({}),
    ensureFresh: async (p, b) => b,
    vendorConfig: () => ({ models: [
      { id: 'claude-ok' },
      { id: 'claude-test' },
      { id: 'claude-preview-9' },
      { id: 'claude-beta' },
      { id: 'claude-sonnet:legacy' },
    ] }),
    hideDeprecatedModels: () => hide,
  })
}

test('#94: hideDeprecatedModels filters test/preview/beta/legacy ids', async () => {
  const models = await makeAdapter(true).listModels('claude')
  assert.deepEqual(models.map((m) => m.id), ['claude-ok'])
})

test('#94: filter off keeps the full catalog', async () => {
  const models = await makeAdapter(false).listModels('claude')
  assert.equal(models.length, 5)
})

test('model discovery uses the selected account fetch and keeps Codex defaults for an empty saved list', async () => {
  const selected = []
  const requests = []
  const adapter = new SubscriptionAdapter({
    listAccounts: async () => [{ hasToken: false, ref: 'empty' }, { hasToken: true, ref: 'selected' }],
    loadBlob: async ref => { assert.equal(ref, 'selected'); return { accessToken: 'fixture-token' } },
    ensureFresh: async (_provider, blob, ref) => { assert.equal(ref, 'selected'); return blob },
    vendorConfig: () => ({ models: [] }),
    fetchForRef: ref => {
      selected.push(ref)
      return async url => { requests.push(String(url)); throw new Error('Fixture endpoint unavailable') }
    },
    fetchImpl: async () => { assert.fail('Global fetch must not bypass the selected account proxy') },
  })
  const models = await adapter.listModels('codex')
  assert.deepEqual(selected, ['selected'])
  assert.equal(requests.length, 1)
  assert.ok(models.some(model => model.id === 'gpt-5.6-luna'))
})
