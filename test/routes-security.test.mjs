import { test } from 'node:test'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { parseProxyUrl } from '../lib/proxy.js'
import { registerProxyRoutes } from '../lib/routes/proxy.js'

// #302: the /proxy route is the only prefix route with a caller-controlled
// path. These tests pin its traversal containment and the provider
// allowlist, plus parseProxyUrl scheme hardening.

function harness() {
  const routes = []
  const requested = []
  const ctx = {
    webServer: { register(spec) { routes.push(spec); return () => {} } },
    effect(fn) { fn(); return () => {} },
    log: { warn() {}, error() {}, info() {} },
  }
  const state = {
    live: () => ({}),
    subscriptions: {
      async request(input) {
        requested.push(input)
        return { status: 200, text: async () => '{"ok":true}' }
      },
    },
  }
  registerProxyRoutes(ctx, state)
  const proxy = routes.find((r) => r.path === '/dsh-subscriptions/proxy')
  assert.ok(proxy, 'proxy route registered')
  return { proxy, requested, analyze: routes.find(row => row.path === '/dsh-subscriptions/analyze-session') }
}

const res = () => {
  const s = { code: 0, body: '' }
  return { get code() { return s.code }, set code(v) { s.code = v }, get body() { return s.body }, set body(v) { s.body = v }, writeHead(c) { s.code = c }, end(b) { s.body = b || '' }, setHeader() {} }
}

test('unknown provider is rejected with 404 before any request', async () => {
  const { proxy, requested } = harness()
  const r = res()
  await proxy.handler({ method: 'GET', url: '/dsh-subscriptions/proxy/not-a-vendor/path', headers: { 'sec-fetch-site': 'same-origin' } }, r)
  assert.equal(r.code, 404)
  assert.equal(requested.length, 0)
})

test('dot-dot traversal is neutralized by URL normalization, never forwarded', async () => {
  const { proxy, requested } = harness()
  const r = res()
  await proxy.handler({ method: 'GET', url: '/dsh-subscriptions/proxy/codex/../../admin/secret', headers: { 'sec-fetch-site': 'same-origin' } }, r)
  assert.equal(r.code, 404, 'normalized path must not resolve to a valid provider')
  assert.equal(requested.length, 0)
})

test('percent-encoded traversal is resolved by the URL parser and contained', async () => {
  const { proxy, requested } = harness()
  const r = res()
  // WHATWG URL resolves %2e%2e as a dot segment, so the normalized path
  // leaves no valid provider behind: the request is rejected, not forwarded.
  await proxy.handler({ method: 'GET', url: '/dsh-subscriptions/proxy/codex/%2e%2e/other', headers: { 'sec-fetch-site': 'same-origin' } }, r)
  assert.equal(r.code, 404)
  assert.equal(requested.length, 0)
})

test('a valid provider path is forwarded with the declared provider', async () => {
  const { proxy, requested } = harness()
  const r = res()
  await proxy.handler({ method: 'GET', url: '/dsh-subscriptions/proxy/grok/v1/billing', headers: { 'sec-fetch-site': 'same-origin' } }, r)
  assert.equal(requested.length, 1)
  assert.equal(requested[0].provider, 'grok')
  assert.equal(requested[0].path, '/v1/billing')
})

test('parseProxyUrl allows only http, https and socks5', () => {
  assert.equal(parseProxyUrl('http://p:8080').scheme, 'http')
  assert.equal(parseProxyUrl('https://p').port, 443)
  assert.equal(parseProxyUrl('socks5://u:p@p:1080').auth.username, 'u')
  assert.equal(parseProxyUrl('socks5://p').port, 1080)
  assert.equal(parseProxyUrl('ftp://p'), null)
  assert.equal(parseProxyUrl('file:///etc/passwd'), null)
  assert.equal(parseProxyUrl('gopher://p'), null)
  assert.equal(parseProxyUrl('data:text/html,x'), null)
  assert.equal(parseProxyUrl(''), null)
  assert.equal(parseProxyUrl('not a url'), null)
  assert.equal(parseProxyUrl('http://'), null)
})


for (const headers of [
  { host: 'localhost:3081', 'sec-fetch-site': 'cross-site' },
  { host: 'localhost:3081', origin: 'https://unrelated.example', 'sec-fetch-site': 'same-origin' },
  {},
]) {
  test('cache analysis rejects untrusted requests before consuming the body: ' + JSON.stringify(headers), async () => {
    const { analyze } = harness()
    const response = res()
    await analyze.handler({ method: 'POST', headers, [Symbol.asyncIterator]() { throw new Error('must not consume rejected body') } }, response)
    assert.equal(response.code, 403)
  })
}

test('cache analysis accepts a same-origin POST with token usage', async () => {
  const { analyze } = harness()
  const request = Readable.from([Buffer.from(JSON.stringify({ events: [{ usage: { inputTokens: 100, cacheReadTokens: 25, outputTokens: 10 } }] }))])
  request.method = 'POST'
  request.headers = { host: 'localhost:3081', 'sec-fetch-site': 'same-origin' }
  const response = res()
  await analyze.handler(request, response)
  assert.equal(response.code, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.analysis.weightedCacheHitPercent, 25)
  assert.equal(body.analysis.savedTokens, 25)
  assert.equal(body.analysis.totalTokens, 110)
})
