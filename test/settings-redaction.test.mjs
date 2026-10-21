import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicConfig, restoreMaskedSecrets } from '../lib/config-schema.js'

const stored = {
  masterKey: 'master', vaultSyncS3SecretKey: 's3-secret', vaultSyncWebdavPassword: 'webdav',
  slots: [{ provider: 'codex', index: 1, proxyUrl: 'https://fixture:secret@proxy.example' }],
  customVendors: [{ id: 'private', apiKey: 'api-key', headers: { Authorization: 'Bearer private-token' } }],
}

test('saving redacted settings retains existing secrets and accepts explicit replacements', () => {
  const redacted = publicConfig(stored)
  assert.equal(JSON.stringify(redacted).includes('private-token'), false)
  assert.deepEqual(restoreMaskedSecrets(redacted, stored), stored)
  assert.equal(restoreMaskedSecrets({ vaultSyncS3SecretKey: 'replacement' }, stored).vaultSyncS3SecretKey, 'replacement')
  assert.equal(restoreMaskedSecrets({ vaultSyncS3SecretKey: '' }, stored).vaultSyncS3SecretKey, '')
})

test('a masked field cannot borrow another provider or proxy credential', () => {
  const vendor = publicConfig(stored).customVendors[0]
  assert.throws(() => restoreMaskedSecrets({ customVendors: [{ ...vendor, id: 'other' }] }, stored), /existing account or provider/)
  const slot = publicConfig(stored).slots[0]
  assert.throws(() => restoreMaskedSecrets({ slots: [{ ...slot, index: 2 }] }, stored), /proxy credentials/)
  assert.throws(() => restoreMaskedSecrets({ slots: [{ ...slot, proxyUrl: slot.proxyUrl.replace('proxy.example', 'other.example') }] }, stored), /proxy credentials/)
  assert.throws(() => restoreMaskedSecrets({ masterKey: '••••••' }, {}), /existing account or provider/)
})
