import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountLeaseStore } from '../lib/account-lease.js'
import { ConcurrencyQueue } from '../lib/concurrency-queue.js'
import { streamWithRotation } from '../lib/stream-rotate.js'

const accounts = [
  { ref: 'PRIMARY', hasToken: true },
  { ref: 'SECONDARY', hasToken: true },
]

for (const outcome of ['provider failure', 'transport failure', 'caller cancellation']) {
  test(`a partial tool call cannot rotate after ${outcome}`, async () => {
    const cancelled = outcome === 'caller cancellation'
    const isNetwork = outcome === 'transport failure'
    const controller = new AbortController()
    const failure = Object.assign(new Error('Authorization: Bearer fixture-token'), isNetwork ? { code: 'ECONNRESET' } : { status: 429 })
    const started = []
    const cooled = []
    const traces = []
    const event = { type: 'tool-call-delta', index: 0, id: 'fixture-call', name: 'fixture', argumentsDelta: '{' }
    const stream = streamWithRotation({
      accounts,
      nowMs: () => 1000,
      cooldownMs: 5000,
      options: { defaultRef: 'PRIMARY', rotationStrategy: 'quota-aware', _leaseStore: null, enableSoftFailureSentinel: false, signal: controller.signal },
      concurrencyQueue: new ConcurrencyQueue(),
      onCooldown: (account) => cooled.push(account),
      onDecisionTrace: (trace) => traces.push(trace),
      async *streamOnce(account) {
        started.push(account.ref)
        yield event
        throw failure
      },
    })
    try {
      assert.deepEqual(await stream.next(), { value: event, done: false })
      if (cancelled) controller.abort(failure)
      await assert.rejects(stream.next(), (error) => error === failure)
    } finally {
      await stream.return()
    }
    assert.deepEqual(started, ['PRIMARY'])
    assert.equal(traces.at(-1)?.finalOutcome, cancelled ? 'aborted' : 'stream_error')
    if (!cancelled) assert.equal(traces[0].attempts[0].error, 'Authorization: [redacted]')
    if (isNetwork) assert.equal(traces[0].attempts[0].transportCode, 'ECONNRESET')
    assert.deepEqual(cooled.map(account => account.ref), cancelled || isNetwork ? [] : ['PRIMARY'])
  })
}

test('a queue rejection can rotate away from the default account', async () => {
  const queue = new ConcurrencyQueue()
  const release = await queue.acquire('PRIMARY')
  const stream = streamWithRotation({
    accounts,
    options: { defaultRef: 'PRIMARY', rotationStrategy: 'quota-aware', _leaseStore: null, enableQueue: false },
    concurrencyQueue: queue,
    async *streamOnce(account) { yield { type: 'text-delta', text: account.ref } },
  })
  try {
    assert.deepEqual(await Array.fromAsync(stream), [{ type: 'text-delta', text: 'SECONDARY' }])
    assert.equal(queue.stats().metrics.totalOverflowed, 2)
  } finally {
    release()
  }
})

test('cancelling a queued stream leaves no account lease', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-subscriptions-stream-lease-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const leaseStore = new AccountLeaseStore({ dir, now: () => 1000 })
  const queue = new ConcurrencyQueue({ timeoutMs: 0 })
  const release = await queue.acquire('PRIMARY')
  const controller = new AbortController()
  const stream = streamWithRotation({
    accounts,
    options: { defaultRef: 'PRIMARY', signal: controller.signal, _leaseStore: leaseStore },
    concurrencyQueue: queue,
    async *streamOnce() { assert.fail('cancelled queued stream must never call a provider') },
  })
  const rejected = assert.rejects(stream.next(), { name: 'AbortError' })
  try {
    assert.equal(queue.stats().byKey.PRIMARY.queued, 1)
  } finally {
    controller.abort()
    release()
    await rejected
  }
  assert.deepEqual(leaseStore.list(), [])
  assert.equal(queue.stats().totalActive, 0)
})

test('a declared network failure uses bounded retries without cooling an account', async () => {
  const started = []
  const cooled = []
  const error = Object.assign(new Error('fixture transport failure'), { code: 'NETWORK' })
  const stream = streamWithRotation({
    accounts,
    nowMs: () => 1000,
    cooldownMs: 5000,
    options: { defaultRef: 'PRIMARY', rotationStrategy: 'quota-aware', _leaseStore: null },
    concurrencyQueue: new ConcurrencyQueue(),
    onCooldown: (account) => cooled.push(account),
    async *streamOnce(account) {
      started.push(account.ref)
      throw error
    },
  })
  await assert.rejects(Array.fromAsync(stream), { code: 'NETWORK', transport: true, cause: error })
  assert.deepEqual(started, ['PRIMARY', 'PRIMARY', 'PRIMARY'])
  assert.deepEqual(cooled, [])
})
