/** Versioned, atomic checkpoint storage in the DSH profile directory. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeSessionFileId } from './util.js'

const SCHEMA_VERSION = 2

/**
 * Resolve the checkpoint root without touching the workspace.
 * `$DSH_PROFILE_DIR` is set for profile-launched Harnesses; the fallback keeps
 * the plugin usable outside a profile.
 * @param {string} configured
 * @returns {string}
 */
export function defaultStorageDir(configured = '') {
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim())
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.trim()) {
    return path.join(path.resolve(profileDir.trim()), 'context-compactor')
  }
  return path.join(os.homedir(), '.dsh', 'context-compactor')
}

/** Durable checkpoint history for one plugin instance. */
export class CheckpointStore {
  /** @param {string} root */
  constructor(root) {
    this.root = root
    this.cache = new Map()
  }

  /** @param {string} sessionId @returns {string} */
  fileFor(sessionId) {
    return path.join(this.root, 'sessions', `${safeSessionFileId(sessionId)}.json`)
  }

  /**
   * Read one session's durable record, or an empty one.
   * @param {string} sessionId
   * @returns {{ schemaVersion: number, sessionId: string, updatedAt: number, checkpoints: any[], metrics: any[] }}
   */
  load(sessionId) {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const empty = { schemaVersion: SCHEMA_VERSION, sessionId, updatedAt: 0, checkpoints: [], metrics: [] }
    try {
      const text = fs.readFileSync(this.fileFor(sessionId), 'utf8')
      const parsed = JSON.parse(text)
      const record = {
        schemaVersion: SCHEMA_VERSION,
        sessionId,
        updatedAt: Number(parsed?.updatedAt ?? 0),
        checkpoints: Array.isArray(parsed?.checkpoints) ? parsed.checkpoints.map(migrateCheckpoint) : [],
        metrics: Array.isArray(parsed?.metrics) ? parsed.metrics : [],
      }
      this.cache.set(sessionId, record)
      return record
    } catch {
      this.cache.set(sessionId, empty)
      return empty
    }
  }

  /** @param {string} sessionId @returns {any | null} */
  latest(sessionId) {
    const record = this.load(sessionId)
    return record.checkpoints.length > 0 ? record.checkpoints[record.checkpoints.length - 1] : null
  }

  /** @param {string} sessionId @returns {any[]} */
  history(sessionId) {
    return [...this.load(sessionId).checkpoints]
  }

  /**
   * Append one checkpoint and prune to the retention policy.
   * @param {string} sessionId
   * @param {any} entry
   * @param {{ retention: number, now?: number }} options
   * @returns {{ version: number, persisted: boolean, error?: string }}
   */
  record(sessionId, entry, options) {
    const record = this.load(sessionId)
    const version = record.checkpoints.length + 1
    const stamped = { ...entry, version, createdAt: options.now ?? Date.now() }
    record.checkpoints = [...record.checkpoints, stamped].slice(-Math.max(1, options.retention))
    record.updatedAt = stamped.createdAt

    try {
      writeAtomic(this.fileFor(sessionId), JSON.stringify(record, null, 2))
      this.cache.set(sessionId, record)
      return { version, persisted: true }
    } catch (error) {
      // Keep the in-memory view consistent with the durable file on failure.
      record.checkpoints = record.checkpoints.filter((item) => item.version !== version)
      return { version, persisted: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Append one metrics sample, keeping the most recent fifty.
   * @param {string} sessionId
   * @param {any} metrics
   * @param {{ now?: number }} [options]
   */
  recordMetrics(sessionId, metrics, options = {}) {
    const record = this.load(sessionId)
    const sample = { ...metrics, at: options.now ?? Date.now() }
    record.metrics = [...record.metrics, sample].slice(-50)
    try {
      writeAtomic(this.fileFor(sessionId), JSON.stringify(record, null, 2))
      this.cache.set(sessionId, record)
    } catch {
      /* Metrics are best-effort; the checkpoint itself is already durable. */
    }
    return sample
  }
}

/**
 * Upgrade a checkpoint written before `carried_summary` existed (schema v1)
 * so later reads and resume injection always see the current field set.
 * @param {any} checkpoint
 * @returns {any}
 */
function migrateCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return checkpoint
  const state = checkpoint.state
  if (!state || typeof state !== 'object' || typeof state.carried_summary === 'string') return checkpoint
  return { ...checkpoint, state: { ...state, carried_summary: '' } }
}

/**
 * Write a file through a same-directory temporary file and an atomic rename.
 * @param {string} file
 * @param {string} text
 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, text, 'utf8')
  fs.renameSync(temporary, file)
}
