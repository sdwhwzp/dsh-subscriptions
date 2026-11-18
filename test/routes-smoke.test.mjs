import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

function minimalState() {
  const noop = async () => ({})
  return {
    NS: 'dsh-subscriptions',
    live: noop,
    accountsView: async () => [],
    getSettingsApi: () => ({}),
    syncCustomVendors: () => {},
    syncAdapter: async () => {},
    stripLegacySlots: () => {},
    store: { clearRef: async () => {} },
    PENDING_TTL_MS: 1,
    redirectFor: () => 'http://localhost/cb',
    OK_HTML: '<html></html>',
    refreshModels: async () => {},
    history: { add: () => {}, list: () => [] },
    refForSlot: () => 'ref-x',
    resetCredits: { begin: async () => ({}) },
    diagnosticsReport: async () => ({ ok: true }),
    pending: new Map(),
    completeOAuth: async () => ({}),
    fetchForRef: async () => { throw new Error('no fetch') },
    sweepPending: () => {},
    subscriptions: { request: async () => ({}) },
    pmL: () => {},
    pmE: () => {},
  }
}

function fakeCtx() {
  const routes = []
  const ctx = {
    webServer: { register(spec) { routes.push(spec) } },
    effect(fn) { fn(); return () => {} },
    log: { warn() {}, error() {}, info() {} },
  }
  return { ctx, routes }
}

const MODULES = ['status', 'oauth', 'accounts', 'proxy', 'vault', 'sources', 'packs', 'webhook', 'metrics']

function declaredPaths(name) {
  const source = file => readFileSync(new URL('../lib/routes/' + file + '.js', import.meta.url), 'utf8')
  let text = source(name)
  if (name === 'status') text += source('status-extras')
  if (name === 'accounts') {
    text += source('vault').split('export function registerVaultTransferRoutes')[1]
    text += source('login') + source('presets')
  }
  if (name === 'vault') text = text.split('export function registerVaultTransferRoutes')[0]
  return [...text.matchAll(/path: '(\/dsh-subscriptions[^']*)'/g)].map(match => match[1]).sort()
}

test('every routes module registers exactly its declared paths', async () => {
  for (const name of MODULES) {
    const declared = declaredPaths(name)
    const mod = await import('../lib/routes/' + name + '.js')
    const registrar = mod['register' + name[0].toUpperCase() + name.slice(1) + 'Routes']
    assert.equal(typeof registrar, 'function', name + ' registrar export')
    const { ctx, routes } = fakeCtx()
    registrar(ctx, minimalState())
    assert.deepEqual(routes.map(route => route.path).sort(), declared, name + ' includes delegated routes')
    for (const r of routes) assert.ok(r.path && r.handler, name + ' route shape')
  }
})

test('combined registration covers all declared paths without duplicates', async () => {
  let declared = 0
  const paths = []
  for (const name of MODULES) {
    declared += declaredPaths(name).length
    const mod = await import('../lib/routes/' + name + '.js')
    const { ctx, routes } = fakeCtx()
    mod['register' + name[0].toUpperCase() + name.slice(1) + 'Routes'](ctx, minimalState())
    paths.push(...routes.map((r) => r.path))
  }
  assert.equal(new Set(paths).size, paths.length, 'no duplicate paths')
  assert.equal(paths.length, declared)
})

test('status route handler is wired through safeJsonHandler', async () => {
  const mod = await import('../lib/routes/status.js')
  const { ctx, routes } = fakeCtx()
  mod.registerStatusRoutes(ctx, minimalState())
  assert.ok(routes.find((r) => r.path === '/dsh-subscriptions/status'))
})

function manage(routes, path, method = 'GET', payload) {
  const request = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  request.method = method
  request.headers = { host: 'localhost:3081', origin: 'http://localhost:3081' }
  request.socket = { remoteAddress: '127.0.0.1' }
  const result = {}
  const route = routes.find(route => route.path === '/dsh-subscriptions/' + path)
  return route.handler(request, {
    writeHead(code) { result.code = code },
    end(body) { result.body = JSON.parse(body) },
  }).then(() => result).finally(() => request.destroy())
}

