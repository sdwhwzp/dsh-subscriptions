import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeExpiresAt, parseBlob, serializeBlob } from '../lib/blob.js'
import { extractGoogleClientIdFromJwt } from '../lib/jwt.js'
import { refresh } from '../lib/vendors/antigravity.js'
import { createAccountStore } from '../lib/accounts.js'

const clientId = '123-fixture.apps.googleusercontent.com'
const jwt = payload => 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature'

test('CLI expiry formats and OAuth client metadata survive persisted credential round trips', () => {
  const expected = Date.parse('2026-10-02T12:34:56.123Z')
  for (const value of [expected, expected / 1000, String(expected), String(expected / 1000), '2026-10-02T12:34:56.123456789Z', '2026-10-02T14:34:56.123+02:00']) {
    assert.equal(normalizeExpiresAt(value), expected)
    const blob = { accessToken: 'fixture-access', expiresAt: value, clientId, clientSecret: 'fixture-secret', idToken: jwt({ aud: clientId }) }
    assert.deepEqual(parseBlob(serializeBlob(blob)), { ...blob, expiresAt: expected, refreshToken: '', label: '', email: '', accountId: '', projectId: '' })
  }
  for (const value of [NaN, Infinity, -1, '', 'bad-date']) assert.equal(normalizeExpiresAt(value), 0)
})

test('Google client metadata accepts one matching audience and refuses ambiguity', () => {
  assert.equal(extractGoogleClientIdFromJwt(jwt({ aud: clientId })), clientId)
  assert.equal(extractGoogleClientIdFromJwt(jwt({ aud: ['other', clientId], azp: clientId })), clientId)
  for (const payload of [{ aud: ['other', clientId] }, { aud: clientId, azp: '456-other.apps.googleusercontent.com' }, { aud: 'invalid' }]) {
    assert.equal(extractGoogleClientIdFromJwt(jwt(payload)), '')
  }
})

test('Antigravity refresh requires a client id and retains the configured client identity', async () => {
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls++
    const params = new URLSearchParams(init.body)
    assert.equal(params.get('client_id'), clientId)
    assert.equal(params.get('client_secret'), 'fixture-secret')
    return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), { status: 200 })
  }
  await assert.rejects(refresh({}, { refreshToken: 'fixture-refresh' }, fetchImpl), /Client ID/)
  assert.equal(calls, 0)
  const blob = await refresh({ clientId, clientSecret: 'fixture-secret' }, { clientId: 'old-client', refreshToken: 'fixture-refresh' }, fetchImpl)
  assert.equal(blob.clientId, clientId)
  assert.equal(blob.clientSecret, 'fixture-secret')
  assert.equal(blob.accessToken, 'fresh-token')
})

function fixtureStore(t, credentials) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-subscriptions-0653-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  const store = createAccountStore({ credentials, getConfig: () => ({ slots: [{ provider: 'codex', index: 953 }] }), fetchImpl: async () => { throw new Error('unexpected network request') } })
  return { store, home }
}

test('logout cannot resurrect a credential while a preceding write is pending', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  const saved = new Map()
  const credentials = {
    async set(ref, value) { started.resolve(); await release.promise; saved.set(ref, value) },
    async unset(ref) { saved.delete(ref) },
  }
  const { store } = fixtureStore(t, credentials)
  const pending = store.saveBlob('CODEX_OAUTH_953', { accessToken: 'fixture-token' })
  await started.promise
  await store.clearRef('CODEX_OAUTH_953')
  release.resolve()
  await pending
  assert.equal(saved.size, 0)
})

test('quarantine warmup preserves its persisted deadline while probing and backs off on failure', async t => {
  const { store, home } = fixtureStore(t, { async describe() { return { configured: true } } })
  const ref = 'CODEX_OAUTH_953'
  const expired = Date.now() - 1000
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  store.rememberQuarantine(ref, 'RATE_LIMIT', expired)
  const probing = store.probeWarmup(ref, async () => { started.resolve(); await release.promise; throw new Error('RATE_LIMIT') })
  await started.promise
  try {
    const persisted = JSON.parse(readFileSync(join(home, 'subscriptions/quarantines.json'), 'utf8'))
    assert.equal(persisted[ref].until, expired)
    assert.equal(persisted[ref].status, 'probing')
  } finally { release.resolve() }
  const result = await probing
  assert.equal(result.success, false)
  assert.ok(store.getQuarantine(ref).until > Date.now())
  assert.equal(store.getQuarantine(ref).attempts, 2)
  store.releaseQuarantine(ref)
})

test('quota pacing resets with a new quota window instead of mixing unrelated samples', async t => {
  const { store } = fixtureStore(t, { async describe() { return { configured: true } } })
  const ref = 'CODEX_OAUTH_953', now = Date.now(), hour = 3600000
  store.rememberQuota(ref, { usedPercent: 10, measuredAt: now - hour, resetAt: now + hour })
  store.rememberQuota(ref, { usedPercent: 30, measuredAt: now, resetAt: now + hour })
  assert.equal(store.getQuota(ref).pacePerHour, 20)
  store.rememberQuota(ref, { usedPercent: 5, measuredAt: now + 1, resetAt: now + 2 * hour })
  assert.equal(store.getQuota(ref).pacePerHour, 0)
  assert.equal(store.getQuota(ref).samples.length, 1)
})
