import { ignoreError } from './catch-log.js'
import { inspectAccountCapabilities, normalizeCapabilitiesRequest } from './capabilities.js'
import { defaultConcurrencyQueue } from './concurrency-queue.js'
import { recordSessionCacheUsage } from './session-pin.js'
import { pickAccountWithTrace, markCooldown, isSwitchableError, isRegionError, isAuthError, modelFamily, earliestRecovery } from './rotate.js'
import { putInQuarantine, REASON_RATE_LIMIT, REASON_HARD_LIMIT, REASON_REVOKED, REASON_DEGRADED } from './quarantine.js'
import { notifySessionExpired, notifyQuarantineEntered } from './alerts.js'
import { withRunawayGuard } from './runaway-guard.js'
import { defaultErrorBuffer } from './error-buffer.js'
import { withSoftFailureSentinel } from './sentinel.js'
import { resolveAccurateReset, nextCooldownMs } from './reset-clock.js'
import { sanitizeSecrets } from './secret-scan.js'
import { leaseStoreFor } from './account-lease.js'
import { getSessionPreset } from './preset-session.js'
import { mergePresetRules } from './routing-presets.js'
import { filterBySchedule, normalizeScheduleRule } from './schedule-rules.js'
import { classifyTransportFailure, transportError } from './transport-errors.js'

// #966: one bare 401 is not proof of revocation; require evidence or two
// consecutive auth failures within five minutes across stream attempts.
const authFailureStreak = new Map()

// #1096: a bounded retry absorbs a single dropped packet before we conclude the
// network path is down. The account is never cooled down for either outcome.
const MAX_TRANSPORT_RETRIES = 2

export function resetAuthFailureStreaks() {
  authFailureStreak.clear()
}

