import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearAlerts, checkQuotaThresholds, getRecentAlerts, notifySessionExpired, dispatchWebhookAlert } from '../lib/alerts.js'

test('quota alerts deduplicate within their window and keep expiration separate', () => {
  clearAlerts()
  try {
    const input = { provider: 'codex', ref: 'CODEX_OAUTH_1', usedPercent: 96, nowMs: 1_000_000 }
    assert.equal(checkQuotaThresholds({ ...input, usedPercent: 70 }), null)
    const first = checkQuotaThresholds(input)
    assert.equal(first.severity, 'error')
    assert.equal(first.details.threshold, 95)
    assert.equal(checkQuotaThresholds({ ...input, nowMs: input.nowMs + 1 }), null)
    assert.ok(checkQuotaThresholds({ ...input, nowMs: input.nowMs + 600_001 }))
    notifySessionExpired(input)
    assert.equal(getRecentAlerts().length, 3)
  } finally { clearAlerts() }
})

test('webhook delivery pins the admitted address and tolerates a failed receiver', async (context) => {
  const previousNoProxy = process.env.NO_PROXY
  context.after(() => {
    if (previousNoProxy === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = previousNoProxy
  })
  process.env.NO_PROXY = 'alerts.example.invalid'
  const alert = { type: 'token_expired', ref: 'FIXTURE' }
  const options = { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], retries: 0 }
  const ok = await dispatchWebhookAlert(alert, 'https://alerts.example.invalid/', async (url, init) => {
    assert.equal(url, 'https://alerts.example.invalid/')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'manual')
    assert.ok(init.dispatcher)
    assert.deepEqual(JSON.parse(init.body).alert, alert)
    return { ok: true }
  }, options)
  assert.equal(ok, true)
  assert.equal(await dispatchWebhookAlert(alert, 'https://alerts.example.invalid/', async () => { throw new Error('offline fixture') }, options), false)
})
