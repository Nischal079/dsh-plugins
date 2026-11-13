/** Surface range planning and the single atomic replacement append. */
import { resolveConfig } from './config.js'
import { isCheckpointText, textOf } from './state.js'

/** A replacement may start on one of these node types without splitting a unit. */
const BALANCED_START_TYPES = new Set(['user/message', 'developer/message', 'system/message'])

/**
 * Pick the oldest balanced surface span to replace, leaving the recent tail
 * verbatim. The span always ends immediately before a `user/message` so an
 * assistant tool call can never be separated from its results.
 * @param {{ surface: { nodes: readonly number[] }, eventAt: (seq: number) => any }} session
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {{ startSeq: number, endSeq: number, shadowedSeqs: number[], nodeCount: number, startIndex: number, endIndex: number } | null}
 */
export function planRange(session, config) {
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  if (nodes.length < config.minNodesToCompact + 1) return null

  const entries = []
  for (const seq of nodes) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return null
    }
    if (!event) return null
    entries.push({ seq, type: event.type })
  }

  // Node 0 is the rendered system prompt and is protected by the surface fold.
  let start = entries[0]?.type === 'system/message' ? 1 : 0
  while (entries[start] && entries[start].type === 'system/message') start += 1

  const keep = Math.max(config.minRecentMessages, Math.ceil(entries.length * config.recentTailRatio))
  let cut = Math.max(start + 1, entries.length - keep)
  while (cut < entries.length && entries[cut].type !== 'user/message') cut += 1

  while (start < cut && !BALANCED_START_TYPES.has(entries[start].type)) start += 1
  if (start >= cut) return null

  const range = entries.slice(start, cut)
  if (range.length < config.minNodesToCompact) return null

  return {
    startSeq: range[0].seq,
    endSeq: range[range.length - 1].seq,
    shadowedSeqs: range.map((entry) => entry.seq),
    nodeCount: range.length,
    startIndex: start,
    endIndex: cut - 1,
  }
}

/**
 * Plan a full-surface reset: every node except the protected leading system
 * prompt is shadowed by one checkpoint message.
 *
 * This is the emergency-handover range. It is only safe at a turn boundary
 * (the caller runs it at step 1), where no tool call is in flight, so tool
 * pairs cannot be split.
 *
 * @param {{ surface: { nodes: readonly number[] }, eventAt: (seq: number) => any }} session
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {{ startSeq: number, endSeq: number, shadowedSeqs: number[], nodeCount: number, startIndex: number, endIndex: number } | null}
 */
export function planResetRange(session, config) {
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  const entries = []
  for (const seq of nodes) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return null
    }
    if (!event) return null
    entries.push({ seq, type: event.type })
  }
  if (entries.length === 0) return null

  // Node 0 (and any leading system messages) is the rendered system prompt and
  // is protected by the surface fold; everything after it is removable.
  let start = 0
  while (entries[start]?.type === 'system/message') start += 1
  if (start >= entries.length) return null

  // Keep any trailing unanswered user message(s). They are the current request
  // after a crash/resume and must survive the reset as the new first message.
  // A trailing checkpoint is not a request: it must be replaced, so the reset
  // never stacks two checkpoints.
  let endIndex = entries.length - 1
  while (endIndex >= start && entries[endIndex].type === 'user/message') {
    const event = session.eventAt(entries[endIndex].seq)
    const message = event?.type === 'user/message' ? event.data : event?.data?.message
    if (isCheckpointText(textOf(message))) break
    endIndex -= 1
  }
  if (endIndex < start) return null

  const range = entries.slice(start, endIndex + 1)
  if (range.length < config.minNodesToCompact) return null

  return {
    startSeq: range[0].seq,
    endSeq: range[range.length - 1].seq,
    shadowedSeqs: range.map((entry) => entry.seq),
    nodeCount: range.length,
    startIndex: start,
    endIndex,
  }
}

/**
 * Append the checkpoint as a `user/message` that replaces the planned span.
 * The append is one atomic session operation: if the surface fold rejects the
 * range, nothing changes and the caller can safely continue the turn.
 * @param {{ append: Function }} session
 * @param {ReturnType<typeof planRange>} plan
 * @param {string} text
 * @returns {any} the committed event
 */
export function applyReplacement(session, plan, text) {
  if (!plan) throw new Error('ContextCompactor: missing replacement plan')
  return session.append(
    'user/message',
    {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.shadowedSeqs,
    },
  )
}
