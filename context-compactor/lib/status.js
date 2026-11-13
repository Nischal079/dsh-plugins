/** Small, best-effort status artifact so operators can inspect the plugin. */
import fs from 'node:fs'
import path from 'node:path'

const STATUS_FILE = 'status.json'
const state = {
  activatedAt: 0,
  lastUpdateAt: 0,
  lastPressureAt: 0,
  sessions: {},
}

/**
 * Record an activation or compaction fact and persist it. Writes are
 * best-effort: a read-only profile must never break an agent turn.
 * @param {string} dir
 * @param {Record<string, any>} patch
 */
export function writeStatus(dir, patch) {
  try {
    Object.assign(state, patch)
    state.lastUpdateAt = Date.now()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, STATUS_FILE)
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(temporary, file)
  } catch {
    /* Observability is optional. */
  }
}

/**
 * Record the newest pressure reading for one session, throttled to one write
 * per two seconds so a busy step loop stays cheap.
 * @param {string} dir
 * @param {string} sessionId
 * @param {{ pressureTokens: number, contextWindow: number }} pressure
 * @param {number} thresholdRatio
 */
export function recordPressure(dir, sessionId, pressure, thresholdRatio) {
  const now = Date.now()
  if (now - state.lastPressureAt < 2000) {
    state.sessions[String(sessionId)] = {
      ...state.sessions[String(sessionId)],
      pressureTokens: pressure.pressureTokens,
      contextWindow: pressure.contextWindow,
      ratio: pressure.pressureTokens / pressure.contextWindow,
      thresholdRatio,
      at: now,
    }
    return
  }
  state.lastPressureAt = now
  state.sessions[String(sessionId)] = {
    ...state.sessions[String(sessionId)],
    pressureTokens: pressure.pressureTokens,
    contextWindow: pressure.contextWindow,
    ratio: pressure.pressureTokens / pressure.contextWindow,
    thresholdRatio,
    at: now,
  }
  writeStatus(dir, {})
}
