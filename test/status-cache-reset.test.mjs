import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearKeyRotationCache, readKeyRotationStatus } from '../lib/key-rotation-bridge.js'
import { clearOllamaHealthCache, probeOllama } from '../lib/ollama-health.js'

test('clearing key status discards the cached failure before its TTL expires', async () => {
  clearKeyRotationCache()
  let requests = 0
  const options = { baseUrl: 'http://fixture.invalid', fetchImpl: async () => {
    requests += 1
    return { ok: requests > 1, status: 503, json: async () => ({ providers: [] }) }
  } }
  assert.equal((await readKeyRotationStatus(options)).available, false)
  assert.equal((await readKeyRotationStatus(options)).available, false)
  assert.equal(requests, 1)
  clearKeyRotationCache()
  assert.equal((await readKeyRotationStatus(options)).available, true)
  assert.equal(requests, 2)
  clearKeyRotationCache()
})

test('clearing Ollama health retries a cached unavailable endpoint', async () => {
  clearOllamaHealthCache()
  let requests = 0
  const options = { now: () => 1000, fetchImpl: async () => ({ ok: ++requests > 1 }) }
  assert.equal(await probeOllama('http://fixture.invalid', options), false)
  assert.equal(await probeOllama('http://fixture.invalid', options), false)
  assert.equal(requests, 1)
  clearOllamaHealthCache()
  assert.equal(await probeOllama('http://fixture.invalid', options), true)
  assert.equal(requests, 2)
  clearOllamaHealthCache()
})