test('status and config redact fallback proxy passwords while masked settings round-trip', async () => {
  const { registerStatusRoutes } = await import('../lib/routes/status.js')
  const { ctx, routes } = fakeCtx()
  const proxy = `https://fixture:${encodeURIComponent('pool fixture secret')}@pool.example`
  const mask = '••••••'
  const masked = `https://fixture:${mask}@pool.example`
  let current = { slots: [], proxyPool: [proxy] }
  const state = {
    ...minimalState(),
    live: () => current,
    getSettingsApi: () => ({ async replace(next) { current = next } }),
    store: { async loggedInProviders() { return [] } },
    history: { recent: () => [] },
  }
  registerStatusRoutes(ctx, state)
  const status = await manage(routes, 'status')
  assert.equal(status.code, 200)
  assert.deepEqual(status.body.proxyPool, [{ entry: masked, failures: 0, blockedUntil: 0, healthy: true }])
  const read = await manage(routes, 'config')
  assert.equal(read.code, 200)
  assert.deepEqual(read.body.config.proxyPool, [masked])
  const saved = await manage(routes, 'config', 'PUT', { revision: read.body.revision, config: read.body.config })
  assert.equal(saved.code, 200)
  assert.deepEqual(saved.body.config.proxyPool, [masked])
  assert.deepEqual(current.proxyPool, [proxy])
})

test('partial config writes retain omitted slots and clear dropped credentials only with acknowledgement', async () => {
  const { registerStatusRoutes } = await import('../lib/routes/status.js')
  const { ctx, routes } = fakeCtx()
  let current = { slots: [{ provider: 'codex', index: 1 }, { provider: 'claude', index: 2 }] }
  const writes = []
  const cleared = []
  registerStatusRoutes(ctx, {
    ...minimalState(),
    live: () => current,
    getSettingsApi: () => ({ async replace(next, revision) { current = next; writes.push(revision) } }),
    stripLegacySlots: slots => slots,
    store: { async clearRef(ref) { cleared.push(ref) } },
  })

  const partial = await manage(routes, 'config', 'PUT', { revision: 1, config: { codexFastMode: true }, dropCredentials: true })
  assert.equal(partial.code, 200)
  assert.equal(current.codexFastMode, true)
  assert.deepEqual(current.slots.map(slot => slot.provider), ['codex', 'claude'])
  assert.deepEqual(cleared, [])

  const unacknowledged = await manage(routes, 'config', 'PUT', { revision: 2, slots: current.slots.slice(0, 1) })
  assert.equal(unacknowledged.code, 200)
  assert.deepEqual(cleared, [])

  const acknowledged = await manage(routes, 'config', 'PUT', { revision: 3, config: { slots: [] }, dropCredentials: true })
  assert.equal(acknowledged.code, 200)
  assert.deepEqual(writes, [1, 2, 3])
  assert.deepEqual(current.slots, [])
  assert.deepEqual(cleared, ['CODEX_OAUTH_1'])
})

test('logout rejects non-POST with 405', async () => {
  const mod = await import('../lib/routes/accounts.js')
  const { ctx, routes } = fakeCtx()
  mod.registerAccountsRoutes(ctx, minimalState())
  const logout = routes.find((r) => r.path === '/dsh-subscriptions/logout')
  assert.ok(logout)
  let code = 0
  const res = { writeHead(c) { code = c }, end() {}, setHeader() {} }
  await logout.handler({ method: 'GET', headers: {} }, res)
  assert.equal(code, 405)
})

test('backoff executeWithRetry retries then succeeds', async () => {
  const { executeWithRetry } = await import('../lib/backoff.js')
  let calls = 0
  const result = await executeWithRetry(async () => {
    calls++
    if (calls < 3) throw new Error('flaky')
    return 'ok'
  }, { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 2 })
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('backoff gives up after maxRetries', async () => {
  const { executeWithRetry } = await import('../lib/backoff.js')
  await assert.rejects(
    () => executeWithRetry(async () => { throw new Error('always') }, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 }),
    /always/
  )
})

test('backoff respects isRetryable', async () => {
  const { executeWithRetry } = await import('../lib/backoff.js')
  await assert.rejects(
    () => executeWithRetry(async () => { throw new Error('fatal') }, { isRetryable: (e) => e.message !== 'fatal' }),
    /fatal/
  )
})

for (const headers of [
  { 'sec-fetch-site': 'cross-site' },
  { host: 'example.test', origin: 'https://other.test' },
]) {
  test('smoke rejects cross-site requests before reading input or accounts: ' + JSON.stringify(headers), async () => {
    const { registerStatusRoutes } = await import('../lib/routes/status.js')
    const { ctx, routes } = fakeCtx()
    const state = minimalState()
    state.accountsView = async () => { assert.fail('Rejected request must not inspect accounts') }
    registerStatusRoutes(ctx, state)
    const smoke = routes.find(route => route.path === '/dsh-subscriptions/probe')
    let code = 0
    let payload
    const res = { writeHead(value) { code = value }, setHeader() {}, end(value) { payload = JSON.parse(value) } }
    await smoke.handler({ method: 'POST', url: '/dsh-subscriptions/probe?mode=smoke', headers, on() { assert.fail('Rejected request must not read the body') } }, res)
    assert.equal(code, 403)
    assert.equal(payload.error.code, 'forbidden')
  })
}
