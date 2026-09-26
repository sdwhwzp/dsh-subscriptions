import { test } from 'node:test'
import assert from 'node:assert/strict'
import { droppedCredentialRefs } from '../lib/refs.js'

test('droppedCredentialRefs returns refs removed from slots', () => {
  const prev = [
    { provider: 'codex', index: 1, label: 'a' },
    { provider: 'grok', index: 1, label: 'b' },
  ]
  const next = [{ provider: 'codex', index: 1, label: 'a' }]
  assert.deepEqual(droppedCredentialRefs(prev, next), ['GROK_OAUTH_1'])
})

test('Codex CLI version configuration reaches both model catalog and identity checks', async () => {
  const { Config } = await import('../lib/config-schema.js')
  const { vendorConfig } = await import('../lib/accounts.js')
  const { getVendor } = await import('../lib/vendors/index.js')
  for (const [override, expected] of [['', '0.157.1'], [' 0.158.0 ', '0.158.0']]) {
    const config = vendorConfig('codex', Config({ codexClientVersion: override }))
    const urls = []
    const fetchImpl = async url => { urls.push(url); return Response.json({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }] }) }
    await getVendor('codex').listModels({ accessToken: 'fixture' }, config, fetchImpl)
    await getVendor('codex').check({ accessToken: 'fixture' }, config, fetchImpl)
    assert.equal(urls.length, 2)
    for (const url of urls) assert.equal(new URL(url).searchParams.get('client_version'), expected)
  }
})
