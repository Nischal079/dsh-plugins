/**
 * Deterministic state extraction from the session surface.
 *
 * Nothing here calls a model: the same surface always yields byte-identical
 * state, which is what makes checkpoints safe to reload and diff.
 */
import { clampText, collapseWhitespace, keywordSet, stableStringify, uniqueBy } from './util.js'

export const CHECKPOINT_OPEN = '<checkpoint>'
export const CHECKPOINT_CLOSE = '</checkpoint>'

/** The exact checkpoint schema, used for validation and ordering. */
export const STATE_KEYS = Object.freeze([
  'task_goal',
  'current_status',
  'completed_work',
  'pending_work',
  'important_decisions',
  'known_constraints',
  'relevant_files',
  'important_memories',
  'next_actions',
  'resume_instructions',
  'carried_summary',
])

const GREETING_RE = /^(hi|hello|hey|yo|hiya|good\s+(morning|afternoon|evening)|thanks|thank\s+you|thx|ok|okay|got\s+it|sounds\s+good|great|cool|perfect|nice|sure|yes|no|yep|nope|bye|goodbye|test)[.!,\s]*$/i

const CONSTRAINT_RE = /\b(must|must\s+not|do\s+not|don't|never|only|require[ds]?|constraint|ensure|always|avoid|without|keep|no\s+changes?\s+to|read[- ]only|make\s+sure)\b/i

const DECISION_RE = /\b(i\s+(will|'ll|am\s+going\s+to)|we\s+(will|'ll)|decided|decision|instead\s+of|rather\s+than|chose|choosing|approach|plan\s+is|opted?\s+for|switched?\s+to)\b/i

const NEXT_HEADER_RE = /^(next(?:\s+steps?|\s+actions?)?|todo|to\s+do|pending|remaining|follow[- ]?up)\s*[:\-]\s*(.*)$/i

const CHECKBOX_OPEN_RE = /^\s*[-*+]\s*\[\s\]\s+(.{3,200})$/
const CHECKBOX_DONE_RE = /^\s*[-*+]\s*\[[xX]\]\s+(.{3,200})$/

const MEMORY_RE = /\b(remember(?:\s+that)?|note\s+that|keep\s+in\s+mind|important\s*:|for\s+future\s+reference)\b/i

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target', 'cwd', 'dir', 'directory']
const TARGET_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'command', 'pattern', 'query', 'url', 'name', 'id']

const FILE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|cpp|h|css|scss|html|json|ya?ml|toml|md|txt|sh|sql|lock)$/i
const TEXT_PATH_RE = /(?:^|[\s"'`([{,])((?:[A-Za-z]:)?(?:\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+(?:\.[A-Za-z0-9]{1,8})?)(?=$|[\s"'`)\]}>,:;])/g

/**
 * Read the current model-visible surface as flat entries.
 * @param {{ surface: { nodes: readonly number[] }, eventAt: (seq: number) => any }} session
 * @returns {Array<Record<string, any>>}
 */
export function readSurface(session) {
  const entries = []
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  for (const seq of nodes) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    if (!event) continue
    const message = messageOf(event)
    if (!message) continue
    entries.push({
      seq,
      type: event.type,
      role: message.role,
      sourceKind: message.source?.kind,
      text: textOf(message),
      message,
      isError: message.isError === true,
      toolCalls: toolCallsOf(message),
    })
  }
  return entries
}

/** @param {any} event @returns {any} */
function messageOf(event) {
  if (!event) return null
  if (event.type === 'user/message') return event.data ?? null
  const message = event.data?.message
  if (message && typeof message === 'object' && typeof message.role === 'string') return message
  return null
}

/** @param {any} message @returns {string} */
export function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** @param {any} message @returns {Array<{id: string, name: string, arguments: string}>} */
function toolCallsOf(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content
    .filter((block) => block?.type === 'tool-call')
    .map((block) => ({
      id: String(block.id ?? ''),
      name: String(block.name ?? 'tool'),
      arguments: typeof block.arguments === 'string' ? block.arguments : stableStringify(block.arguments ?? {}),
    }))
}

/** @param {string} text @returns {boolean} */
export function isLowValue(text) {
  const collapsed = collapseWhitespace(text)
  if (collapsed.length === 0) return true
  if (collapsed.length <= 3) return true
  return GREETING_RE.test(collapsed)
}

/** @param {string} text @returns {boolean} */
export function isCheckpointText(text) {
  return typeof text === 'string' && text.includes(CHECKPOINT_OPEN) && text.includes(CHECKPOINT_CLOSE)
}

/**
 * Parse the newest embedded checkpoint in a surface.
 * @param {Array<Record<string, any>>} entries
 * @returns {Record<string, any> | null}
 */
export function parsePreviousCheckpoint(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.role !== 'user' || !isCheckpointText(entry.text)) continue
    const open = entry.text.indexOf(CHECKPOINT_OPEN)
    const close = entry.text.lastIndexOf(CHECKPOINT_CLOSE)
    if (open < 0 || close <= open) continue
    try {
      const parsed = JSON.parse(entry.text.slice(open + CHECKPOINT_OPEN.length, close).trim())
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* A malformed checkpoint is ignored; extraction falls back to the log. */
    }
  }
  return null
}