export async function* streamWithRotation({
  accounts,
  nowMs = () => Date.now(),
  cooldownMs,
  switchAtRemaining,
  streamOnce,
  options,
  onCooldown,
  onDecisionTrace,
  cascadeFallback, // #349: optional cross-vendor cascading fallback generator
  offlineFallback, // #174: optional fallback generator if all accounts exhausted
  webhookUrl,
  fetchImpl = fetch,
  lookupImpl,
  concurrencyQueue = defaultConcurrencyQueue,
}) {
  const pool = (accounts || []).map((account) => ({ ...account }))
  let lastError = null
  const tried = new Set()
  // #1039: refs leased by another process/machine are skipped while a free
  // account exists; if every account is leased we still proceed and say so.
  const leaseStore = leaseStoreFor(options)
  const leaseBlocked = new Set()
  let leaseFallbackRecorded = false
  // #1045/#1046: session preset contributes an account rule; schedule rules
  // scope accounts to their weekly windows before any other filter runs.
  const sessionPreset = getSessionPreset(options && options.sessionId)
  const scheduleRules = options && options.scheduleRules !== undefined
    ? options.scheduleRules
    : (options && options.config && options.config.scheduleRules)
  // #1076: config rules arrive as strings ('09:00'); normalise before filtering,
  // otherwise the comparison yields NaN and the window is silently ignored.
  const normalizedRules = (Array.isArray(scheduleRules) ? scheduleRules : [])
    .map((rule) => normalizeScheduleRule(rule)).filter(Boolean)
  const scheduledPool = filterBySchedule(pool, normalizedRules, nowMs())
  // #966: queue-only failures must not consume the account's one attempt.
  const queueRetried = new Set()

  const decisionTrace = {
    sessionId: options && options.sessionId,
    provider: options && options.provider,
    model: options && options.model,
    attempts: [],
    finalOutcome: null,
    chosenRef: null,
  }

  const syncTrace = (outcome, extra = {}) => {
    decisionTrace.finalOutcome = outcome
    Object.assign(decisionTrace, extra)
    if (options && options._decisionTrace) {
      Object.assign(options._decisionTrace, decisionTrace)
    }
    if (typeof onDecisionTrace === 'function') {
      try { onDecisionTrace(decisionTrace) } catch (err) { ignoreError("stream-rotate.js: ignore trace callback error", err) }
    }
  }

  while (true) {
    const remainingPool = tried.size
      ? scheduledPool.filter((candidate) => !tried.has(candidate.ref || candidate.id))
      : scheduledPool
    const availablePool = leaseBlocked.size
      ? remainingPool.filter((candidate) => !leaseBlocked.has(candidate.ref || candidate.id))
      : remainingPool
    const leaseFallback = remainingPool.length > 0 && availablePool.length === 0
    if (leaseFallback && !leaseFallbackRecorded) {
      leaseFallbackRecorded = true
      decisionTrace.attempts.push({
        attempt: decisionTrace.attempts.length + 1,
        kind: 'lease_all_held',
        reason: 'every account is leased by another instance',
      })
    }
    const pickRes = pickAccountWithTrace(leaseFallback ? remainingPool : availablePool, nowMs(), {
      switchAtRemaining,
      model: options && options.model,
      onlyRef: options && options.onlyRef,
      defaultRef: options && options.defaultRef,
      provider: options && options.provider,
      modelAccountRules: mergePresetRules(sessionPreset, options && options.modelAccountRules),
      promptCacheTtlMs: options && options.promptCacheTtlMs,
      proactiveGuard: options && options.proactiveGuard,
      proactiveMinRemaining: options && options.proactiveMinRemaining,
      family: modelFamily(options && options.provider, options && options.model),
      sessionId: options && options.sessionId,
      tag: options && options.tag,
      vip: options && options.vip,
      autoPacing: options && (options.autoPacing !== undefined ? options.autoPacing : (options.config && options.config.autoPacing)),
      drainBeforeReset: options && (options.drainBeforeReset !== undefined ? options.drainBeforeReset : (options.config && options.config.drainBeforeReset)),
      drainSafetyPercent: options && (options.drainSafetyPercent !== undefined ? options.drainSafetyPercent : (options.config && options.config.drainSafetyPercent)),
      rotationStrategy: options && (options.rotationStrategy !== undefined ? options.rotationStrategy : (options.config && options.config.rotationStrategy)),
    })
    if (!pickRes.account) {
      if (cascadeFallback) {
        // #349 Cascading Cross-Vendor Fallback (#517 trace)
        decisionTrace.attempts.push({
          attempt: decisionTrace.attempts.length + 1,
          kind: 'cascade_fallback',
          reason: 'primary_pool_exhausted',
          lastError: lastError ? (lastError.code || sanitizeSecrets(lastError.message)) : null,
        })
        syncTrace('cascade_fallback')
        yield* cascadeFallback(options, lastError)
        return
      }
      if (offlineFallback) {
        // #174 Local Mock Server Offline Fallback (#517 trace)
        decisionTrace.attempts.push({
          attempt: decisionTrace.attempts.length + 1,
          kind: 'offline_fallback',
          reason: 'all_accounts_exhausted',
          lastError: lastError ? (lastError.code || sanitizeSecrets(lastError.message)) : null,
        })
        syncTrace('offline_fallback')
        yield* offlineFallback(options, lastError)
        return
      }
      syncTrace('exhausted')
      if (lastError) {
        const wait = nextCooldownMs(pool, nowMs())
        if (wait != null && options && options.rateLimitWait !== false) {
          const maxWait = Number(options.rateLimitMaxWaitMs) || 6 * 3600 * 1000
          lastError.retryAfterMs = Math.min(wait, maxWait)
          lastError.resetAt = nowMs() + lastError.retryAfterMs
        }
        lastError.recovery = lastError.recovery || earliestRecovery(pool, nowMs())
        throw lastError
      }
      const err = /** @type {Error & { code?: string, recovery?: any, onlyRef?: string }} */ (new Error('no usable subscription account for this provider'))
      err.code = 'RATE_LIMIT'
      err.recovery = earliestRecovery(pool, nowMs())
      if (options && options.onlyRef) err.onlyRef = options.onlyRef
      throw err
    }

    const accountRef = pickRes.account.ref || pickRes.account.id
    const account = pool.find((candidate) => (candidate.ref || candidate.id) === accountRef)
    const currentAttempt = {
      attempt: decisionTrace.attempts.length + 1,
      ref: accountRef,
      decisionReason: pickRes.trace.decisionReason,
      tier: pickRes.trace.tier,
      selectionMetrics: pickRes.trace.selectionMetrics,
      evaluations: pickRes.trace.evaluations,
      status: 'pending',
    }
    decisionTrace.attempts.push(currentAttempt)
    decisionTrace.chosenRef = accountRef

    const queueKey = accountRef || 'default'
    const queueConfig = {
      signal: options && options.signal,
      timeoutMs: options && (options.queueTimeoutMs !== undefined ? options.queueTimeoutMs : (options.config && options.config.queueTimeoutMs)),
      maxConcurrency: account.maxConcurrency !== undefined
        ? account.maxConcurrency
        : (options && options.accountMaxConcurrency !== undefined
          ? options.accountMaxConcurrency
          : (options && options.config && options.config.accountMaxConcurrency !== undefined
            ? options.config.accountMaxConcurrency
            : 1)),
      maxQueueSize: account.maxQueueSize !== undefined
        ? account.maxQueueSize
        : (options && options.maxQueueSize !== undefined
          ? options.maxQueueSize
          : (options && options.config && options.config.maxQueueSize !== undefined
            ? options.config.maxQueueSize
            : 20)),
      enabled: options && (options.enableQueue !== undefined ? options.enableQueue : (options.config && options.config.enableQueue !== undefined ? options.config.enableQueue : true)),
    }

    let releaseSlot = null
    try {
      releaseSlot = await concurrencyQueue.acquire(queueKey, queueConfig)
    } catch (queueErr) {
      if (options?.signal?.aborted || queueErr?.code === 'ABORT_ERR' || queueErr?.name === 'AbortError') {
        currentAttempt.status = 'aborted'
        currentAttempt.error = sanitizeSecrets(queueErr?.message)
        syncTrace('aborted')
        throw queueErr
      }
      currentAttempt.status = queueErr && queueErr.code === 'QUEUE_OVERFLOW' ? 'queue_overflow' : 'queue_timeout'
      currentAttempt.error = sanitizeSecrets(queueErr?.message || queueErr)
      lastError = queueErr
      if (!queueRetried.has(queueKey)) {
        queueRetried.add(queueKey)
        continue
      }
      tried.add(accountRef)
      continue
    }

    let lease = null
    try {
      if (options?.signal?.aborted) {
        currentAttempt.status = 'aborted'
        syncTrace('aborted')
        throw options.signal.reason
      }
      if (leaseStore && !leaseFallback) {
        const leaseKey = `${options?.provider || account.provider || 'account'}#${queueKey}`
        const claimed = leaseStore.acquire(leaseKey)
        if (!claimed.ok) {
          leaseBlocked.add(accountRef)
          currentAttempt.status = 'lease_held'
          currentAttempt.leaseHolder = claimed.holder
            ? { host: claimed.holder.host, pid: claimed.holder.pid, expiresAt: claimed.holder.expiresAt }
            : null
          continue
        }
        lease = claimed
      }
      tried.add(accountRef)

      let firstChunkDelivered = false
      let regionRetries = 0
      let transportRetries = 0

      while (true) {
      try {
        const runawayState = options && options._runawayState ? options._runawayState : { tripped: false, reason: null }
        const runawayOpts = {
          ...(options && options.runawayGuard),
          onRunaway: (reason) => {
            runawayState.tripped = true
            runawayState.reason = reason
          },
        }
        const accountCaps = account.capabilities || inspectAccountCapabilities(account.provider || options?.provider, account, account)
        const adaptedOptions = normalizeCapabilitiesRequest(options, accountCaps)
        const guardedStream = withRunawayGuard(
          streamOnce(account, { ...adaptedOptions, _runawayState: runawayState }),
          runawayOpts
        )
        const sentineledStream = withSoftFailureSentinel(guardedStream, {
          enabled: (options?.enableSoftFailureSentinel !== false) && (options?.config?.enableSoftFailureSentinel !== false),
        })
        for await (const chunk of sentineledStream) {
          const cachedTokens = Number(
            (chunk && chunk.usage && (chunk.usage.cacheReadTokens || chunk.usage.cachedTokens)) ||
            (chunk && chunk.tokens && (chunk.tokens.cacheRead || chunk.tokens.cached)) ||
            0
          )
          if (cachedTokens > 0 && options && options.sessionId) {
            recordSessionCacheUsage(options.sessionId, cachedTokens)
          }
          firstChunkDelivered = true
          yield chunk
        }
        currentAttempt.status = 'success'
        authFailureStreak.delete(account.ref || account.id)
        syncTrace('success', { chosenRef: account.ref || account.id })
        return
      } catch (err) {
        if (options?.signal?.aborted) {
          currentAttempt.status = 'aborted'
          syncTrace('aborted')
          throw err
        }
        lastError = err
        const safeMessage = sanitizeSecrets(err?.message || err)
        defaultErrorBuffer.record({
          provider: options && options.provider,
          ref: account.ref || account.id,
          model: options && options.model,
          status: err && (err.status || err.statusCode),
          code: err && (err.code || err.name),
          message: safeMessage,
        })
        const transport = classifyTransportFailure(err)
        if (firstChunkDelivered) {
          currentAttempt.status = 'stream_error'
          currentAttempt.error = safeMessage || 'stream ended with an error'
          if (transport.transport) currentAttempt.transportCode = transport.code
          syncTrace('stream_error', { chosenRef: account.ref || account.id })
          if (!transport.transport) {
            const cooledMid = markCooldown(account, nowMs(), Math.min(cooldownMs, 5 * 60 * 1000), modelFamily(options && options.provider, options && options.model), null, options && options.model)
            account.cooldownUntil = cooledMid.cooldownUntil
            if (cooledMid.cooldownFamilies) account.cooldownFamilies = cooledMid.cooldownFamilies
            if (cooledMid.cooldownModels) account.cooldownModels = cooledMid.cooldownModels
            if (typeof onCooldown === 'function') {
              try { onCooldown(account) } catch (cooldownErr) { ignoreError("stream-rotate.js: mid-stream cooldown persist", cooldownErr) }
            }
          }
          throw err
        }

        // Transient region 400 error: retry same account up to 2 times before rotating (#391 / GH #9)
        if (isRegionError(err) && regionRetries < 2 && (!options || !options.signal || !options.signal.aborted)) {
          regionRetries++
          currentAttempt.regionRetries = regionRetries
          await new Promise((r) => setTimeout(r, 400 * regionRetries))
          if (options && options.signal && options.signal.aborted) throw err
          continue
        }

        // #1096: a transport failure says nothing about the account. One
        // connect-timeout used to park a healthy account for the full cooldown and
        // quarantine window, and the user was told "no usable subscription
        // account". Retry briefly on the same account, then move on without
        // spending this account's quota window.
        if (transport.transport) {
          if (transportRetries < MAX_TRANSPORT_RETRIES && (!options || !options.signal || !options.signal.aborted)) {
            transportRetries += 1
            currentAttempt.transportRetries = transportRetries
            currentAttempt.transportCode = transport.code
            await new Promise((r) => setTimeout(r, 300 * transportRetries))
            if (options && options.signal && options.signal.aborted) throw err
            continue
          }
          currentAttempt.status = 'transport_error'
          currentAttempt.transportCode = transport.code
          currentAttempt.error = safeMessage || 'transport failure'
          syncTrace('transport_error', { chosenRef: account.ref || account.id })
          // Deliberately no markCooldown and no quarantine: the account may be
          // perfectly healthy on a working network path.
          throw transportError(err)
        }

        // #1078: an outdated-client notice must fail immediately instead of
        // rotating through every account of the same vendor.
        if ((err && err.code === 'CLIENT_OUTDATED') || (!isSwitchableError(err) && !isAuthError(err))) {
          currentAttempt.status = 'fatal_error'
          currentAttempt.error = safeMessage || 'unknown'
          syncTrace('fatal_error')
          throw err
        }

        currentAttempt.status = 'switched'
        currentAttempt.switchError = err?.code || err?.status || safeMessage || 'switchable'

        const accurateUntil = resolveAccurateReset(err, account, options && options.provider, nowMs())
        const isSoft = Boolean(err && (err.code === 'SOFT_FAILURE' || err.isSoftFailure))
        const isAuth = isAuthError(err)
        const status = Number(err && (err.status || err.statusCode) || 0)
        const code = String(err && err.code || '')
        const refKey = account.ref || account.id
        let revoked = false
        if (isAuth) {
          const nowAuth = nowMs()
          const prev = authFailureStreak.get(refKey)
          const count = prev && nowAuth - prev.at < 5 * 60 * 1000 ? prev.count + 1 : 1
          authFailureStreak.set(refKey, { count, at: nowAuth })
          const evidence = /invalid_grant|revoked|token_revoked|unauthorized_client/i
            .test(code + ' ' + String(err && err.message || ''))
          revoked = evidence || count >= 2
        } else {
          authFailureStreak.delete(refKey)
        }

        // Move slot to cooldown and quarantine (#172, #538)
        const effectiveCooldownMs = isSoft
          ? Math.min(cooldownMs, 5 * 60 * 1000)
          : (revoked ? 86400000 : (isAuth ? Math.min(cooldownMs, 5 * 60 * 1000) : cooldownMs))
        const cooled = markCooldown(account, nowMs(), effectiveCooldownMs, modelFamily(options && options.provider, options && options.model), accurateUntil, options && options.model)
        account.cooldownUntil = cooled.cooldownUntil
        if (cooled.cooldownFamilies) account.cooldownFamilies = cooled.cooldownFamilies
        if (cooled.cooldownModels) account.cooldownModels = cooled.cooldownModels

        const reason = isSoft
          ? REASON_DEGRADED
          : revoked
            ? REASON_REVOKED
            : (status === 403 || code === 'HARD_LIMIT' || code === 'LICENSE_REQUIRED')
              ? REASON_HARD_LIMIT
              : isAuth
                ? REASON_DEGRADED
                : REASON_RATE_LIMIT

        account.cooldownReason = reason

        if (err && err.isWarmupProbeFailure && err.warmupAccount) {
          account.quarantineUntil = err.warmupAccount.quarantineUntil
          account.quarantineReason = err.warmupAccount.quarantineReason
          account.quarantineAttempts = err.warmupAccount.quarantineAttempts
          account.status = err.warmupAccount.status
        } else {
          const quarantineMs = revoked ? 86400000 : (isAuth ? 5 * 60 * 1000 : 3600000)
          const quarantined = putInQuarantine(account, reason, nowMs(), accurateUntil || (nowMs() + quarantineMs))
          account.quarantineUntil = quarantined.quarantineUntil
          account.quarantineReason = quarantined.quarantineReason
          account.quarantineAttempts = (account.quarantineAttempts || 0) + 1
        }
        if (revoked || reason === REASON_REVOKED) {
          account.isRevoked = true
        }

        currentAttempt.quarantineReason = account.quarantineReason || reason
        currentAttempt.quarantineUntil = account.quarantineUntil
        if (accurateUntil) {
          currentAttempt.accurateReset = true
          currentAttempt.resetAt = accurateUntil
        }

        try {
          notifyQuarantineEntered({
            ref: account.ref,
            provider: options && options.provider,
            reason: account.quarantineReason || reason,
            until: account.quarantineUntil,
            webhookUrl: webhookUrl || (options && options.webhookUrl),
            fetchImpl,
            nowMs: nowMs(),
            lookupImpl,
          })
        } catch (err) { ignoreError("stream-rotate.js: fire-and-forget alert", err) }

        if (reason === REASON_REVOKED) {
          try {
            notifySessionExpired({
              ref: account.ref,
              provider: options && options.provider,
              message: err && err.message,
              webhookUrl: webhookUrl || (options && options.webhookUrl),
              fetchImpl,
              nowMs: nowMs(),
              lookupImpl,
            })
          } catch (err) { ignoreError("stream-rotate.js: fire-and-forget alert", err) }
        }

        if (onCooldown) onCooldown(account)
        // Break inner retry loop to continue to next account in outer while (true) loop
        break
      }
    }
    } finally {
      if (lease && typeof lease.released === 'function') {
        lease.released()
      }
      if (typeof releaseSlot === 'function') {
        releaseSlot()
      }
    }
  }
}
