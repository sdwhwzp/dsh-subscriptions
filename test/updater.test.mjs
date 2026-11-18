import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSemver,
  isNewerVersion,
  isForkBuild,
  isLoopback,
  isTrustedUpdateRequest,
  readCurrentVersion,
  getUpdaterStatus,
  registerPluginUpdater,
} from '../lib/updater.js'

const packageName = '@goodandready/dsh-subscriptions'
const forkVersion = '0.6.12-dsh.20260918.1'
const registry = 'https://updates.example.invalid'

async function manifestFixture(t, version) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-subscriptions-updater-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const manifestUrl = join(dir, 'package.json')
  await writeFile(manifestUrl, JSON.stringify({ name: packageName, version }))
  return { dir, manifestUrl }
}

test('updater: parseSemver parses valid and invalid semver', () => {
  assert.deepEqual(parseSemver('0.6.8'), { core: [0, 6, 8], prerelease: [] })
  assert.deepEqual(parseSemver('v1.2.3'), { core: [1, 2, 3], prerelease: [] })
  assert.deepEqual(parseSemver('1.0.0-beta.2'), { core: [1, 0, 0], prerelease: ['beta', '2'] })
  assert.equal(parseSemver('invalid'), undefined)
  assert.equal(parseSemver('1.2'), undefined)
  assert.equal(parseSemver(''), undefined)
})

test('updater: isNewerVersion compares versions correctly', () => {
  assert.equal(isNewerVersion('0.6.8', '0.6.9'), true)
  assert.equal(isNewerVersion('0.6.8', '0.7.0'), true)
  assert.equal(isNewerVersion('0.6.8', '1.0.0'), true)
  assert.equal(isNewerVersion('0.6.8', '0.6.8'), false)
  assert.equal(isNewerVersion('0.6.8', '0.6.7'), false)
  assert.equal(isNewerVersion('0.6.8-beta.1', '0.6.8'), true)
  assert.equal(isNewerVersion('0.6.8-beta.1', '0.6.8-beta.2'), true)
  assert.equal(isNewerVersion('0.6.8', 'invalid'), false)
})

test('updater: isLoopback recognizes IPv4, IPv6 and hostnames', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('127.0.1.1'), true)
  assert.equal(isLoopback('localhost'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('[::1]'), true)
  assert.equal(isLoopback('::ffff:127.0.0.1'), true)
  assert.equal(isLoopback('192.168.1.111'), false)
  assert.equal(isLoopback('8.8.8.8'), false)
  assert.equal(isLoopback('example.com'), false)
  assert.equal(isLoopback(null), false)
  assert.equal(isLoopback(undefined), false)
})

test('updater: isTrustedUpdateRequest validates headers and remote addresses', () => {
  // Trusted loopback with custom header
  assert.equal(isTrustedUpdateRequest({
    headers: { 'x-dsh-plugin-update': '1', host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' },
  }), true)

  // Non-loopback remote is rejected
  assert.equal(isTrustedUpdateRequest({
    headers: { 'x-dsh-plugin-update': '1', host: '127.0.0.1:3000' },
    socket: { remoteAddress: '192.168.1.100' },
  }), false)

  // Cross-site request without update header is rejected
  assert.equal(isTrustedUpdateRequest({
    headers: { 'sec-fetch-site': 'cross-site', host: 'localhost:3000' },
    socket: { remoteAddress: '127.0.0.1' },
  }), false)

  // Same-origin browser request on loopback is trusted
  assert.equal(isTrustedUpdateRequest({
    headers: {
      origin: 'http://localhost:3000',
      host: 'localhost:3000',
      'sec-fetch-site': 'same-origin',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }), true)
})

test('updater: readCurrentVersion reads package.json version', async () => {
  const version = await readCurrentVersion(new URL('../package.json', import.meta.url))
  assert.match(version, /^\d+\.\d+\.\d+/)
})

test('updater: getUpdaterStatus returns status structure', async t => {
  const { dir, manifestUrl } = await manifestFixture(t, '0.6.12')
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ version: '0.6.13' })))
  const status = await getUpdaterStatus({ packageName, manifestUrl, registry }, { profileName: 'web', profileDir: dir })
  assert.equal(status.ok, true)
  assert.equal(status.packageName, '@goodandready/dsh-subscriptions')
  assert.equal(status.currentVersion, '0.6.12')
  assert.equal(status.latestVersion, '0.6.13')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.profileName, 'web')
  assert.equal(status.canAutoUpdate, false) // no cliEntry in mock target
})

