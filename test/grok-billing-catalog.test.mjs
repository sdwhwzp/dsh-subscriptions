import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usage, streamOnce, grokCatalogCacheSize, clearGrokCatalogCache } from '../lib/vendors/grok.js'

test('Grok usage reads credit billing JSON with authenticated CLI identity', async () => {
  const result = await usage({ accessToken: 'fixture-token' }, {}, async (url, init) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits')
    assert.equal(init.headers.Authorization, 'Bearer fixture-token')
    assert.equal(init.headers['X-XAI-Token-Auth'], 'xai-grok-cli')
    return Response.json({ config: { monthlyLimit: 100, usedCredits: 25 } })
  })
  assert.equal(result.usedPercent, 25)
  assert.equal(await usage({}, {}, async () => { throw new Error('offline') }), null)
})

test('Grok reasoning catalog caches each credential separately and stays bounded', async t => {
  clearGrokCatalogCache()
  t.after(clearGrokCatalogCache)
  const catalogs = []
  const run = async token => {
    for await (const chunk of streamOnce({
      blob: { accessToken: token }, config: {}, headers: {},
      options: { model: 'grok-test', reasoningEffort: 'high', messages: [] },
      fetchImpl: async (url, init) => {
        if (url.endsWith('/models')) {
          catalogs.push(init.headers.Authorization)
          return Response.json({ data: [{ id: 'grok-test', supports_reasoning_effort: true, reasoning_efforts: ['high'] }] })
        }
        assert.deepEqual(JSON.parse(init.body).reasoning, { effort: 'high' })
        return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })) assert.ok(chunk)
  }
  await run('first')
  await run('first')
  await run('second')
  assert.deepEqual(catalogs, ['Bearer first', 'Bearer second'])
  for (let i = 0; i < 33; i++) await run('token-' + i)
  assert.equal(grokCatalogCacheSize(), 32)
  await run('first')
  assert.equal(catalogs.at(-1), 'Bearer first')
  assert.equal(catalogs.filter(value => value === 'Bearer first').length, 2)
})
