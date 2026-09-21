import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { exportVault, importVault, VAULT_FORMAT } from '../lib/vault.js'
import { encryptWithPassphrase } from '../lib/crypto.js'
import { registerAccountsRoutes } from '../lib/routes/accounts.js'

const passphrase = 'fixture-passphrase'
const slots = [{ provider: 'codex', index: 1, label: 'Fixture' }]
const blobs = { CODEX_OAUTH_1: { accessToken: 'fixture-token' } }
const encrypted = (data) => encryptWithPassphrase(JSON.stringify({ format: VAULT_FORMAT, slots, blobs, ...data }), passphrase)

test('vault round-trips slots and credentials without exposing plaintext', () => {
  const result = exportVault({ slots, blobs }, passphrase)
  assert.equal(result.slotCount, 1)
  assert.equal(result.blobCount, 1)
  assert.equal(result.vault.includes('fixture-token'), false)
  const restored = importVault(result.vault, passphrase)
  assert.deepEqual(restored.slots, slots)
  assert.deepEqual(restored.blobs, blobs)
  assert.throws(() => importVault(result.vault, 'wrong-passphrase'), /decrypt/)
})

test('vault validation rejects credentials outside its declared slots', () => {
  for (const data of [
    { blobs: null }, { blobs: [] }, { slots: [null] },
    { slots: [{ provider: 'unknown', index: 1 }] },
    { slots: [{ provider: 'codex', index: 0 }] },
    { slots: [slots[0], slots[0]] },
    { blobs: { OTHER_SECRET: { accessToken: 'fixture-token' } } },
    { blobs: { CODEX_OAUTH_1: null } },
    { blobs: { CODEX_OAUTH_1: [] } },
  ]) assert.throws(() => importVault(encrypted(data), passphrase), /vault/)
})

function routes({ saveFails = false, settingsAvailable = true } = {}) {
  const registered = []
  const writes = []
  let config = { slots: [{ provider: 'claude', index: 2 }] }
  registerAccountsRoutes({
    effect(fn) { fn() },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }, {
    live: () => config,
    getSettingsApi: () => settingsAvailable ? { replace: async (value) => { config = value } } : null,
    stripLegacySlots: (value) => value,
    store: { saveBlob: async (ref, blob) => { if (saveFails) throw new Error('fixture write failed'); writes.push([ref, blob]) } },
    syncCustomVendors() {}, syncAdapter: async () => {}, refreshModels: async () => {}, accountsView: async () => [],
  })
  const handler = registered.find(row => row.path.endsWith('/vault/import')).handler
  return {
    writes, config: () => config,
    async send(vault, headers = { 'sec-fetch-site': 'same-origin' }) {
      const req = Readable.from([Buffer.from(JSON.stringify({ vault, passphrase }))])
      req.method = 'POST'; req.headers = headers
      const result = {}
      try {
        await handler(req, { writeHead(code) { result.code = code }, end(body) { result.body = JSON.parse(body) } })
        return result
      } finally { req.destroy() }
    },
  }
}

test('vault import rejects cross-site or invalid data before credential writes', async () => {
  const api = routes()
  assert.equal((await api.send(encrypted({}), { 'sec-fetch-site': 'cross-site' })).code, 403)
  assert.equal((await api.send(encrypted({ blobs: { FOREIGN_SECRET: {} } }))).code, 400)
  assert.deepEqual(api.writes, [])
})

test('vault import merges declared slots and reports storage failures', async () => {
  const api = routes()
  const result = await api.send(encrypted({}))
  assert.equal(result.code, 200)
  assert.equal(result.body.blobCount, 1)
  assert.deepEqual(api.writes, [['CODEX_OAUTH_1', blobs.CODEX_OAUTH_1]])
  assert.deepEqual(api.config().slots.map(slot => slot.provider), ['claude', 'codex'])
  assert.equal((await routes({ saveFails: true }).send(encrypted({}))).code, 400)
  const unavailable = routes({ settingsAvailable: false })
  assert.equal((await unavailable.send(encrypted({}))).code, 400)
  assert.deepEqual(unavailable.writes, [])
})