/**
 * Build the eleven-field checkpoint state from the current surface.
 *
 * Extraction is mechanical: tool calls/results supply completed and pending
 * work, explicit markers supply decisions and constraints, and the previous
 * checkpoint supplies carried-forward memory filtered by relevance.
 *
 * @param {{ surface: { nodes: readonly number[] }, eventAt: (seq: number) => any }} session
 * @param {{ checkpointTokenBudget?: number, carriedSummaryTokens?: number }} [options]
 * @returns {Record<string, any>}
 */
export function extractState(session, options = {}) {
  const entries = readSurface(session)
  const previous = parsePreviousCheckpoint(entries)
  const carriedSummary = previous
    ? summarizeState(previous, { tokens: options.carriedSummaryTokens ?? 200 })
    : ''
  const conversational = entries.filter((entry) => !(entry.role === 'user' && isCheckpointText(entry.text)))

  const userTexts = conversational
    .filter((entry) => entry.role === 'user' && entry.sourceKind === 'user')
    .map((entry) => entry.text)
    .filter((text) => !isLowValue(text))

  const toolResults = new Map()
  for (const entry of conversational) {
    if (entry.role !== 'tool') continue
    const callId = entry.message?.source?.callId
    if (callId) toolResults.set(String(callId), entry)
  }

  const callNames = new Map()
  for (const entry of conversational) {
    for (const call of entry.toolCalls) callNames.set(call.id, call.name)
  }

  const completedWork = []
  const failedWork = []
  const files = []
  const fileSet = new Set()
  const addFile = (raw) => {
    const value = normalizePath(raw)
    if (!value || fileSet.has(value)) return
    fileSet.add(value)
    files.push(value)
  }

  for (const entry of conversational) {
    if (entry.role === 'user' || entry.role === 'assistant') {
      for (const match of entry.text.matchAll(TEXT_PATH_RE)) addFile(match[1])
    }

    for (const call of entry.toolCalls) {
      let args = {}
      try {
        args = JSON.parse(call.arguments)
      } catch {
        args = {}
      }
      for (const key of PATH_KEYS) {
        const value = args?.[key]
        if (typeof value === 'string') addFile(value)
      }

      const target = targetOf(args)
      const result = toolResults.get(call.id)
      const label = target ? `${call.name}: ${target}` : call.name
      if (!result) failedWork.push(`Complete or verify: ${label}`)
      else if (result.isError) failedWork.push(`Retry: ${label}`)
      else completedWork.push(label)
    }
  }

  const taskGoal = pickTaskGoal(userTexts, previous)

  const decisions = []
  for (const entry of conversational) {
    if (entry.role !== 'assistant') continue
    for (const sentence of sentences(entry.text)) {
      if (sentence.length < 20) continue
      if (!DECISION_RE.test(sentence)) continue
      decisions.push(clampText(sentence, 220))
    }
  }

  const constraints = []
  for (const entry of conversational) {
    if (entry.role !== 'user' && entry.role !== 'developer') continue
    for (const sentence of sentences(entry.text)) {
      if (sentence.length < 12) continue
      if (!CONSTRAINT_RE.test(sentence)) continue
      constraints.push(clampText(sentence, 220))
    }
  }

  const checkboxesOpen = []
  const checkboxesDone = []
  for (const entry of conversational) {
    for (const line of entry.text.split('\n')) {
      const open = CHECKBOX_OPEN_RE.exec(line)
      if (open) checkboxesOpen.push(clampText(open[1], 200))
      const done = CHECKBOX_DONE_RE.exec(line)
      if (done) checkboxesDone.push(clampText(done[1], 200))
    }
  }

  const headerActions = nextHeaderActions(conversational)

  const status = buildStatus(conversational, callNames)

  const memories = []
  for (const entry of conversational) {
    if (entry.role !== 'user') continue
    for (const sentence of sentences(entry.text)) {
      if (!MEMORY_RE.test(sentence)) continue
      memories.push(clampText(sentence, 220))
    }
  }
  const carriedMemories = Array.isArray(previous?.important_memories) ? previous.important_memories : []
  const relevance = keywordSet([taskGoal, status, ...headerActions, ...userTexts.slice(-1)].join(' '))
  const scoredMemories = [...carriedMemories, ...memories]
    .filter((memory) => typeof memory === 'string' && memory.length > 0)
    .map((memory, index) => ({ memory, index, score: relevanceScore(memory, relevance) }))
    .filter((item) => item.score > 0 || relevance.size === 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.memory)

  const completedMerged = capTail([...(previous?.completed_work ?? []), ...completedWork], 12)
  const completedKeys = new Set(completedMerged.map((item) => String(item).toLowerCase()))
  const pendingMerged = capHead(
    uniqueBy(
      [...checkboxesOpen, ...headerActions, ...failedWork, ...(previous?.pending_work ?? [])]
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .filter((item) => !completedKeys.has(item.toLowerCase())),
      (item) => item.toLowerCase(),
    ),
    8,
  )

  const nextActions = capHead(
    uniqueBy(
      [...headerActions, ...checkboxesOpen, ...failedWork, ...(Array.isArray(previous?.next_actions) ? previous.next_actions : [])]
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .filter((item) => !completedKeys.has(item.toLowerCase())),
      (item) => item.toLowerCase(),
    ),
    5,
  )

  const state = {
    task_goal: taskGoal,
    current_status: status,
    completed_work: completedMerged,
    pending_work: pendingMerged,
    important_decisions: capTail(uniqueBy([...(previous?.important_decisions ?? []), ...decisions], String), 8),
    known_constraints: capTail(uniqueBy([...(previous?.known_constraints ?? []), ...constraints], String), 8),
    relevant_files: capTail(uniqueBy([...(previous?.relevant_files ?? []), ...files], String), 20),
    important_memories: capHead(uniqueBy(scoredMemories, String), 6),
    next_actions: nextActions.length > 0 ? nextActions : ['Review the checkpoint and continue the task'],
    resume_instructions: '',
    carried_summary: carriedSummary,
  }

  state.resume_instructions = buildResumeInstructions(state)

  return {
    task_goal: clampText(state.task_goal, 400),
    current_status: clampText(state.current_status, 400),
    completed_work: state.completed_work.map((item) => clampText(item, 220)),
    pending_work: state.pending_work.map((item) => clampText(item, 220)),
    important_decisions: state.important_decisions.map((item) => clampText(item, 220)),
    known_constraints: state.known_constraints.map((item) => clampText(item, 220)),
    relevant_files: state.relevant_files.map((item) => clampText(item, 240)),
    important_memories: state.important_memories.map((item) => clampText(item, 220)),
    next_actions: state.next_actions.map((item) => clampText(item, 220)),
    resume_instructions: clampText(state.resume_instructions, 600),
    carried_summary: clampText(state.carried_summary, 1600),
  }
}

