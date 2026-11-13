/** Load-time configuration for ContextCompactor. */

/** Every accepted key with its default. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** Fraction of the context window that triggers state compaction. */
  thresholdRatio: 0.9,
  /** Fraction of the window that triggers the emergency handover. */
  handoverRatio: 0.985,
  /** When true, an emergency handover wipes the surface to one checkpoint and continues. */
  fullResetOnHandover: true,
  /** Reset once fewer than this many tokens remain before the hard window edge; 0 disables the guard. */
  handoverReserveTokens: 6144,
  /** Target size of the carried summary of the previous checkpoint. */
  carriedSummaryTokenBudget: 200,
  /** Fraction of surface nodes kept verbatim as recent history. */
  recentTailRatio: 0.12,
  /** Hard floor on verbatim recent history nodes. */
  minRecentMessages: 2,
  /** Never rewrite a range smaller than this many surface nodes. */
  minNodesToCompact: 4,
  /** Target size of the serialized checkpoint state. */
  checkpointTokenBudget: 900,
  /** Report what would happen without touching the session or storage. */
  dryRun: false,
  /** Checkpoint versions retained per session. */
  retentionPolicy: 5,
  /** Pause the turn after every compaction (the strict handover contract). */
  pauseOnCompaction: false,
  /** Inject the latest checkpoint into a resumed session whose log lacks it. */
  resumeOnRestart: true,
  /** Override the checkpoint directory; empty means the profile directory. */
  storageDir: '',
  /** Emit a log line for every pressure reading, useful while tuning. */
  verbose: false,
})

const DEFAULTS_KEYS = new Set(Object.keys(DEFAULTS))

/**
 * Validate, detach, and freeze the row config.
 * @param {Record<string, unknown>} [raw]
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('ContextCompactor: config must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (!DEFAULTS_KEYS.has(key)) {
      throw new Error(`ContextCompactor: unknown config key "${key}" (allowed: ${[...DEFAULTS_KEYS].join(', ')})`)
    }
  }

  const resolved = {
    enabled: booleanOf('enabled', raw.enabled, DEFAULTS.enabled),
    thresholdRatio: ratioOf('thresholdRatio', raw.thresholdRatio, DEFAULTS.thresholdRatio),
    handoverRatio: ratioOf('handoverRatio', raw.handoverRatio, DEFAULTS.handoverRatio),
    fullResetOnHandover: booleanOf('fullResetOnHandover', raw.fullResetOnHandover, DEFAULTS.fullResetOnHandover),
    handoverReserveTokens: nonNegativeIntegerOf('handoverReserveTokens', raw.handoverReserveTokens, DEFAULTS.handoverReserveTokens),
    carriedSummaryTokenBudget: integerOf('carriedSummaryTokenBudget', raw.carriedSummaryTokenBudget, DEFAULTS.carriedSummaryTokenBudget),
    recentTailRatio: ratioOf('recentTailRatio', raw.recentTailRatio, DEFAULTS.recentTailRatio),
    minRecentMessages: integerOf('minRecentMessages', raw.minRecentMessages, DEFAULTS.minRecentMessages),
    minNodesToCompact: integerOf('minNodesToCompact', raw.minNodesToCompact, DEFAULTS.minNodesToCompact),
    checkpointTokenBudget: integerOf('checkpointTokenBudget', raw.checkpointTokenBudget, DEFAULTS.checkpointTokenBudget),
    dryRun: booleanOf('dryRun', raw.dryRun, DEFAULTS.dryRun),
    retentionPolicy: integerOf('retentionPolicy', raw.retentionPolicy, DEFAULTS.retentionPolicy),
    pauseOnCompaction: booleanOf('pauseOnCompaction', raw.pauseOnCompaction, DEFAULTS.pauseOnCompaction),
    resumeOnRestart: booleanOf('resumeOnRestart', raw.resumeOnRestart, DEFAULTS.resumeOnRestart),
    storageDir: stringOf('storageDir', raw.storageDir, DEFAULTS.storageDir),
    verbose: booleanOf('verbose', raw.verbose, DEFAULTS.verbose),
  }

  if (resolved.handoverRatio < resolved.thresholdRatio) {
    throw new Error('ContextCompactor: handoverRatio must be at least thresholdRatio')
  }
  if (resolved.minRecentMessages < 1) throw new Error('ContextCompactor: minRecentMessages must be >= 1')
  if (resolved.minNodesToCompact < 1) throw new Error('ContextCompactor: minNodesToCompact must be >= 1')
  if (resolved.checkpointTokenBudget < 200) {
    throw new Error('ContextCompactor: checkpointTokenBudget must be >= 200')
  }
  if (resolved.carriedSummaryTokenBudget < 50) {
    throw new Error('ContextCompactor: carriedSummaryTokenBudget must be >= 50')
  }
  if (resolved.retentionPolicy < 1) throw new Error('ContextCompactor: retentionPolicy must be >= 1')

  return Object.freeze(resolved)
}

function booleanOf(name, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`ContextCompactor: ${name} must be a boolean`)
  return value
}

function ratioOf(name, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`ContextCompactor: ${name} must be a number in (0, 1]`)
  }
  return value
}

function integerOf(name, value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`ContextCompactor: ${name} must be a positive integer`)
  }
  return value
}

function nonNegativeIntegerOf(name, value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ContextCompactor: ${name} must be a non-negative integer`)
  }
  return value
}

function stringOf(name, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`ContextCompactor: ${name} must be a string`)
  return value
}
