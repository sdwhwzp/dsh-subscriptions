import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SubscriptionAdapter } from '../lib/adapter.js'
import { resolveFallbackVendor } from '../lib/cascade.js'

const options = { provider: 'claude', model: 'fixture-model', messages: [] }

test('fallback selection excludes previously attempted providers', () => {
  assert.equal(resolveFallbackVendor('claude', ['claude', 'cursor']), 'cursor')
  assert.equal(resolveFallbackVendor('cursor', ['claude', 'cursor'], {}, new Set(['claude', 'cursor'])), null)
})

test('partial cascading output cannot restart on Ollama', async () => {
  let ollamaCalls = 0
  const adapter = new SubscriptionAdapter({
    listAccounts: async () => [], cooldownMs: () => 1000,
    cascadingFallback: async function* ({ visited }) {
      assert.ok(visited.has('claude'))
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw new Error('fallback interrupted')
    },
    ollamaFallback: async function* () { ollamaCalls++; yield { type: 'text-delta', index: 0, text: 'restarted' } },
  })
  const stream = adapter.stream(options)
  assert.equal((await stream.next()).value.text, 'partial')
  await assert.rejects(stream.next(), /fallback interrupted/)
  assert.equal(ollamaCalls, 0)
})

test('invalid requests and cancellation never trigger a cross-vendor request', async () => {
  for (const failure of [new Error('invalid request'), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
    let calls = 0
    const adapter = new SubscriptionAdapter({
      listAccounts: async () => { throw failure }, cooldownMs: () => 1000,
      cascadingFallback: async function* () { calls++ },
    })
    await assert.rejects(adapter.stream(options).next())
    assert.equal(calls, 0)
  }
})
