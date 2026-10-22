import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

test('client.js parses without syntax errors', () => {
  execFileSync(process.execPath, ['--check', clientPath], { stdio: 'pipe' })
})

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('client factory uses CommonJS shim and scoped id', () => {
  assert.match(src, /var module = \{ exports: \{\} \}/)
  assert.match(src, /var exports = module.exports/)
  assert.match(src, /return module.exports/)
  assert.match(src, /id: '@goodandready\/dsh-subscriptions'/)
  assert.match(src, /\/dsh-subscriptions\/oauth/)
})

test('registers the native settings section with legacy plugin seats as fallback', () => {
  assert.match(src, /name: 'settings\.section'/)
  assert.match(src, /id: ROW_ID/)
  assert.match(src, /function SubsSettingsPage/)
  assert.match(src, /if \(!hasSection\) registerLegacySeats\(\)/)
  assert.match(src, /name: 'plugins\.row\.config'/)
})

test('exposes schema controls in SubsSection', () => {
  assert.match(src, /autoLoopback/)
  assert.match(src, /hideDeprecatedModels/)
  assert.match(src, /composerQuota/)
  assert.match(src, /expiryNotifyDays/)
  assert.match(src, /codexFastMode/)
  assert.match(src, /codexVerbosity/)
  assert.match(src, /ollamaFallback/)
  assert.match(src, /ollamaBaseUrl/)
  assert.match(src, /ollamaFallbackModel/)
  assert.match(src, /cooldownMs/)
  assert.match(src, /probeIntervalMin/)
  assert.match(src, /notifyLimits/)
})

test('client includes clinebot-style status badges, telemetry cards and smoke ping', () => {
  assert.match(src, /dsub-header-bar/)
  assert.match(src, /dsub-badge/)
  assert.match(src, /dsub-stat-box/)
  assert.match(src, /runSmokeTest/)
  assert.match(src, /reloadTelemetry/)
})
