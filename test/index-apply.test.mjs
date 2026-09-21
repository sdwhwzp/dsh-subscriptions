import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HistoryStore } from '../lib/history.js'

let histories
beforeEach((t) => {
  histories = []
  t.mock.method(HistoryStore.prototype, '_load', function () { histories.push(this) })
  t.mock.method(HistoryStore.prototype, '_persist', () => {})
  t.mock.method(HistoryStore.prototype, 'flush', () => {})
})
afterEach(() => {
  for (const store of histories) process.removeListener('beforeExit', store._exitHandler)
})

// #288 follow-up: index.js apply() sat at 7.8% coverage because the
// cordis context is only available inside the harness. This fake ctx
// pins the plugin entry contract: what gets provided, registered and
// wired, and that apply stays synchronous and disposable.

function fakeCtx() {
  const state = {
    provided: {},
    adapters: [],
    tools: [],
    routes: [],
    effects: [],
    injections: [],
    cleanups: [],
    emitted: [],
  }
  const ctx = {
    on(name, listener) { state.listener = listener; state.event = name; return () => { state.listener = undefined } },
    log: { warn() {}, error() {}, info() {} },
    emit(name, payload) { state.emitted.push({ name, payload }) },
    provide(name, value) {
      state.provided[name] = value
      return () => { delete state.provided[name] }
    },
    effect(fn, label) {
      state.effects.push(label || '(unlabelled)')
      const cleanup = fn()
      const dispose = typeof cleanup === 'function' ? cleanup : () => {}
      state.cleanups.push(dispose)
      return dispose
    },
    inject(names, fn) {
      state.injections.push(names)
      fn(ctx)
      return () => {}
    },
    llm: {
      registerAdapter(providers, adapter) {
        state.adapters.push({ providers, adapter })
        return { dispose() {} }
      },
    },
    credentials: {
      get: async () => null,
      set: async () => {},
      list: async () => [],
      clearRef: async () => {},
    },
    webServer: {
      register(spec) { state.routes.push(spec); return () => {} },
      tapIndex(html) { return html },
    },
    settings: {
      register() {
        return { get: () => ({}), set: async () => {}, watch: () => () => {} }
      },
    },
    tools: { register(tool) { state.tools.push(tool); return () => {} } },
  }
  return { ctx, state }
}

async function loadPlugin() {
  const mod = await import('../lib/index.js')
  return mod
}

for (const enabled of [false, true]) {
  test(`chat fallback is opt-in and does not revisit a provider (enabled=${enabled})`, async () => {
    const mod = await loadPlugin()
    const { ctx, state } = fakeCtx()
    const config = mod.Config({
      slots: [{ provider: 'claude', index: 1 }, { provider: 'cursor', index: 1 }],
      cascadingFallback: enabled, cascadingChain: { claude: ['cursor'], cursor: ['claude'] },
      ollamaFallback: false, probeIntervalMin: 0,
    })
    const registered = Promise.withResolvers()
    ctx.settings.register = () => ({ get: () => config, watch: () => () => {} })
    ctx.credentials.describe = async () => ({ configured: true })
    ctx.credentials.resolve = async () => null
    ctx.llm.listProviders = () => []
    ctx.llm.registerAdapter = (providers, adapter) => { registered.resolve(adapter); return () => {} }
    mod.apply(ctx, config)
    try {
      const routed = await registered.promise
      let configBody
      await state.routes.find(row => row.path === '/dsh-subscriptions/config').handler(
        { method: 'GET', headers: {} },
        { writeHead() {}, end(body) { configBody = JSON.parse(body) } },
      )
      assert.deepEqual(configBody.accounts.map(account => account.healthScore), [100, 100])
      const visited = []
      routed.adapter.deps.listAccounts = async (provider) => {
        visited.push(provider)
        if (visited.length > 4) throw Object.assign(new Error('cycle fixture'), { name: 'AbortError' })
        return []
      }
      await assert.rejects(routed.stream({ provider: 'subscriptions-claude', model: 'fixture', messages: [] }).next())
      assert.deepEqual(visited, enabled ? ['claude', 'cursor'] : ['claude'])
    } finally { for (const off of state.cleanups.reverse()) off() }
  })
}

