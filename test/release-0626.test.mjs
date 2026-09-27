import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicStream, googleStream, openaiChatStream, toTokenUsage } from '../lib/wire.js'
import { toGeminiSchema } from '../lib/gemini-schema.js'
import { usageWindows } from '../lib/usage.js'
import { streamWithRotation } from '../lib/stream-rotate.js'

function sse(events) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('Google parallel tool calls have distinct indexes and stable nonempty ids', async () => {
  const chunks = await collect(googleStream(sse([
    { candidates: [{ content: { parts: [
      { functionCall: { name: 'first', args: { query: 'a' } } },
      { functionCall: { name: 'second', args: { query: 'b' } } },
      { functionCall: { id: 'provided-id', name: 'third', args: { query: 'c' } } },
    ] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { id: 'provided-id', name: 'third', args: {} } }] } }] },
  ])))
  const calls = chunks.filter(chunk => chunk.type === 'tool-call-delta')
  assert.equal(new Set(calls.slice(0, 3).map(chunk => chunk.index)).size, 3)
  assert.ok(calls.every(chunk => typeof chunk.id === 'string' && chunk.id.length > 0))
  assert.equal(calls[2].id, 'provided-id')
  assert.equal(calls[3].index, calls[2].index)
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 3)
})

test('Anthropic index zero and tool identity survive argument fragments', async () => {
  const chunks = await collect(anthropicStream(sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu-real', name: 'lookup' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '42}' } },
    { type: 'message_delta', usage: { output_tokens: 12 } },
  ])))
  const calls = chunks.filter(chunk => chunk.type === 'tool-call-delta')
  assert.equal(calls.length, 3)
  assert.ok(calls.every(chunk => chunk.id === 'toolu-real' && chunk.index === 0))
  assert.deepEqual(JSON.parse(calls.map(chunk => chunk.argumentsDelta).join('')), { id: 42 })
  assert.deepEqual(toTokenUsage(chunks.find(chunk => chunk.type === 'usage').usage), { inputTokens: 0, outputTokens: 12 })
})

test('OpenAI missing ids and Google omitted counters remain serializable', async () => {
  const calls = await collect(openaiChatStream(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{}' } }] } }] },
  ])))
  assert.equal(calls.find(chunk => chunk.type === 'tool-call-delta').id, 'call_0')
  const google = await collect(googleStream(sse([{ usageMetadata: { promptTokenCount: 7 } }])))
  const usage = google.find(chunk => chunk.type === 'usage').usage
  assert.deepEqual(JSON.parse(JSON.stringify(usage)), { input: 7, output: 0 })
})

test('Gemini enum removes blank and repeated choices but preserves usable values', () => {
  assert.deepEqual(toGeminiSchema({ type: 'string', enum: [' ', null, '', 'a', ' a ', 'b'] }).enum, ['a', 'b'])
  assert.equal(Object.hasOwn(toGeminiSchema({ type: 'string', enum: ['', '  ', null] }), 'enum'), false)
})

test('quota windows keep named periods and the two most-used model buckets', () => {
  const windows = usageWindows({
    five_hour: { utilization: 0 },
    models: [
      { modelId: 'unused', usedPercent: 0 },
      { modelId: 'low', usedPercent: 10 },
      { model: 'medium', usedPercent: 20 },
      { modelId: 'high', usedPercent: 90 },
      { usedPercent: 100 },
    ],
  })
  assert.deepEqual(windows.map(window => window.id), ['five_hour', 'high', 'medium'])
  assert.equal(windows[0].usedPercent, 0)
  assert.equal(usageWindows({ models: [{ modelId: 'unused', usedPercent: 0 }] }), null)
})

function rotation(streamOnce, options = {}) {
  return streamWithRotation({
    accounts: [{ ref: 'first', hasToken: true }, { ref: 'second', hasToken: true }],
    nowMs: () => 1000, cooldownMs: 5000, switchAtRemaining: 0,
    options, streamOnce,
  })
}

function regionError() {
  return Object.assign(new Error('FAILED_PRECONDITION: User location is not supported'), { status: 400 })
}

test('a transient region error retries the same account before yielding output', async () => {
  const attempts = []
  const chunks = await collect(rotation(async function* (account) {
    attempts.push(account.ref)
    if (attempts.length === 1) throw regionError()
    yield { type: 'text-delta', index: 0, text: 'recovered' }
  }))
  assert.deepEqual(attempts, ['first', 'first'])
  assert.equal(chunks[0].text, 'recovered')
})

test('persistent region errors exhaust bounded retries before rotating', async () => {
  const attempts = []
  const chunks = await collect(rotation(async function* (account) {
    attempts.push(account.ref)
    if (account.ref === 'first') throw regionError()
    yield { type: 'text-delta', index: 0, text: 'next account' }
  }))
  assert.deepEqual(attempts, ['first', 'first', 'first', 'second'])
  assert.equal(chunks[0].text, 'next account')
})

test('cancelled region failure does not retry or switch accounts', async () => {
  const controller = new AbortController()
  const attempts = []
  const error = regionError()
  await assert.rejects(collect(rotation(async function* (account) {
    attempts.push(account.ref)
    controller.abort()
    throw error
  }, { signal: controller.signal })), error)
  assert.deepEqual(attempts, ['first'])
})
