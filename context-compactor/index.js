/**
 * ContextCompactor — deterministic, state-based context compaction for DSH.
 *
 * At a configurable share of the context window this plugin replaces the
 * oldest balanced span of the session surface with a machine-readable task
 * checkpoint. The replacement is an ordinary surface `user/message`, so it
 * survives restart, resume, and model switches exactly like model history.
 *
 * @module @local/context-compactor
 */
import { resolveConfig } from './lib/config.js'
import { CheckpointStore, defaultStorageDir } from './lib/store.js'
import { extractState, isCheckpointText, readSurface } from './lib/state.js'
import { buildCheckpoint, frameCheckpoint } from './lib/checkpoint.js'
import { applyReplacement, planRange, planResetRange } from './lib/compact.js'
import { recordPressure, writeStatus } from './lib/status.js'
import { estimateTokens } from './lib/util.js'

/** Services this plugin cannot work without. */
export const inject = ['sessions', 'tokenMeter']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})
  const log = createLog(ctx)
  if (!config.enabled) {
    log.info('disabled by configuration')
    return
  }

  const storageDir = defaultStorageDir(config.storageDir)
  const store = new CheckpointStore(storageDir)
  const engine = createEngine({ ctx, config, store, log })

  writeStatus(storageDir, {
    pluginVersion: '1.1.0',
    activatedAt: Date.now(),
    pid: process.pid,
    storageDir,
    config,
  })

  ctx.on('agent/pre-step', engine.onPreStep)
  ctx.on('agent/created', engine.onAgentCreated)

  log.info(`ready (threshold=${config.thresholdRatio}, budget=${config.checkpointTokenBudget} tokens, dryRun=${config.dryRun}, storage=${storageDir})`)
}

/**
 * @param {{ ctx: any, config: ReturnType<typeof resolveConfig>, store: CheckpointStore, log: ReturnType<typeof createLog> }} deps
 */
