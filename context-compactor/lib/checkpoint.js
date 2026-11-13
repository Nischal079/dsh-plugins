/** Checkpoint construction, schema validation, and size budgeting. */
import { STATE_KEYS, CHECKPOINT_CLOSE, CHECKPOINT_OPEN } from './state.js'
import { clampText, estimateTokens, sha1, stableStringify } from './util.js'

/**
 * Assert the exact eleven-field schema.
 * @param {Record<string, any>} state
 */
export function assertState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('ContextCompactor: checkpoint state must be an object')
  }
  const keys = Object.keys(state)
  for (const key of STATE_KEYS) {
    if (!(key in state)) throw new Error(`ContextCompactor: checkpoint is missing "${key}"`)
  }
  for (const key of keys) {
    if (!STATE_KEYS.includes(key)) throw new Error(`ContextCompactor: checkpoint has unknown field "${key}"`)
  }
  if (typeof state.task_goal !== 'string' || typeof state.current_status !== 'string') {
    throw new Error('ContextCompactor: task_goal and current_status must be strings')
  }
  if (typeof state.resume_instructions !== 'string') {
    throw new Error('ContextCompactor: resume_instructions must be a string')
  }
  if (typeof state.carried_summary !== 'string') {
    throw new Error('ContextCompactor: carried_summary must be a string')
  }
  for (const key of STATE_KEYS) {
    if (key === 'task_goal' || key === 'current_status' || key === 'resume_instructions' || key === 'carried_summary') continue
    if (!Array.isArray(state[key])) throw new Error(`ContextCompactor: checkpoint "${key}" must be an array`)
    for (const item of state[key]) {
      if (typeof item !== 'string') throw new Error(`ContextCompactor: checkpoint "${key}" entries must be strings`)
    }
  }
}

/** @param {Record<string, any>} state @returns {number} */
export function checkpointTokens(state) {
  return estimateTokens(stableStringify(state))
}

/**
 * Shrink a checkpoint to its token budget with a fixed, deterministic ladder.
 * The ladder always keeps the schema; it only shortens and trims arrays.
 * @param {Record<string, any>} state
 * @param {number} budgetTokens
 * @returns {{ state: Record<string, any>, tokens: number, pruned: boolean }}
 */
export function fitToBudget(state, budgetTokens) {
  let working = cloneState(state)
  const steps = [
    (next) => {
      next.completed_work = next.completed_work.slice(-10)
      next.relevant_files = next.relevant_files.slice(-14)
      next.important_memories = next.important_memories.slice(0, 6)
    },
    (next) => trimStrings(next, 200),
    (next) => {
      next.completed_work = next.completed_work.slice(-6)
      next.relevant_files = next.relevant_files.slice(-8)
      next.important_decisions = next.important_decisions.slice(-5)
      next.known_constraints = next.known_constraints.slice(-5)
      next.pending_work = next.pending_work.slice(0, 6)
      next.next_actions = next.next_actions.slice(0, 4)
    },
    (next) => trimStrings(next, 120),
    (next) => {
      next.important_memories = []
      next.completed_work = next.completed_work.slice(-4)
      next.relevant_files = next.relevant_files.slice(-6)
      next.important_decisions = next.important_decisions.slice(-3)
    },
  ]

  let pruned = false
  for (const step of steps) {
    if (checkpointTokens(working) <= budgetTokens) break
    step(working)
    pruned = true
  }
  working = cloneState(working)
  return { state: working, tokens: checkpointTokens(working), pruned }
}

/**
 * Validate, budget, and fingerprint one checkpoint.
 * @param {Record<string, any>} rawState
 * @param {{ budget?: number }} [options]
 * @returns {{ state: Record<string, any>, tokens: number, pruned: boolean, hash: string, overBudget: boolean }}
 */
export function buildCheckpoint(rawState, options = {}) {
  assertState(rawState)
  const budget = options.budget ?? 900
  const fitted = fitToBudget(rawState, budget)
  const hash = sha1(stableStringify(fitted.state)).slice(0, 16)
  return {
    state: fitted.state,
    tokens: fitted.tokens,
    pruned: fitted.pruned,
    hash,
    overBudget: fitted.tokens > budget,
  }
}

/**
 * Render the model-facing checkpoint message. The preamble is fixed so
 * repeated runs on the same surface produce identical text.
 * @param {Record<string, any>} state
 * @param {{ resume?: boolean, reset?: boolean }} [options]
 * @returns {string}
 */
export function frameCheckpoint(state, options = {}) {
  let preamble
  if (options.reset) {
    preamble =
      'ContextCompactor reset this session: every earlier message was removed and only this deterministic checkpoint remains. Treat it as the authoritative task state, do not restate it, and continue from next_actions.'
  } else if (options.resume) {
    preamble =
      'ContextCompactor restored the latest checkpoint before this task continued. This is the authoritative machine-readable task state; resume from next_actions and do not ask the user to restate it.'
  } else {
    preamble =
      'ContextCompactor replaced earlier conversation with this deterministic task state. Treat it as established ground truth and continue from next_actions without restating or acknowledging it.'
  }
  return `[${preamble}]\n\n${CHECKPOINT_OPEN}\n${JSON.stringify(state)}\n${CHECKPOINT_CLOSE}`
}

/** @param {Record<string, any>} state @returns {Record<string, any>} */
function cloneState(state) {
  const next = {}
  for (const key of STATE_KEYS) {
    const value = state[key]
    next[key] = Array.isArray(value) ? [...value] : value
  }
  return next
}

/** @param {Record<string, any>} state @param {number} max @returns {void} */
function trimStrings(state, max) {
  for (const key of STATE_KEYS) {
    if (!Array.isArray(state[key])) {
      state[key] = clampText(state[key], Math.max(max, 240))
      continue
    }
    state[key] = state[key].map((item) => clampText(item, max))
  }
}