/**
 * Condense a previous checkpoint into the carried summary of the next one.
 * Deterministic: no model call, stable ordering, bounded length.
 * @param {Record<string, any>} previous
 * @param {{ tokens?: number }} [options]
 * @returns {string}
 */
export function summarizeState(previous, options = {}) {
  const tokens = Number.isInteger(options.tokens) && options.tokens > 0 ? options.tokens : 200
  const maxChars = Math.max(80, tokens * 4)
  const parts = []
  if (previous?.task_goal) parts.push(`Goal: ${previous.task_goal}`)
  if (previous?.current_status) parts.push(`Status: ${previous.current_status}`)
  const done = Array.isArray(previous?.completed_work) ? previous.completed_work.slice(-3) : []
  if (done.length > 0) parts.push(`Done: ${done.join('; ')}`)
  const decisions = Array.isArray(previous?.important_decisions) ? previous.important_decisions.slice(-3) : []
  if (decisions.length > 0) parts.push(`Decisions: ${decisions.join('; ')}`)
  const next = Array.isArray(previous?.next_actions) ? previous.next_actions.slice(0, 3) : []
  if (next.length > 0) parts.push(`Next: ${next.join('; ')}`)
  if (previous?.carried_summary) parts.push(`Earlier: ${previous.carried_summary}`)
  if (parts.length === 0) return ''
  return clampText(parts.join(' '), maxChars)
}

