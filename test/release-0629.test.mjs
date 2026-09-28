import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openaiTools, anthropicPayload, codexResponsesBody } from '../lib/messages.js'
import { withRunawayGuard } from '../lib/runaway-guard.js'

test('normalized tool definitions accept required keys without a properties map', () => {
  assert.deepEqual(openaiTools({ tools: [{ name: 'lookup', parameters: { type: 'object', required: ['query'] } }] })[0].function.parameters,
    { type: 'object', required: ['query'] })
})

test('current tool failures and base64 images survive Anthropic request normalization together', () => {
  const body = anthropicPayload({ model: 'claude', system: 'One\r\nrule', messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_1', isError: true, content: [{ type: 'text', text: 'permission denied' }] },
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
  ] })
  const blocks = body.messages.flatMap(message => message.content)
  assert.deepEqual(blocks.find(block => block.type === 'tool_result'), { type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: 'permission denied', cache_control: { type: 'ephemeral' } })
  assert.deepEqual(blocks.find(block => block.type === 'image').source, { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' })
})

test('Codex preserves image inputs and matches a historical tool output to its call', () => {
  const body = codexResponsesBody({ model: 'gpt-test', messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'found' }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
  ] })
  assert.equal(body.input.find(item => item.type === 'function_call_output').call_id, 'call_1')
  assert.ok(body.input.flatMap(item => item.content || []).some(block => block.type === 'input_image'))
})

test('the runaway guard closes a repeating stream and can be disabled explicitly', async () => {
  let closed = 0
  async function* stream() {
    try {
      for (let i = 0; i < 8; i++) yield { type: 'text-delta', index: 0, text: 'x' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { closed++ }
  }
  const output = []
  for await (const chunk of withRunawayGuard(stream(), { maxIdenticalConsecutive: 3 })) output.push(chunk)
  assert.equal(output.at(-1).reason.message, 'runaway_loop_detected')
  assert.equal(output.filter(chunk => chunk.type === 'text-delta').length, 2)
  assert.equal(closed, 1)
  const unguarded = []
  for await (const chunk of withRunawayGuard(stream(), { enabled: false })) unguarded.push(chunk)
  assert.equal(unguarded.filter(chunk => chunk.type === 'text-delta').length, 8)
  assert.equal(closed, 2)
})
