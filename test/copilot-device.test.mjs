import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as copilot from '../lib/vendors/copilot.js'

test('Copilot device login exchanges the GitHub token and retains it for refresh', async () => {
  const requests = []
  const impl = async (url, init) => {
    requests.push({ url, init })
    if (url === copilot.COPILOT_DEVICE_CODE_URL) return Response.json({ user_code: 'USER-CODE', device_code: 'device-id', interval: 3, verification_uri: 'https://github.com/login/device' })
    if (url === copilot.COPILOT_DEVICE_TOKEN_URL) return Response.json({ access_token: 'github-token' })
    if (url === copilot.COPILOT_TOKEN_URL) {
      assert.equal(init.headers.Authorization, 'Bearer github-token')
      return Response.json({ token: 'copilot-token', expires_at: 1900000000 })
    }
    assert.equal(url, copilot.COPILOT_USER_URL)
    assert.equal(init.headers.Authorization, 'Bearer github-token')
    return Response.json({ login: 'test-account', email: 'test@example.invalid' })
  }
  const session = await copilot.deviceStart({}, impl)
  assert.deepEqual(session, { userCode: 'USER-CODE', deviceAuthId: 'device-id', intervalMs: 3000, authUrl: 'https://github.com/login/device' })
  const result = await copilot.devicePoll({}, session, impl)
  assert.equal(result.status, 'authorized')
  assert.deepEqual(result.blob, { accessToken: 'copilot-token', refreshToken: 'github-token', githubToken: 'github-token', expiresAt: 1900000000000, label: 'test-account', email: 'test@example.invalid' })
  assert.equal(JSON.parse(requests[1].init.body).device_code, 'device-id')
  const refreshed = await copilot.refresh({}, result.blob, async (url, init) => {
    assert.equal(url, copilot.COPILOT_TOKEN_URL)
    assert.equal(init.headers.Authorization, 'Bearer github-token')
    return Response.json({ token: 'refreshed-token', expires_at: 1900000010 })
  })
  assert.equal(refreshed.accessToken, 'refreshed-token')
  assert.equal(refreshed.expiresAt, 1900000010000)
  assert.equal(refreshed.label, 'test-account')
  assert.equal(refreshed.refreshToken, 'github-token')
})

test('Copilot keeps pending authorization distinct from a denied login', async () => {
  for (const error of ['authorization_pending', 'slow_down']) {
    assert.deepEqual(await copilot.devicePoll({}, { deviceAuthId: 'pending' }, async () => Response.json({ error })), { status: 'pending' })
  }
  await assert.rejects(copilot.devicePoll({}, { deviceAuthId: 'denied' }, async () => Response.json({ error: 'access_denied' })), /access_denied/)
  await assert.rejects(copilot.deviceStart({}, async () => Response.json({ user_code: 'incomplete' })), /incomplete/)
})
