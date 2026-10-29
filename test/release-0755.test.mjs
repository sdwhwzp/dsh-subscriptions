import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeClaudeCredentials } from '../lib/claude-keychain.js'
import { referenceImageRequest } from '../lib/media-reference.js'
import { isSecretLike, sanitizeSecrets } from '../lib/secret-scan.js'
import { resolvePublicHostname } from '../lib/webhook-url.js'

test('Claude credential merge retains the newest valid token without accessing the keychain', () => {
  const current = { accessToken: 'current', refreshToken: 'refresh-one', expiresAt: 200 }
  const older = { accessToken: 'older', refreshToken: 'refresh-two', expiresAt: 100 }
  const newer = { ...older, accessToken: 'newer', expiresAt: 300 }
  assert.deepEqual(mergeClaudeCredentials(current, older), current)
  assert.deepEqual(mergeClaudeCredentials(current, newer), newer)
  assert.deepEqual(mergeClaudeCredentials(null, newer), newer)
  assert.equal(mergeClaudeCredentials(null, {}), null)
})

test('reference image requests validate duplicate refs and preserve provider payloads', () => {
  assert.deepEqual(referenceImageRequest('grok', { prompt: 'fixture', references: ['attachment-one'] }), {
    model: 'grok-2-image', prompt: 'fixture', image_urls: ['attachment-one'],
  })
  assert.deepEqual(referenceImageRequest('codex', { prompt: 'fixture', references: ['attachment-one'], size: '1024x1024' }), {
    model: 'gpt-image-1', prompt: 'fixture', images: [{ image_url: 'attachment-one' }], size: '1024x1024',
  })
  assert.throws(() => referenceImageRequest('grok', { references: ['duplicate', 'duplicate'] }), { code: 'INVALID_MEDIA_REFERENCE' })
})

test('provider error redaction removes quoted JSON tokens and common header secrets', () => {
  const fixture = '{"access_token":"fixture-access-123","refresh_token":"fixture-refresh-456"}'
  assert.equal(isSecretLike(fixture), true)
  assert.deepEqual(JSON.parse(sanitizeSecrets(fixture)), {
    access_token: '[redacted]', refresh_token: '[redacted]',
  })
  assert.equal(sanitizeSecrets('Authorization: Bearer fixture-token-123'), 'Authorization: [redacted]')
  assert.equal(isSecretLike('ordinary provider failure'), false)
})

test('webhook DNS admission requires a nonempty set of public addresses', async () => {
  for (const records of [[], null, [{}], [{ address: '127.0.0.1' }], [{ address: '203.0.113.10' }, { address: '192.168.1.1' }]]) {
    assert.equal(await resolvePublicHostname('receiver.invalid', { lookupImpl: async () => records }), false)
  }
  assert.equal(await resolvePublicHostname('receiver.invalid', { lookupImpl: async () => [{ address: '203.0.113.10' }] }), true)
  assert.equal(await resolvePublicHostname('receiver.invalid', { lookupImpl: async () => { throw new Error('fixture DNS failure') } }), false)
})
