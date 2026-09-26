import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { setImmediate } from 'node:timers/promises'
import { isTrustedSettingsRequest } from '../lib/http.js'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// Render the shipped slot components without a DOM; their effects and button
// handlers use the same fetch implementation as the browser client factory.
function mountClient() {
  const requests = []
  const slots = new Map()
  const states = new Map()
  let hooks, cursor, effects, factory
  const React = {
    Component: class {},
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const current = hooks
      const index = cursor++
      if (!(index in current)) current[index] = typeof initial === 'function' ? initial() : initial
      return [current[index], next => { current[index] = typeof next === 'function' ? next(current[index]) : next }]
    },
    useEffect(effect) { effects.push(effect) },
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(entry) { factory = entry.factory } } },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    fetch: async (path, options) => {
      requests.push({ path, options })
      return { ok: true, json: async () => ({ config: { slots: [], codexFastMode: true }, revision: 7, accounts: [], providers: [] }) }
    },
  })
  const plugin = factory(name => name === 'react' ? React : {})
  plugin.apply({
    effect: fn => fn(),
    locale: { bind: () => key => key, register: () => () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register(spec, component) { slots.set(spec.name, component); return () => {} },
    },
  })
  return {
    requests, slots,
    render(component, props = {}) {
      hooks = states.get(component) || []
      states.set(component, hooks)
      cursor = 0
      effects = []
      const tree = component(props)
      return { tree, effects }
    },
  }
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  for (const child of (tree.children || []).flat()) {
    const match = find(child, predicate)
    if (match) return match
  }
}

test('account status and settings reads omit Referer across a Host-rewriting gateway', async () => {
  const client = mountClient()
  const wrapper = client.render(client.slots.get('conversation.session.header.actions')).tree
  const pill = find(wrapper, node => node.type.name === 'SubsPill')
  const mounted = client.render(pill.type, pill.props)
  for (const effect of mounted.effects) effect()
  await setImmediate()
  assert.deepEqual(client.requests.map(row => row.path), ['/dsh-subscriptions/status', '/dsh-subscriptions/config'])
  for (const { options } of client.requests) {
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, undefined, 'retain browser same-origin credential default')
    assert.equal(isTrustedSettingsRequest({ headers: { host: '127.0.0.1:3381', 'sec-fetch-site': 'same-origin' } }), true)
  }
  assert.equal(isTrustedSettingsRequest({ headers: { host: '127.0.0.1:3381', 'sec-fetch-site': 'same-origin', referer: 'http://127.0.0.1:13381/' } }), false)
})

test('settings page reads and writes preserve methods, payload and revision with the shared request policy', async () => {
  const client = mountClient()
  const card = client.render(client.slots.get('plugins.row.config'), { view: 'page' }).tree
  const section = find(card, node => node.type.name === 'SubsSection')
  const mounted = client.render(section.type, section.props)
  for (const effect of mounted.effects) effect()
  await setImmediate()
  const loaded = client.render(section.type, section.props).tree
  const save = find(loaded, node => node.props.className === 'dsub-save')
  assert.ok(save, 'settings snapshot renders the save control')
  await save.props.onClick()
  const written = client.requests.find(row => row.options.method === 'PUT')
  assert.equal(written.path, '/dsh-subscriptions/config')
  assert.equal(written.options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(written.options.body), { slots: [], codexFastMode: true, revision: 7 })
  assert.ok(client.requests.some(row => row.path === '/dsh-subscriptions/telemetry'))
  assert.ok(client.requests.some(row => row.path === '/dsh-subscriptions/update'))
  for (const { options } of client.requests) assert.equal(options.referrerPolicy, 'no-referrer')
})
