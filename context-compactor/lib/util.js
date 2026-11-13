/** Deterministic helpers shared by the ContextCompactor modules. */
import { createHash } from 'node:crypto'

/**
 * Serialize a JSON value with object keys sorted, so equal values always
 * produce byte-identical text regardless of insertion order.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = /** @type {Record<string, unknown>} */ (value)
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/**
 * Estimate model tokens with the same four-characters-per-token heuristic the
 * host token meter uses for unpriced text.
 * @param {unknown} value
 * @returns {number}
 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : stableStringify(value)
  return Math.ceil(text.length / 4)
}

/** Collapse runs of whitespace and trim. @param {unknown} text @returns {string} */
export function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Collapse whitespace and bound the length, ending with an ellipsis when cut.
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function clampText(text, max) {
  const collapsed = collapseWhitespace(text)
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** @param {string} text @returns {string} */
export function sha1(text) {
  return createHash('sha1').update(text).digest('hex')
}

/** Make a session id safe to use as a file name. @param {string} id @returns {string} */
export function safeSessionFileId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_')
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'than', 'them',
  'they', 'have', 'has', 'was', 'were', 'will', 'would', 'can', 'could', 'should',
  'not', 'but', 'you', 'your', 'our', 'are', 'is', 'be', 'to', 'of', 'in', 'on',
  'it', 'as', 'at', 'by', 'or', 'an', 'a', 'i', 'we', 'do', 'does', 'did', 'so',
])

/**
 * Lowercase word set used for relevance scoring.
 * @param {string} text
 * @returns {Set<string>}
 */
export function keywordSet(text) {
  const set = new Set()
  for (const word of String(text ?? '').toLowerCase().split(/[^a-z0-9_.-]+/)) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    set.add(word)
  }
  return set
}

/**
 * Remove duplicates while preserving first-seen order.
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} keyOf
 * @returns {T[]}
 */
export function uniqueBy(items, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
