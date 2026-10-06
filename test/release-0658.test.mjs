import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAccount } from '../lib/rotate.js'
import { createSubscriptionsService } from '../lib/subscriptions.js'
import { getVendor } from '../lib/vendors/index.js'

test('quota draining prefers an expiring balance without using a cooling account', () => {
  const now = 1000000
  const accounts = [
    { ref: 'LATER', hasToken: true, quota: { remaining: 90, limit: 100, resetAt: now + 7200000 } },
    { ref: 'SOON', hasToken: true, pacingRisk: 50, quota: { remaining: 40, limit: 100, resetAt: now + 600000 } },
    { ref: 'COOLING', hasToken: true, cooldownUntil: now + 60000, quota: { remaining: 90, limit: 100, resetAt: now + 300000 } },
  ]
  assert.equal(pickAccount(accounts, now, { drainBeforeReset: false }).ref, 'LATER')
  assert.equal(pickAccount(accounts, now, { drainBeforeReset: true }).ref, 'SOON')
})

test('subscription requests retain the provider base path and reject escaping URLs before dispatch', async () => {
  const dispatched = []
  const service = createSubscriptionsService({
    listAccounts: async () => [{ hasToken: true, ref: 'CODEX_OAUTH_1' }],
    loadBlob: async () => ({ accessToken: 'fixture-token' }),
    ensureFresh: async (_provider, blob) => blob,
    vendorConfig: () => ({ baseUrl: 'https://chatgpt.com/backend-api/codex' }),
    switchAtRemaining: () => 0,
    cooldownMs: () => 1000,
    rememberCooldown() {},
    rememberQuota() {},
    fetchImpl: async (url) => { dispatched.push(url); return Response.json({ data: [] }) },
  })
  for (const path of ['/responses', '/backend-api/codex/responses']) {
    const response = await service.request({ provider: 'codex', path })
    await response.json()
  }
  assert.deepEqual(dispatched, Array(2).fill('https://chatgpt.com/backend-api/codex/responses'))
  for (const path of ['//elsewhere.invalid/responses', 'https://elsewhere.invalid/responses', '/responses/../secrets']) {
    await assert.rejects(service.request({ provider: 'codex', path }), { code: 'FORBIDDEN' })
  }
  assert.equal(dispatched.length, 2)
})

test('Claude model discovery sends OAuth tokens as bearer credentials and API keys separately', async () => {
  for (const [accessToken, header] of [['sk-ant-oat-fixture', 'Authorization'], ['sk-ant-ort-fixture', 'Authorization'], ['sk-ant-api-fixture', 'x-api-key']]) {
    let captured
    await getVendor('claude').listModels({ accessToken }, {}, async (_url, init) => {
      captured = init.headers
      return Response.json({ data: [] })
    })
    assert.equal(captured[header], header === 'Authorization' ? `Bearer ${accessToken}` : accessToken)
    assert.equal(captured[header === 'Authorization' ? 'x-api-key' : 'Authorization'], undefined)
  }
})