test('updater: fork builds never advertise or run a registry update', async t => {
  assert.equal(isForkBuild(forkVersion), true)
  assert.equal(isForkBuild('0.6.12'), false)
  assert.equal(isForkBuild('0.6.12-beta.1'), false)
  const { dir, manifestUrl } = await manifestFixture(t, forkVersion)
  const originalProfileDir = process.env.DSH_PROFILE_DIR
  t.after(() => {
    if (originalProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = originalProfileDir
  })
  process.env.DSH_PROFILE_DIR = dir
  const registryFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected registry request') })
  const status = await getUpdaterStatus({ packageName, manifestUrl, registry }, {
    profileName: 'web',
    profileDir: dir,
    cliEntry: join(dir, 'bin.js'),
  })
  assert.equal(status.forkBuild, true)
  assert.equal(status.latestVersion, undefined)
  assert.equal(status.latestCheckFailed, false)
  assert.equal(status.updateAvailable, false)
  assert.equal(status.canAutoUpdate, false)

  let registeredRoute
  registerPluginUpdater({ webServer: { register(spec) { registeredRoute = spec; return () => {} } }, logger: { warn() {} } }, {
    endpoint: '/dsh-subscriptions/update',
    packageName,
    manifestUrl,
    registry,
  })
  let statusCode = 0
  let body = ''
  await registeredRoute.handler({
    method: 'POST',
    headers: { 'x-dsh-plugin-update': '1', host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' },
  }, { writeHead(code) { statusCode = code }, setHeader() {}, end(chunk) { if (chunk) body += chunk } })
  assert.equal(statusCode, 200)
  const payload = JSON.parse(body)
  assert.equal(payload.ok, true)
  assert.equal(payload.forkBuild, true)
  assert.equal(payload.updatedVersion, undefined)
  assert.equal(registryFetch.mock.callCount(), 0)
})

test('updater: route checks trust before returning status or rejecting unsupported methods', async t => {
  const { manifestUrl } = await manifestFixture(t, forkVersion)
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected registry request') })
  let registeredRoute = null
  const mockCtx = {
    webServer: {
      register(spec) {
        registeredRoute = spec
        return () => {}
      },
    },
    logger: { warn() {} },
  }

  registerPluginUpdater(mockCtx, {
    endpoint: '/dsh-subscriptions/update',
    packageName,
    manifestUrl,
    registry,
  })

  assert.ok(registeredRoute)
  assert.equal(registeredRoute.path, '/dsh-subscriptions/update')

  const createMockRes = () => {
    let statusCode = 200
    const headers = {}
    let body = ''
    return {
      writeHead(code, h) { statusCode = code; Object.assign(headers, h) },
      setHeader(k, v) { headers[k] = v },
      end(chunk) { if (chunk) body += chunk },
      get statusCode() { return statusCode },
      get body() { return body },
      get headers() { return headers },
    }
  }

  // GET returns 200 with updater status
  const getRes = createMockRes()
  await registeredRoute.handler({
    method: 'GET',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  }, getRes)
  assert.equal(getRes.statusCode, 200)
  const getPayload = JSON.parse(getRes.body)
  assert.equal(getPayload.ok, true)
  assert.equal(getPayload.packageName, '@goodandready/dsh-subscriptions')

  // PUT returns 405
  const putRes = createMockRes()
  await registeredRoute.handler({
    method: 'PUT',
    headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  }, putRes)
  assert.equal(putRes.statusCode, 405)
  assert.equal(putRes.headers.allow, 'GET, HEAD, POST')

  for (const method of ['GET', 'HEAD', 'POST']) {
    const untrusted = createMockRes()
    await registeredRoute.handler({
      method,
      headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '192.0.2.10' },
    }, untrusted)
    assert.equal(untrusted.statusCode, 403, method)
    const untrustedPayload = JSON.parse(untrusted.body)
    assert.equal(untrustedPayload.ok, false)
    assert.equal(untrustedPayload.error.code, 'forbidden')
  }
})
