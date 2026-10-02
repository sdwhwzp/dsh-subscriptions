import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { codexResponsesBody, normalizeCodexCallId } from '../lib/messages.js'
import { normalizeJsonSchema } from '../lib/tools-normalizer.js'
import { decryptWithPassphrase, encryptWithPassphrase } from '../lib/crypto.js'
import { isSameOrigin, isTrustedSettingsRequest } from '../lib/http.js'

test('long Codex call ids preserve call/result pairing without prefix collisions', () => {
  const id = 'tool-call-'.repeat(12)
  const other = id + 'different'
  const normalized = normalizeCodexCallId(id)
  assert.equal(normalized.length, 64)
  assert.notEqual(normalized, normalizeCodexCallId(other))
  assert.equal(normalizeCodexCallId('short-id'), 'short-id')
  const { input: rows } = codexResponsesBody({ messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id, name: 'fixture', arguments: { value: 1 } }] },
    { role: 'tool', toolCallId: id, content: 'result' },
  ] })
  assert.equal(rows.find(row => row.type === 'function_call').call_id, normalized)
  assert.equal(rows.find(row => row.type === 'function_call_output').call_id, normalized)
})

test('tool schemas retain boolean constraints, alternatives and reusable definitions', () => {
  assert.equal(normalizeJsonSchema(false), false)
  const schema = {
    type: 'object',
    properties: { value: { anyOf: [{ $ref: '#/$defs/choice' }, { const: null }] }, blocked: false },
    $defs: { choice: { type: 'string', enum: ['one', 'two'] } },
    required: ['value'], additionalProperties: false,
  }
  assert.deepEqual(normalizeJsonSchema(schema), schema)
})

test('default vault export and both older encrypted formats remain readable', () => {
  const passphrase = 'fixture-password'
  const plain = '{"fixture":"preserved"}'
  assert.match(encryptWithPassphrase(plain, passphrase), /^DSHE2:/)
  assert.equal(decryptWithPassphrase(encryptWithPassphrase(plain, passphrase, { algorithm: 'scrypt' }), passphrase), plain)
  const salt = Buffer.alloc(16, 1), iv = Buffer.alloc(12, 2)
  const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256'), iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  const legacy = 'DSHE2:' + Buffer.concat([salt, iv, cipher.getAuthTag(), data]).toString('base64')
  assert.equal(decryptWithPassphrase(legacy, passphrase), plain)
  assert.throws(() => decryptWithPassphrase(legacy, 'wrong-password'))
})

test('origin comparison rejects invalid URLs and distinct protocol or port', () => {
  assert.equal(isSameOrigin('https://EXAMPLE.test/a', 'https://example.test/b'), true)
  for (const value of ['not-url', 'http://example.test', 'https://example.test:3081']) {
    assert.equal(isSameOrigin('https://example.test', value), false)
  }
})

test('remote management trust cannot be forged through host, metadata or cookie substrings', t => {
  const previous = process.env.DSH_AUTH_TOKEN
  process.env.DSH_AUTH_TOKEN = 'fixture-token'
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_AUTH_TOKEN
    else process.env.DSH_AUTH_TOKEN = previous
  })
  const request = headers => ({ headers: { host: 'host.test', ...headers }, socket: { remoteAddress: '192.0.2.10' } })
  const ctx = { webServer: { url: 'https://host.test' } }
  for (const headers of [
    {}, { 'sec-fetch-site': 'same-origin' }, { origin: 'https://host.test' },
    { authorization: 'Bearer wrong' }, { cookie: 'not_token=fixture-token' },
    { cookie: 'token=fixture-token-extra' },
  ]) assert.equal(isTrustedSettingsRequest(request(headers), ctx), false)
  assert.equal(isTrustedSettingsRequest(request({ cookie: 'dsh_token=fixture-token' }), ctx), true)
  assert.equal(isTrustedSettingsRequest(request({ authorization: 'Bearer fixture-token' }), ctx), true)
  assert.equal(isTrustedSettingsRequest(request({ 'sec-fetch-site': 'cross-site' }), { connection: { requestRejection: () => undefined } }), false)
  assert.equal(isTrustedSettingsRequest(request({}), { connection: { requestRejection: () => undefined } }), true)
  assert.equal(isTrustedSettingsRequest(request({}), { connection: { requestRejection: () => 401 } }), false)
})
