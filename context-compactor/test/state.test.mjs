/**
 * Pure unit tests for the deterministic layers. These import only `lib/*`, so
 * they run with plain `node --test` and no Harness runtime.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { buildCheckpoint, fitToBudget, frameCheckpoint } from '../lib/checkpoint.js'
import { planRange, planResetRange } from '../lib/compact.js'
import {
  CHECKPOINT_CLOSE,
  CHECKPOINT_OPEN,
  STATE_KEYS,
  extractState,
  parsePreviousCheckpoint,
  summarizeState,
} from '../lib/state.js'
import { estimateTokens, stableStringify } from '../lib/util.js'

function messageEvent(seq, type, message) {
  if (type === 'user/message') return { seq, type, data: message }
  return { seq, type, data: { message } }
}

function user(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistant(text, calls = []) {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) })),
    ],
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
  }
}

function toolResult(callId, text, isError = false) {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    toolCallId: callId,
    isError,
  }
}

function sessionOf(events) {
  return {
    surface: { nodes: events.map((event) => event.seq) },
    eventAt(seq) {
      return events.find((event) => event.seq === seq)
    },
  }
}

function sampleSession() {
  const events = [
    messageEvent(1, 'system/message', {
      role: 'system',
      content: [{ type: 'text', text: 'You are a coding agent. Do not modify production config.' }],
      source: { kind: 'system-prompt' },
    }),
    messageEvent(2, 'user/message', user('hi')),
    messageEvent(3, 'user/message', user('Refactor the session surface to support replacements across files in src/core and add tests.')),
    messageEvent(4, 'assistant/message', assistant('I will use the existing projection layer instead of rewriting it.', [
      { id: 'c1', name: 'read', args: { path: 'src/core/surface.ts' } },
    ])),
    messageEvent(5, 'tool/result', toolResult('c1', 'export function foldSurface() {}')),
    messageEvent(6, 'assistant/message', assistant('Decision: keep the fold pure so replay stays deterministic.\n\nNext:\n- Add replacement validation\n- Run the test suite', [
      { id: 'c2', name: 'write', args: { path: 'src/core/surface.test.ts' } },
    ])),
    messageEvent(7, 'tool/result', toolResult('c2', 'permission denied', true)),
    messageEvent(8, 'user/message', user('Remember that the workspace must stay read-only until review.')),
    messageEvent(9, 'assistant/message', assistant('Understood.')),
  ]
  return sessionOf(events)
}

test('checkpoint has exactly the eleven schema fields', () => {
  const state = extractState(sampleSession())
  assert.deepEqual(Object.keys(state).sort(), [...STATE_KEYS].sort())
  for (const key of ['task_goal', 'current_status', 'resume_instructions', 'carried_summary']) {
    assert.equal(typeof state[key], 'string')
  }
  for (const key of STATE_KEYS.filter((name) => !['task_goal', 'current_status', 'resume_instructions', 'carried_summary'].includes(name))) {
    assert.ok(Array.isArray(state[key]), `${key} must be an array`)
    assert.ok(state[key].every((item) => typeof item === 'string'), `${key} entries must be strings`)
  }
})

test('extraction is deterministic across independent runs', () => {
  const first = stableStringify(extractState(sampleSession()))
  const second = stableStringify(extractState(sampleSession()))
  assert.equal(first, second)
  assert.equal(buildCheckpoint(extractState(sampleSession()), { budget: 900 }).hash, buildCheckpoint(extractState(sampleSession()), { budget: 900 }).hash)
})

test('low-value greetings never become the task goal', () => {
  const state = extractState(sampleSession())
  assert.match(state.task_goal, /Refactor the session surface/)
  assert.doesNotMatch(state.task_goal, /^hi$/i)
})

test('tool outcomes split into completed and pending work', () => {
  const state = extractState(sampleSession())
  assert.ok(state.completed_work.some((item) => item.includes('read: src/core/surface.ts')))
  assert.ok(state.pending_work.some((item) => item.includes('Retry: write: src/core/surface.test.ts')))
  assert.ok(state.next_actions.length > 0)
})

test('decisions, constraints, files, and explicit memory are captured', () => {
  const state = extractState(sampleSession())
  assert.ok(state.important_decisions.some((item) => /instead of|Decision|keep the fold pure/i.test(item)))
  assert.ok(state.known_constraints.some((item) => /read-only/i.test(item)))
  assert.ok(state.relevant_files.includes('src/core/surface.ts'))
  assert.ok(state.relevant_files.includes('src/core/surface.test.ts'))
  assert.ok(state.important_memories.some((item) => /Remember that/i.test(item)))
})

test('checkpoints fit the configured token budget', () => {
  const state = extractState(sampleSession())
  const built = buildCheckpoint(state, { budget: 900 })
  assert.ok(built.tokens <= 900, `expected <= 900 tokens, got ${built.tokens}`)
  assert.ok(built.tokens > 40)
  assert.equal(built.hash.length, 16)
})

test('a tight budget prunes deterministically', () => {
  const state = extractState(sampleSession())
  const first = fitToBudget(state, 260)
  const second = fitToBudget(state, 260)
  assert.equal(stableStringify(first.state), stableStringify(second.state))
  assert.ok(first.tokens <= second.tokens || first.tokens === second.tokens)
  assert.ok(first.tokens < estimateTokens(stableStringify(state)) + 1)
})

test('framed checkpoint round-trips through the parser', () => {
  const state = extractState(sampleSession())
  const text = frameCheckpoint(state)
  assert.ok(text.includes(CHECKPOINT_OPEN) && text.includes(CHECKPOINT_CLOSE))
  const session = sessionOf([messageEvent(1, 'user/message', user(text)), messageEvent(2, 'assistant/message', assistant('ok'))])
  const parsed = parsePreviousCheckpoint([
    { role: 'user', text },
    { role: 'assistant', text: 'ok' },
  ])
  assert.deepEqual(parsed, state)
  // A later extraction carries the previous goal and completed work forward.
  const carried = extractState(session)
  assert.equal(carried.task_goal, state.task_goal)
  assert.ok(carried.completed_work.length >= state.completed_work.length)
})

test('range planning starts after the system node and ends on a user boundary', () => {
  const config = resolveConfig({ recentTailRatio: 0.3, minRecentMessages: 2, minNodesToCompact: 2 })
  const session = sampleSession()
  const plan = planRange(session, config)
  assert.ok(plan, 'expected a compactable range')
  assert.equal(plan.startSeq, 2, 'the leading system node must never be shadowed')
  const last = session.eventAt(plan.endSeq)
  assert.ok(last.type !== 'assistant/message', 'a range must not end on an unmatched assistant message')
  assert.ok(plan.nodeCount >= config.minNodesToCompact)
})

test('range planning refuses to split an assistant tool pair at the start', () => {
  const config = resolveConfig({ recentTailRatio: 0.2, minRecentMessages: 1, minNodesToCompact: 1 })
  const events = [
    messageEvent(1, 'system/message', { role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } }),
    messageEvent(2, 'assistant/message', assistant('calling', [{ id: 'a', name: 'read', args: { path: 'a.ts' } }])),
    messageEvent(3, 'tool/result', toolResult('a', 'ok')),
    messageEvent(4, 'user/message', user('next request goes here')),
    messageEvent(5, 'assistant/message', assistant('done')),
  ]
  const plan = planRange(sessionOf(events), config)
  if (plan) {
    assert.equal(sessionOf(events).eventAt(plan.startSeq).type, 'user/message')
  }
})

test('reset range covers every node after the protected system prompt', () => {
  const config = resolveConfig({ minNodesToCompact: 2 })
  const session = sampleSession()
  const plan = planResetRange(session, config)
  assert.ok(plan, 'expected a reset range')
  assert.equal(plan.startSeq, 2, 'the leading system node must survive the reset')
  assert.equal(plan.endSeq, 9, 'the range must end on the last surface node')
  assert.deepEqual(plan.shadowedSeqs, [2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(plan.nodeCount, 8)
})

test('reset range refuses a surface that has only the system prompt', () => {
  const session = sessionOf([
    messageEvent(1, 'system/message', {
      role: 'system',
      content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' },
    }),
  ])
  assert.equal(planResetRange(session, resolveConfig({})), null)
})

test('reset range preserves a trailing unanswered user message', () => {
  const events = [
    messageEvent(1, 'system/message', {
      role: 'system',
      content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' },
    }),
    messageEvent(2, 'user/message', user('Refactor the surface and add tests for replacements.')),
    messageEvent(3, 'assistant/message', assistant('The plan is ready.')),
    messageEvent(4, 'user/message', user('Also check the reset path before you finish.')),
  ]
  const plan = planResetRange(sessionOf(events), resolveConfig({ minNodesToCompact: 1 }))
  assert.ok(plan, 'expected a reset range')
  assert.equal(plan.endSeq, 3, 'the trailing user message must survive the reset')
  assert.deepEqual(plan.shadowedSeqs, [2, 3])
})

test('reset range replaces a trailing checkpoint instead of stacking one', () => {
  const checkpointText = frameCheckpoint(extractState(sampleSession()))
  const events = [
    messageEvent(1, 'system/message', {
      role: 'system',
      content: [{ type: 'text', text: 'sys' }],
      source: { kind: 'system-prompt' },
    }),
    messageEvent(2, 'user/message', user(checkpointText)),
  ]
  const plan = planResetRange(sessionOf(events), resolveConfig({ minNodesToCompact: 1 }))
  assert.ok(plan, 'the old checkpoint must be replaceable')
  assert.equal(plan.endSeq, 2)
  assert.deepEqual(plan.shadowedSeqs, [2])
})

test('the carried summary condenses the previous checkpoint and stays bounded', () => {
  const first = extractState(sampleSession())
  const previousText = frameCheckpoint(first)
  const resetSurface = sessionOf([
    messageEvent(1, 'user/message', user(previousText)),
    messageEvent(2, 'assistant/message', assistant('Resumed from the checkpoint.')),
  ])
  const carried = extractState(resetSurface, { carriedSummaryTokens: 200 })
  assert.ok(carried.carried_summary.length > 0)
  assert.match(carried.carried_summary, /Goal:/)
  assert.ok(carried.carried_summary.length <= 800, 'the carried summary must respect its character cap')
  assert.equal(carried.task_goal, first.task_goal, 'the original task goal survives a reset')
  assert.equal(carried.carried_summary, extractState(resetSurface, { carriedSummaryTokens: 200 }).carried_summary)

  // A later reset summarizes the previous summary instead of replaying history.
  const again = summarizeState(carried, { tokens: 200 })
  assert.match(again, /Earlier:/)
})

test('a legacy checkpoint without carried_summary still extracts and carries forward', () => {
  const state = extractState(sampleSession())
  const legacy = { ...state }
  delete legacy.carried_summary
  const text = `[old]\n\n${CHECKPOINT_OPEN}\n${JSON.stringify(legacy)}\n${CHECKPOINT_CLOSE}`
  const session = sessionOf([
    messageEvent(1, 'user/message', user(text)),
    messageEvent(2, 'assistant/message', assistant('Continuing.')),
  ])
  const carried = extractState(session)
  assert.ok(carried.carried_summary.length > 0)
  assert.match(carried.carried_summary, /Goal:/)
  assert.equal(carried.task_goal, state.task_goal)
})

test('reset framing advertises the reset', () => {
  const text = frameCheckpoint(extractState(sampleSession()), { reset: true })
  assert.match(text, /reset this session/i)
  assert.doesNotMatch(text, /restored the latest checkpoint/i)
})

test('the reset configuration keys validate', () => {
  const config = resolveConfig({ handoverReserveTokens: 0 })
  assert.equal(config.fullResetOnHandover, true)
  assert.equal(config.handoverReserveTokens, 0)
  assert.equal(config.carriedSummaryTokenBudget, 200)
  assert.throws(() => resolveConfig({ carriedSummaryTokenBudget: 10 }), /carriedSummaryTokenBudget/)
  assert.throws(() => resolveConfig({ handoverReserveTokens: -1 }), /non-negative/)
})
