import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSubscriptionTools } from '../lib/native-tools.js'

function fixture(access) {
  const definitions = new Map()
  const requests = []
  let disposed = 0
  const dispose = registerSubscriptionTools({
    get: () => typeof access === 'function' ? access() : access,
    tools: { register(definition) {
      definitions.set(definition.name, definition)
      return () => { disposed += 1 }
    } },
  }, {
    images: () => { throw new Error('image service must not run for a denied principal') },
    subscriptions: { request: async (request) => {
      requests.push(request)
      return new Response(JSON.stringify({ output_text: 'fixture search' }))
    } },
  })
  return { definitions, requests, dispose, disposed: () => disposed }
}

test('shared subscription tools deny ordinary and missing principals before any request or file write', async () => {
  const f = fixture({ assertAuthenticated() { throw new Error('must not admit this principal') } })
  for (const definition of f.definitions.values()) {
    for (const principal of [undefined, { role: 'user' }]) {
      await assert.rejects(definition.execute({}, { principal }), /authenticated administrator/)
    }
  }
  assert.equal(f.definitions.size, 4)
  assert.equal(f.requests.length, 0)
  f.dispose()
  assert.equal(f.disposed(), 4)
})

test('administrator execution revalidates current access before using the shared subscription', async () => {
  const principal = { role: 'admin' }
  let revoked = false
  let checked = 0
  const f = fixture({ assertAuthenticated(actual) {
    assert.equal(actual, principal)
    checked += 1
    if (revoked) throw new Error('account revoked')
  } })
  const tool = f.definitions.get('web_search')
  assert.deepEqual(await tool.execute({ query: 'fixture' }, { principal }), { text: 'fixture search' })
  assert.equal(f.requests.length, 1)
  revoked = true
  await assert.rejects(tool.execute({ query: 'denied' }, { principal }), /account revoked/)
  assert.equal(checked, 2)
  assert.equal(f.requests.length, 1)
  f.dispose()
})

test('local profiles without a principal-access provider retain subscription search', async () => {
  const f = fixture(undefined)
  assert.deepEqual(await f.definitions.get('web_search').execute({ query: 'local' }, {}), { text: 'fixture search' })
  assert.equal(f.requests.length, 1)
  f.dispose()
})

test('removing the account service does not restore anonymous local access', async () => {
  let access = { assertAuthenticated() {} }
  const f = fixture(() => access)
  access = undefined
  for (const definition of f.definitions.values()) {
    for (const principal of [undefined, { role: 'admin' }]) {
      await assert.rejects(definition.execute({}, { principal }), /authenticated administrator/)
    }
  }
  assert.equal(f.requests.length, 0)
  f.dispose()
})