/** @param {string[]} userTexts @param {any} previous @returns {string} */
function pickTaskGoal(userTexts, previous) {
  const first = userTexts.find((text) => collapseWhitespace(text).length >= 12)
  if (first) return clampText(first, 400)
  if (previous?.task_goal) return String(previous.task_goal)
  return userTexts.length > 0 ? clampText(userTexts[0], 400) : '(no user task recorded yet)'
}

/** @param {string} text @returns {string[]} */
function sentences(text) {
  return String(text ?? '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((value) => collapseWhitespace(value))
    .filter((value) => value.length > 0)
}

/** @param {Record<string, any>} args @returns {string} */
function targetOf(args) {
  if (!args || typeof args !== 'object') return ''
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return clampText(value, 120)
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return clampText(value, 100)
  }
  return ''
}

/** @param {unknown} raw @returns {string | null} */
function normalizePath(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 300 || value.includes('\n')) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null
  if (/\s/.test(value)) return null
  const hasSlash = value.includes('/')
  if (!hasSlash && !FILE_EXT_RE.test(value)) return null
  if (hasSlash && !FILE_EXT_RE.test(value) && !value.startsWith('/') && !value.startsWith('./') && !value.startsWith('../')) {
    return null
  }
  return clampText(value, 240)
}

/** @param {Array<Record<string, any>>} entries @param {Map<string, string>} callNames @returns {string} */
function buildStatus(entries, callNames) {
  const parts = []
  const lastAssistant = [...entries].reverse().find((entry) => entry.role === 'assistant' && collapseWhitespace(entry.text).length > 0)
  if (lastAssistant) {
    const first = sentences(lastAssistant.text)[0] ?? ''
    if (first) parts.push(`Last model output: ${clampText(first, 180)}`)
  }
  const lastTool = [...entries].reverse().find((entry) => entry.role === 'tool')
  if (lastTool) {
    const callId = String(lastTool.message?.source?.callId ?? '')
    const name = callNames.get(callId) ?? 'tool'
    parts.push(`Last tool: ${name} (${lastTool.isError ? 'error' : 'ok'})`)
  }
  if (parts.length === 0) return 'No durable progress recorded yet.'
  return parts.join('; ')
}

/** @param {Array<Record<string, any>>} entries @returns {string[]} */
function nextHeaderActions(entries) {
  const actions = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.role !== 'assistant') continue
    const lines = entry.text.split('\n')
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const match = NEXT_HEADER_RE.exec(lines[lineIndex].trim())
      if (!match) continue
      if (match[2]) actions.push(clampText(match[2], 200))
      for (let offset = lineIndex + 1; offset < lines.length; offset += 1) {
        const line = lines[offset].trim()
        if (!line) break
        const bullet = /^(?:[-*+]|\d+[.)])\s+(.{3,200})$/.exec(line)
        if (!bullet) break
        actions.push(clampText(bullet[1], 200))
      }
    }
    if (actions.length > 0) break
  }
  return uniqueBy(actions, (item) => item.toLowerCase())
}

/** @param {string} memory @param {Set<string>} relevance @returns {number} */
function relevanceScore(memory, relevance) {
  if (relevance.size === 0) return 0
  let score = 0
  for (const word of keywordSet(memory)) if (relevance.has(word)) score += 1
  return score
}

/** @param {any[]} items @param {number} max @returns {any[]} */
function capTail(items, max) {
  return items.length <= max ? items : items.slice(items.length - max)
}

/** @param {any[]} items @param {number} max @returns {any[]} */
function capHead(items, max) {
  return items.length <= max ? items : items.slice(0, max)
}

/** @param {Record<string, any>} state @returns {string} */
export function buildResumeInstructions(state) {
  const goal = clampText(state.task_goal, 160)
  const status = clampText(state.current_status, 160)
  const next = state.next_actions.length > 0 ? state.next_actions.slice(0, 3).join(' | ') : 'continue the task'
  const constraints = state.known_constraints.length > 0 ? ` Respect: ${state.known_constraints.slice(0, 2).join(' | ')}.` : ''
  return clampText(
    `Resume the task "${goal}". Current status: ${status}. Next: ${next}. Do not redo completed work.${constraints}`,
    600,
  )
}
