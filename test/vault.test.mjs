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

function routes({ saveFails = false, settingsAvailable = true, replaceFails = false, existing = {}, unreadableRef } = {}) {
  const registered = []
  const writes = []
  const cleared = []
  const saved = new Map(Object.entries(existing))
  let config = { slots: [{ provider: 'claude', index: 2 }] }
  const settings = {
    revision: () => 9,
    async replace(value, revision) {
      assert.equal(revision, 9)
      if (replaceFails) throw new Error('fixture settings write failed')
      config = value
    },
  }
  registerAccountsRoutes({
    effect(fn) { fn() },
    webServer: { register(route) { registered.push(route); return () => {} } },
  }, {
    live: () => config,
    getSettingsApi: () => settingsAvailable ? settings : null,
    stripLegacySlots: (value) => value,
    store: {
      async loadBlob(ref) {
        if (ref === unreadableRef) throw Object.assign(new Error('fixture credential could not be decrypted'), { code: 'DECRYPT_FAILED' })
        if (!saved.has(ref)) throw Object.assign(new Error('fixture credential absent'), { code: 'AUTH' })
        return saved.get(ref)
      },
      async saveBlob(ref, blob) {
        if (saveFails) throw new Error('fixture credential write failed')
        writes.push([ref, blob])
        saved.set(ref, blob)
      },
      async clearRef(ref) {
        cleared.push(ref)
        saved.delete(ref)
      },
    },
    syncCustomVendors() {}, syncAdapter: async () => {}, refreshModels: async () => {}, accountsView: async () => [],
  })
  const handler = registered.find(row => row.path.endsWith('/vault/import')).handler
  return {
    writes, cleared, saved, config: () => config,
    async send(vault, headers = { host: 'localhost:3081', origin: 'http://localhost:3081', 'sec-fetch-site': 'same-origin' }) {
      const req = Readable.from([Buffer.from(JSON.stringify({ vault, passphrase }))])
      req.method = 'POST'; req.headers = headers
      req.socket = { remoteAddress: '127.0.0.1' }
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
  assert.deepEqual(api.writes, [['CODEX_OAUTH_1', { ...blobs.CODEX_OAUTH_1, refreshToken: '', expiresAt: 0, label: '', email: '', accountId: '', projectId: '', selectedOrgId: '', selectedOrgName: '' }]])
  assert.deepEqual(api.config().slots.map(slot => slot.provider), ['claude', 'codex'])
  assert.equal((await routes({ saveFails: true }).send(encrypted({}))).code, 400)
  const unavailable = routes({ settingsAvailable: false })
  assert.equal((await unavailable.send(encrypted({}))).code, 400)
  assert.deepEqual(unavailable.writes, [])
})

function twoSlotVault() {
  return encrypted({
    slots: [...slots, { provider: 'codex', index: 2 }],
    blobs: { ...blobs, CODEX_OAUTH_2: { accessToken: 'new-slot-fixture' } },
  })
}

test('a settings write failure restores overwritten credentials and removes newly imported blobs', async () => {
  const original = { accessToken: 'original-slot-fixture' }
  const api = routes({ replaceFails: true, existing: { CODEX_OAUTH_1: original } })
  const config = api.config()
  const result = await api.send(twoSlotVault())
  assert.equal(result.code, 400)
  assert.equal(result.body.error.message, 'fixture settings write failed')
  assert.equal(api.config(), config)
  assert.deepEqual(api.writes.map(([ref]) => ref), ['CODEX_OAUTH_1', 'CODEX_OAUTH_2', 'CODEX_OAUTH_1'])
  assert.deepEqual(api.cleared, ['CODEX_OAUTH_2'])
  assert.deepEqual([...api.saved], [['CODEX_OAUTH_1', original]])
})

test('vault import refuses to write if any existing credential cannot be read', async () => {
  const api = routes({ existing: { CODEX_OAUTH_1: { accessToken: 'original-slot-fixture' } }, unreadableRef: 'CODEX_OAUTH_2' })
  const config = api.config()
  const result = await api.send(twoSlotVault())
  assert.equal(result.code, 400)
  assert.equal(result.body.error.message, 'fixture credential could not be decrypted')
  assert.equal(api.config(), config)
  assert.deepEqual(api.writes, [])
  assert.deepEqual(api.cleared, [])
})