function createEngine({ ctx, config, store, log }) {
  /** Session ids whose current turn already compacted (one compaction per turn). */
  const compactedTurns = new Map()
  /** Session ids whose current turn was already rejected for handover. */
  const rejectedTurns = new Map()
  /** Session ids owed a full reset at the next safe turn boundary. */
  const pendingReset = new Map()

  return { onPreStep, onAgentCreated }

  /**
   * Waterfall listener: measure pressure, compact when due, and never throw
   * into the agent loop.
   * @param {{ agent: any, messages: any[], turn: number, step: number, signal: AbortSignal }} payload
   * @param {() => Promise<any>} next
   */
  async function onPreStep(payload, next) {
    try {
      const decision = await beforeStep(payload)
      if (decision?.reject) {
        log.info(`handover: pausing turn ${payload.turn} for session ${payload.agent?.id}`)
        return { kind: 'reject' }
      }
    } catch (error) {
      // Rollback contract: a failed compaction leaves the surface untouched and
      // the turn proceeds exactly as it would without this plugin.
      log.error(`compaction failed, continuing with the original history: ${describeError(error)}`)
    }
    return next()
  }

  /**
   * @param {{ agent: any, turn: number }} payload
   * @returns {Promise<{ reject?: boolean } | null>}
   */
  async function beforeStep({ agent, turn, step }) {
    if (!agent?.id) return null
    const session = ctx.sessions.get(agent.id)
    if (!session) return null

    const pressure = readPressure(session)
    if (!pressure) return null

    const ratio = pressure.pressureTokens / pressure.contextWindow
    recordPressure(store.root, agent.id, pressure, config.thresholdRatio)
    if (config.verbose) {
      log.info(`pressure ${(ratio * 100).toFixed(1)}% (${pressure.pressureTokens}/${pressure.contextWindow}) session=${agent.id}`)
    }

    const remaining = pressure.contextWindow - pressure.pressureTokens
    const emergency =
      ratio >= config.handoverRatio ||
      (config.handoverReserveTokens > 0 && remaining <= config.handoverReserveTokens)
    const owedReset = pendingReset.get(agent.id) === true

    if (config.fullResetOnHandover && (emergency || owedReset)) {
      if (step !== 1) {
        // Mid-turn the current tool exchange is still needed, so the full
        // reset waits for the next turn boundary instead of pausing the turn.
        pendingReset.set(agent.id, true)
      } else {
        const cause = emergency ? 'handover' : 'deferred'
        const reset = tryFullReset({ session, agent, turn, ratio, pressure, cause })
        if (reset) return null
        log.info(
          `full reset could not be planned at ${(ratio * 100).toFixed(1)}% (session=${agent.id}); falling back to range compaction`,
        )
      }
    }

    if (ratio < config.thresholdRatio) return null
    if (compactedTurns.get(agent.id) === turn) return null
    if (rejectedTurns.get(agent.id) === turn) return null

    const plan = planRange(session, config)
    if (!plan) {
      log.info(`pressure ${(ratio * 100).toFixed(1)}% but no balanced range can be compacted (session=${agent.id})`)
      return null
    }

    const state = extractState(session, { carriedSummaryTokens: config.carriedSummaryTokenBudget })
    const built = buildCheckpoint(state, { budget: config.checkpointTokenBudget })
    const text = frameCheckpoint(built.state)

    const beforeTokens = measureTotal(session) ?? pressure.pressureTokens
    const shadowedTokens = measureShadowed(session, plan)
    const projectedTokens = Math.max(0, beforeTokens - shadowedTokens + estimateTokens(text))
    const started = Date.now()

    if (config.dryRun) {
      log.info(
        `dry-run: would replace ${plan.nodeCount} nodes (~${shadowedTokens} tokens) with a ${built.tokens}-token checkpoint ` +
          `(${beforeTokens} -> ${projectedTokens} tokens, ratio ${ratio.toFixed(3)}, session=${agent.id})`,
      )
      return null
    }

    const replacement = applyReplacement(session, plan, text)
    const afterTokens = measureTotal(session) ?? projectedTokens

    const checkpointEntry = {
      reason: ratio >= config.handoverRatio ? 'handover' : 'pressure',
      hash: built.hash,
      tokens: built.tokens,
      pruned: built.pruned,
      overBudget: built.overBudget,
      state: built.state,
      source: {
        startSeq: plan.startSeq,
        endSeq: plan.endSeq,
        nodeCount: plan.nodeCount,
        replacementSeq: replacement?.seq ?? null,
        pressureRatio: round(ratio, 4),
        pressureTokens: pressure.pressureTokens,
        contextWindow: pressure.contextWindow,
      },
    }

    const persisted = store.record(agent.id, checkpointEntry, { retention: config.retentionPolicy })
    if (!persisted.persisted) {
      // The surface replacement is durable in the session log; only the plugin
      // copy failed. Resume still works from history, so this is a warning.
      log.warn(`checkpoint persisted to the session log but not to plugin storage: ${persisted.error}`)
    }

    const metrics = {
      sessionId: String(agent.id),
      turn,
      trigger: checkpointEntry.reason,
      dryRun: false,
      tokensBefore: beforeTokens,
      tokensAfter: afterTokens,
      shadowedTokens,
      checkpointTokens: built.tokens,
      compressionRatio: beforeTokens > 0 ? round(afterTokens / beforeTokens, 4) : null,
      savedRatio: beforeTokens > 0 ? round(1 - afterTokens / beforeTokens, 4) : null,
      nodeCount: plan.nodeCount,
      checkpointVersion: persisted.version,
      checkpointHash: built.hash,
      pruned: built.pruned,
      overBudget: built.overBudget,
      persisted: persisted.persisted,
      durationMs: Date.now() - started,
    }
    store.recordMetrics(agent.id, metrics)
    emitMetrics(metrics)
    writeStatus(store.root, { lastMetrics: metrics, lastCheckpoint: { version: persisted.version, hash: built.hash } })

    log.info(
      `compacted ${plan.nodeCount} nodes: ${beforeTokens} -> ${afterTokens} tokens ` +
        `(${(metrics.savedRatio * 100).toFixed(1)}% smaller), checkpoint v${persisted.version} ` +
        `${built.tokens} tokens, session=${agent.id}`,
    )

    compactedTurns.set(agent.id, turn)

    const handover = config.pauseOnCompaction || (!config.fullResetOnHandover && ratio >= config.handoverRatio)
    if (handover) {
      rejectedTurns.set(agent.id, turn)
      return { reject: true }
    }
    return null
  }

  /**
   * Emergency handover: replace the entire model-visible history with one
   * checkpoint and let the current step continue in the same session.
   *
   * Runs only at a turn boundary (`step === 1`), where no tool call is in
   * flight, so the replacement cannot split a call/result pair. On any failure
   * the surface is left untouched and the caller falls back to range
   * compaction, so the turn always continues.
   *
   * @param {{ session: any, agent: any, turn: number, ratio: number, pressure: any, cause: string }} input
   * @returns {boolean} whether the reset landed (or a dry run reported it)
   */
  function tryFullReset({ session, agent, turn, ratio, pressure, cause }) {
    let plan
    try {
      plan = planResetRange(session, config)
    } catch (error) {
      log.warn(`full reset range planning failed: ${describeError(error)}`)
      return false
    }
    if (!plan) return false

    const state = extractState(session, { carriedSummaryTokens: config.carriedSummaryTokenBudget })
    const built = buildCheckpoint(state, { budget: config.checkpointTokenBudget })
    const text = frameCheckpoint(built.state, { reset: true })

    const beforeTokens = measureTotal(session) ?? pressure.pressureTokens
    const shadowedTokens = measureShadowed(session, plan)
    const projectedTokens = Math.max(0, beforeTokens - shadowedTokens + estimateTokens(text))
    const started = Date.now()

    if (config.dryRun) {
      log.info(
        `dry-run reset: would replace ${plan.nodeCount} nodes (~${shadowedTokens} tokens) with a ${built.tokens}-token checkpoint ` +
          `(${beforeTokens} -> ${projectedTokens} tokens, ratio ${ratio.toFixed(3)}, cause=${cause}, session=${agent.id})`,
      )
      return true
    }

    const replacement = applyReplacement(session, plan, text)
    const afterTokens = measureTotal(session) ?? projectedTokens

    const checkpointEntry = {
      reason: 'reset',
      hash: built.hash,
      tokens: built.tokens,
      pruned: built.pruned,
      overBudget: built.overBudget,
      state: built.state,
      source: {
        startSeq: plan.startSeq,
        endSeq: plan.endSeq,
        nodeCount: plan.nodeCount,
        replacementSeq: replacement?.seq ?? null,
        pressureRatio: round(ratio, 4),
        pressureTokens: pressure.pressureTokens,
        contextWindow: pressure.contextWindow,
        cause,
      },
    }

    const persisted = store.record(agent.id, checkpointEntry, { retention: config.retentionPolicy })
    if (!persisted.persisted) {
      log.warn(`reset checkpoint persisted to the session log but not to plugin storage: ${persisted.error}`)
    }

    const metrics = {
      sessionId: String(agent.id),
      turn,
      trigger: 'reset',
      cause,
      fullReset: true,
      dryRun: false,
      tokensBefore: beforeTokens,
      tokensAfter: afterTokens,
      shadowedTokens,
      checkpointTokens: built.tokens,
      carriedSummaryChars: built.state.carried_summary.length,
      compressionRatio: beforeTokens > 0 ? round(afterTokens / beforeTokens, 4) : null,
      savedRatio: beforeTokens > 0 ? round(1 - afterTokens / beforeTokens, 4) : null,
      nodeCount: plan.nodeCount,
      checkpointVersion: persisted.version,
      checkpointHash: built.hash,
      pruned: built.pruned,
      overBudget: built.overBudget,
      persisted: persisted.persisted,
      durationMs: Date.now() - started,
    }
    store.recordMetrics(agent.id, metrics)
    emitMetrics(metrics)
    writeStatus(store.root, { lastMetrics: metrics, lastReset: { version: persisted.version, hash: built.hash } })

    log.info(
      `full reset ${plan.nodeCount} nodes: ${beforeTokens} -> ${afterTokens} tokens, checkpoint v${persisted.version} ` +
        `${built.tokens} tokens (cause=${cause}, session=${agent.id}); continuing the same step`,
    )

    compactedTurns.set(agent.id, turn)
    pendingReset.delete(agent.id)
    return true
  }

  /**
   * Restore the latest checkpoint into a resumed session whose log no longer
   * carries it (for example after the surface was rebuilt from an older log).
   * @param {{ agent: any }} payload
   */
  function onAgentCreated({ agent }) {
    try {
      if (!config.resumeOnRestart || !agent?.id) return
      const latest = store.latest(agent.id)
      if (!latest?.state) return

      const session = ctx.sessions.get(agent.id)
      if (session) {
        const hasCheckpoint = readSurface(session).some(
          (entry) => entry.role === 'user' && isCheckpointText(entry.text),
        )
        if (hasCheckpoint) return
      }

      if (typeof agent.inject !== 'function') return
      const text = frameCheckpoint(latest.state, { resume: true })
      agent.inject({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      log.info(`restored checkpoint v${latest.version ?? '?'} into session ${agent.id}`)
    } catch (error) {
      log.warn(`could not restore checkpoint: ${describeError(error)}`)
    }
  }

  /** @param {any} session */
  function readPressure(session) {
    try {
      const pressure = ctx.tokenMeter.contextPressure(session)
      if (!pressure || !pressure.pressureTokens || !pressure.contextWindow) return null
      if (!Number.isFinite(pressure.pressureTokens) || !Number.isFinite(pressure.contextWindow)) return null
      if (pressure.contextWindow <= 0) return null
      return pressure
    } catch {
      return null
    }
  }

  /** @param {any} session @returns {number | null} */
  function measureTotal(session) {
    try {
      const measurement = ctx.tokenMeter.measure(session)
      return Number.isFinite(measurement?.totalTokens) ? measurement.totalTokens : null
    } catch {
      return null
    }
  }

  /** @param {any} session @param {ReturnType<typeof planRange>} plan @returns {number} */
  function measureShadowed(session, plan) {
    if (!plan) return 0
    const shadowed = new Set(plan.shadowedSeqs)
    let total = 0
    for (const entry of readSurface(session)) {
      if (!shadowed.has(entry.seq)) continue
      try {
        total += ctx.tokenMeter.estimateMessage(entry.message)
      } catch {
        total += estimateTokens(entry.text)
      }
    }
    return Math.max(0, total)
  }

  /** @param {any} metrics */
  function emitMetrics(metrics) {
    try {
      ctx.emit('context-compactor/metrics', metrics)
    } catch {
      /* No listeners is the normal case. */
    }
  }
}

/** @param {any} ctx */
function createLog(ctx) {
  const write = (level, message) => {
    try {
      const logger = ctx?.logger
      if (logger && typeof logger[level] === 'function') {
        logger[level](`[context-compactor] ${message}`)
        return
      }
      // eslint-disable-next-line no-console
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[context-compactor] ${message}`)
    } catch {
      /* Logging must never break the agent loop. */
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/** @param {number} value @param {number} digits @returns {number} */
function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** @param {unknown} error @returns {string} */
function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
