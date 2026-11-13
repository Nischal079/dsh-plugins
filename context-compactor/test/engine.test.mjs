/**
 * Integration tests for the plugin wiring. They import the real `apply()` and
 * drive the captured listeners against a fake Host context, so the trigger,
 * dry-run, handover, reset, rollback, persistence, and resume paths are all
 * exercised without touching a live session.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { STATE_KEYS } from '../lib/state.js'

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

function makeSession() {
  const events = [
    { seq: 1, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], source: { kind: 'system-prompt' } } } },
    { seq: 2, type: 'user/message', data: user('hi') },
    { seq: 3, type: 'user/message', data: user('Refactor the session surface and add regression tests for replacements.') },
    { seq: 4, type: 'assistant/message', data: { message: assistant('I will use the existing projection layer instead of rewriting it.', [{ id: 'c1', name: 'read', args: { path: 'src/core/surface.ts' } }]) } },
    { seq: 5, type: 'tool/result', data: { message: toolResult('c1', 'export function foldSurface() {}') } },
    { seq: 6, type: 'assistant/message', data: { message: assistant('Next:\n- Add replacement validation\n- Run the test suite', [{ id: 'c2', name: 'write', args: { path: 'src/core/surface.test.ts' } }]) } },
    { seq: 7, type: 'tool/result', data: { message: toolResult('c2', 'permission denied', true) } },
    { seq: 8, type: 'user/message', data: user('Remember that the workspace must stay read-only until review.') },
    { seq: 9, type: 'assistant/message', data: { message: assistant('Understood.') } },
  ]
  const session = {
    id: 'session-test',
    surface: { nodes: events.map((event) => event.seq) },
    eventAt: (seq) => events.find((event) => event.seq === seq),
    appends: [],
    append(type, data, options) {
      if (session.appendError) throw session.appendError
      session.appends.push({ type, data, options })
      return { seq: 100 + session.appends.length }
    },
  }
  return session
}

function makeContext(session, { pressure = 90, window = 100 } = {}) {
  const handlers = new Map()
  return {
    handlers,
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    tokenMeter: {
      contextPressure: () => ({ pressureTokens: pressure, contextWindow: window }),
      measure: () => ({ totalTokens: pressure }),
      estimateMessage: () => 25,
    },
    logger: { info() {}, warn() {}, error() {} },
    on(name, listener) {
      handlers.set(name, listener)
    },
    emit() {},
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-compactor-test-'))
}

async function runStep(ctx, { turn = 1, step = 1, nextValue = { kind: 'enter', messages: [] } } = {}) {
  const listener = ctx.handlers.get('agent/pre-step')
  assert.equal(typeof listener, 'function', 'pre-step listener must be registered')
  let nextCalls = 0
  const decision = await listener({ agent: { id: 'session-test' }, messages: [], turn, step, signal: new AbortController().signal }, async () => {
    nextCalls += 1
    return nextValue
  })
  return { decision, nextCalls }
}

function readRecord(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'session-test.json'), 'utf8'))
}

test('registers both lifecycle listeners', () => {
  const session = makeSession()
  const ctx = makeContext(session)
  apply(ctx, { storageDir: tempDir() })
  assert.ok(ctx.handlers.has('agent/pre-step'))
  assert.ok(ctx.handlers.has('agent/created'))
})

test('below threshold nothing changes and the step proceeds', async () => {
  const session = makeSession()
  const ctx = makeContext(session, { pressure: 40, window: 100 })
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: tempDir() })
  const { decision, nextCalls } = await runStep(ctx)
  assert.equal(nextCalls, 1)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(session.appends.length, 0)
})

test('at threshold it appends one balanced replacement and persists a checkpoint', async () => {
  const session = makeSession()
  const dir = tempDir()
  const ctx = makeContext(session)
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, checkpointTokenBudget: 900, retentionPolicy: 5, storageDir: dir })

  const { decision, nextCalls } = await runStep(ctx)
  assert.equal(nextCalls, 1, 'the turn continues by default')
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(session.appends.length, 1)

  const [append] = session.appends
  assert.equal(append.type, 'user/message')
  assert.equal(append.data.role, 'user')
  assert.match(append.data.content[0].text, /<checkpoint>/)
  assert.equal(append.options.surfaceOp.op, 'replace')
  assert.ok(append.options.surfaceOp.startSeq > 1, 'the system node is never replaced')
  assert.ok(append.options.surfaceOp.endSeq < session.surface.nodes.at(-1), 'range compaction keeps a recent tail')
  assert.equal(append.options.sourceEventSeqs.length, session.surface.nodes.length - 3)

  const record = readRecord(dir)
  assert.equal(record.checkpoints.length, 1)
  assert.deepEqual(Object.keys(record.checkpoints[0].state).sort(), [...STATE_KEYS].sort())
  assert.equal(record.checkpoints[0].version, 1)
  assert.ok(record.metrics.length >= 1)
  assert.ok(record.metrics[0].compressionRatio > 0)

  // One compaction per turn: a second pre-step in the same turn is a no-op.
  await runStep(ctx, { turn: 1 })
  assert.equal(session.appends.length, 1)
})

test('dry run reports but mutates nothing', async () => {
  const session = makeSession()
  const dir = tempDir()
  const ctx = makeContext(session)
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, dryRun: true, storageDir: dir })
  const { decision } = await runStep(ctx)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(session.appends.length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'sessions')), false, 'dry run writes no storage')
})

test('emergency handover resets the whole surface and continues the same step', async () => {
  const session = makeSession()
  const dir = tempDir()
  const ctx = makeContext(session, { pressure: 99, window: 100 })
  apply(ctx, { thresholdRatio: 0.9, handoverRatio: 0.985, handoverReserveTokens: 0, storageDir: dir })

  const { decision, nextCalls } = await runStep(ctx, { turn: 4, step: 1 })
  assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'the step must continue, not be rejected')
  assert.equal(nextCalls, 1)
  assert.equal(session.appends.length, 1)

  const [append] = session.appends
  assert.equal(append.type, 'user/message')
  assert.match(append.data.content[0].text, /reset this session/i)
  assert.equal(append.options.surfaceOp.op, 'replace')
  assert.equal(append.options.surfaceOp.startSeq, 2, 'the system node survives the reset')
  assert.equal(append.options.surfaceOp.endSeq, 9, 'every other node is replaced')
  assert.deepEqual(append.options.sourceEventSeqs, [2, 3, 4, 5, 6, 7, 8, 9])

  const record = readRecord(dir)
  assert.equal(record.checkpoints[0].reason, 'reset')
  assert.equal(record.metrics[0].trigger, 'reset')
  assert.equal(record.metrics[0].fullReset, true)
  assert.ok(record.metrics[0].nodeCount === 8)
})

test('the reserve guard resets before the handover ratio', async () => {
  const session = makeSession()
  const ctx = makeContext(session, { pressure: 70, window: 100 })
  apply(ctx, { thresholdRatio: 0.9, handoverRatio: 0.99, handoverReserveTokens: 40, storageDir: tempDir() })

  const { decision, nextCalls } = await runStep(ctx)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(nextCalls, 1)
  assert.equal(session.appends.length, 1)
  assert.equal(session.appends[0].options.surfaceOp.startSeq, 2)
  assert.equal(session.appends[0].options.surfaceOp.endSeq, 9)
})

test('mid-turn handover defers the reset to the next turn boundary', async () => {
  const session = makeSession()
  const ctx = makeContext(session, { pressure: 99, window: 100 })
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: tempDir() })

  const first = await runStep(ctx, { turn: 4, step: 2 })
  assert.deepEqual(first.decision, { kind: 'enter', messages: [] }, 'mid-turn steps must never be rejected')
  assert.equal(first.nextCalls, 1)
  assert.equal(session.appends.length, 1)
  assert.notEqual(session.appends[0].options.surfaceOp.endSeq, 9, 'mid-turn compaction is not a full reset')

  const second = await runStep(ctx, { turn: 5, step: 1 })
  assert.deepEqual(second.decision, { kind: 'enter', messages: [] })
  assert.equal(session.appends.length, 2)
  assert.equal(session.appends[1].options.surfaceOp.startSeq, 2)
  assert.equal(session.appends[1].options.surfaceOp.endSeq, 9, 'the deferred full reset lands at the turn boundary')
})

test('legacy handover still rejects when full reset is disabled', async () => {
  const session = makeSession()
  const ctx = makeContext(session, { pressure: 99, window: 100 })
  apply(ctx, {
    thresholdRatio: 0.9,
    handoverRatio: 0.985,
    fullResetOnHandover: false,
    handoverReserveTokens: 0,
    storageDir: tempDir(),
  })
  const { decision, nextCalls } = await runStep(ctx, { turn: 4 })
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(nextCalls, 0)
  assert.equal(session.appends.length, 1, 'state is saved before the pause')

  // The same turn cannot be rejected twice; the next turn resumes.
  const second = await runStep(ctx, { turn: 4 })
  assert.deepEqual(second.decision, { kind: 'enter', messages: [] })
})

test('pauseOnCompaction gives the strict handover contract at any pressure', async () => {
  const session = makeSession()
  const ctx = makeContext(session, { pressure: 91, window: 100 })
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, pauseOnCompaction: true, storageDir: tempDir() })
  const { decision } = await runStep(ctx)
  assert.deepEqual(decision, { kind: 'reject' })
})

test('a rejected append rolls back and the turn continues untouched', async () => {
  const session = makeSession()
  session.appendError = new Error('surface fold rejected the range')
  const dir = tempDir()
  const ctx = makeContext(session)
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: dir })
  const { decision, nextCalls } = await runStep(ctx)
  assert.equal(nextCalls, 1)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(session.appends.length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'session-test.json')), false)
})

test('a dry-run reset continues the step and writes nothing', async () => {
  const session = makeSession()
  const dir = tempDir()
  const ctx = makeContext(session, { pressure: 99, window: 100 })
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, dryRun: true, storageDir: dir })
  const { decision, nextCalls } = await runStep(ctx)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(nextCalls, 1)
  assert.equal(session.appends.length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'sessions')), false)
})

test('a rejected full reset rolls back and the turn continues', async () => {
  const session = makeSession()
  session.appendError = new Error('surface fold rejected the reset range')
  const dir = tempDir()
  const ctx = makeContext(session, { pressure: 99, window: 100 })
  apply(ctx, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: dir })
  const { decision, nextCalls } = await runStep(ctx)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(nextCalls, 1)
  assert.equal(session.appends.length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'session-test.json')), false)
})

test('a restored session without the checkpoint gets it injected', async () => {
  const session = makeSession()
  const dir = tempDir()
  const first = makeContext(session)
  apply(first, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: dir })
  await runStep(first)

  const bare = makeSession()
  const injected = []
  const second = makeContext(bare)
  apply(second, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: dir })
  const created = second.handlers.get('agent/created')
  created({ agent: { id: 'session-test', inject: (input) => injected.push(input) } })
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /<checkpoint>/)
})

test('a session that already carries the checkpoint is not injected twice', async () => {
  const session = makeSession()
  const dir = tempDir()
  const first = makeContext(session)
  apply(first, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: dir })
  await runStep(first)

  const record = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'session-test.json'), 'utf8'))
  const checkpointText = session.appends[0].data.content[0].text
  assert.ok(checkpointText.includes(JSON.stringify(record.checkpoints[0].state)))

  const withCheckpoint = makeSession()
  withCheckpoint.surface.nodes.push(10)
  withCheckpoint.eventAt = ((original) => (seq) =>
    seq === 10
      ? { seq: 10, type: 'user/message', data: user(checkpointText) }
      : original(seq))(withCheckpoint.eventAt)

  const injected = []
  const second = makeContext(withCheckpoint)
  apply(second, { thresholdRatio: 0.9, handoverReserveTokens: 0, storageDir: dir })
  second.handlers.get('agent/created')({ agent: { id: 'session-test', inject: (input) => injected.push(input) } })
  assert.equal(injected.length, 0)
})

test('unknown configuration keys fail loudly', () => {
  const session = makeSession()
  const ctx = makeContext(session)
  assert.throws(() => apply(ctx, { thresholdRatio: 0.9, typoRatio: 0.5 }), /unknown config key/)
})

test('activation writes an inspectable status artifact', () => {
  const dir = tempDir()
  apply(makeContext(makeSession()), { storageDir: dir, thresholdRatio: 0.9 })
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'))
  assert.ok(status.activatedAt > 0)
  assert.equal(status.config.thresholdRatio, 0.9)
  assert.equal(status.storageDir, dir)
})
