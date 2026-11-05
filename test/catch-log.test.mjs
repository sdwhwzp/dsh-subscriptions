import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearIgnoredErrors, getIgnoredErrors, ignoreError, setCatchLogger } from '../lib/catch-log.js'

test('clearing ignored diagnostics removes retained entries and allows fresh reports', t => {
  t.after(() => { clearIgnoredErrors(); setCatchLogger(null) })
  clearIgnoredErrors()
  ignoreError('fixture', new Error('unavailable'))
  assert.equal(getIgnoredErrors()[0].message, 'unavailable')
  clearIgnoredErrors()
  assert.deepEqual(getIgnoredErrors(), [])
  ignoreError('recovered', new Error('fresh'))
  assert.deepEqual(getIgnoredErrors().map(entry => entry.label), ['recovered'])
})