test('plugin metadata declares the cordis contract', async () => {
  const mod = await loadPlugin()
  assert.equal(mod.name, '@goodandready/dsh-subscriptions')
  assert.deepEqual(mod.inject, ['llm', 'credentials', 'webServer', 'settings'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.Config, 'function')
})

test('apply wires the plugin without throwing and provides its services', async () => {
  const mod = await loadPlugin()
  const { ctx, state } = fakeCtx()
  mod.apply(ctx, mod.Config({}))
  try {
    assert.ok(state.provided.subscriptions, 'subscriptions service provided')
    assert.equal(typeof state.provided.subscriptions.request, 'function')
    assert.ok(state.provided.subscriptionImages, 'subscriptionImages service provided')
    assert.ok(state.routes.length > 0, 'routes registered')
    // adapter registration is driven by syncAdapter on config changes, not apply itself
    assert.ok(state.injections.some((n) => n.includes('settings')), 'settings injected')
    assert.ok(state.effects.length > 0, 'effects registered')
    for (const r of state.routes) assert.ok(r.path && r.handler, 'route shape')
    assert.ok(state.routes.some((r) => r.path === '/dsh-subscriptions/status'))
    assert.ok(state.routes.some((r) => r.path === '/dsh-subscriptions/config'))
  } finally {
    for (const c of state.cleanups) {
      try { c() } catch { /* disposal must not throw either */ }
    }
  }
})

test('apply is idempotent over a fresh ctx and disposes cleanly', async () => {
  const mod = await loadPlugin()
  const { ctx, state } = fakeCtx()
  mod.apply(ctx, mod.Config({}))
  assert.ok(Object.keys(state.provided).length >= 2)
  for (const c of state.cleanups) c()
  assert.deepEqual(Object.keys(state.provided), [], 'provide cleanups remove services')
})

test('config defaults are applied when apply is called with an empty object', async () => {
  const mod = await loadPlugin()
  const { ctx, state } = fakeCtx()
  mod.apply(ctx, {})
  try {
    assert.ok(state.provided.subscriptions)
  } finally {
    for (const c of state.cleanups) c()
  }
})


test('only the extended Claude route omits the MCP probe from logged assemblies', async () => {
  const { ctx, state } = fakeCtx()
  const mod = await loadPlugin()
  mod.apply(ctx, {})
  try {
    for (const provider of ['subscriptions-claude', 'subscriptions-codex', 'deepseek']) {
      const assembly = { variables: { provider }, tools: [{ name: 'mcp_probe' }, { name: 'mcp_search' }] }
      const result = await state.listener(assembly, {}, async () => assembly)
      assert.equal(result.tools.some(tool => tool.name === 'mcp_probe'), provider !== 'subscriptions-claude')
      assert.equal(result.tools.some(tool => tool.name === 'mcp_search'), true)
    }
  } finally {
    for (const off of state.cleanups.reverse()) off()
  }
})

for (const claimed of [false, true]) {
  test(`namespaced provider registration preserves other adapters (claimed=${claimed})`, async () => {
    const mod = await loadPlugin()
    const { ctx, state } = fakeCtx()
    const config = mod.Config({ slots: [{ provider: 'codex', index: 1, ref: 'subscriptions.codex.1' }] })
    ctx.settings.register = () => ({ get: () => config, watch: () => () => {} })
    ctx.credentials.describe = async () => ({ configured: true })
    ctx.credentials.resolve = async () => null
    ctx.llm.listProviders = () => [{ id: claimed ? 'subscriptions-codex' : 'codex' }]
    mod.apply(ctx, config)
    try {
      await new Promise(resolve => setImmediate(resolve))
      if (claimed) assert.deepEqual(state.adapters, [])
      else {
        assert.ok(state.adapters.length > 0)
        for (const row of state.adapters) assert.deepEqual(row.providers, ['subscriptions-codex'])
      }
    } finally {
      for (const off of state.cleanups.reverse()) off()
    }
  })
}
