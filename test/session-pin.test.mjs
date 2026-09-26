import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinSession, getPinnedAccountRef, pruneSessionPins } from '../lib/session-pin.js'

const clearSessionPins = () => pruneSessionPins(Infinity)

// #288 follow-up: session-pin had 34% coverage. Pin lifecycle matters
// for account stickiness during a conversation.

test('pin then read returns the bound account', () => {
  clearSessionPins()
  pinSession('s1', 'REF_A')
  assert.equal(getPinnedAccountRef('s1'), 'REF_A')
})

test('unknown and empty session ids return null', () => {
  clearSessionPins()
  assert.equal(getPinnedAccountRef('missing'), null)
  assert.equal(getPinnedAccountRef(''), null)
  assert.equal(getPinnedAccountRef(undefined), null)
  assert.equal(getPinnedAccountRef(null), null)
})

test('pinning without session or account is a no-op', () => {
  clearSessionPins()
  pinSession('', 'REF_A')
  pinSession('s2', '')
  pinSession(undefined, undefined)
  assert.equal(getPinnedAccountRef('s2'), null)
  assert.equal(getPinnedAccountRef(''), null)
})

test('expired pins are dropped on read', () => {
  clearSessionPins()
  pinSession('s3', 'REF_B', -1)
  assert.equal(getPinnedAccountRef('s3'), null)
  // and the entry is gone for good
  assert.equal(getPinnedAccountRef('s3'), null)
})

test('a later pin replaces the earlier one', () => {
  clearSessionPins()
  pinSession('s4', 'REF_OLD')
  pinSession('s4', 'REF_NEW')
  assert.equal(getPinnedAccountRef('s4'), 'REF_NEW')
})

test('pruning drops expired pins while retaining live bindings', () => {
  clearSessionPins()
  pinSession('expired', 'REF_OLD', -1)
  pinSession('live', 'REF_LIVE', Number.MAX_SAFE_INTEGER)
  pruneSessionPins(Date.now())
  assert.equal(getPinnedAccountRef('expired'), null)
  assert.equal(getPinnedAccountRef('live'), 'REF_LIVE')
  clearSessionPins()
})
