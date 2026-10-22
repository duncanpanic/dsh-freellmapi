/**
 * Durable state for the native router.
 *
 * Holds the key pool and the usage rollups. Keys are secrets, so they are
 * sealed with AES-256-GCM under a master key this directory owns — the same
 * shape FreeLLMAPI uses, so a `.encryption-key` copied from it can be adopted
 * later without a migration.
 *
 * The file is rewritten atomically (temp + rename): a crash mid-save must not
 * leave a truncated pool behind, because that would silently drop every key the
 * user pasted in.
 *
 * @module src/native/store.js
 */

// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_VERSION = 1
const MASTER_KEY_FILE = '.master-key'

/** Resolve the directory that holds state and the master key. */
export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return path.join(os.homedir(), '.dsh', 'freellmapi')
}

/**
 * Read the master key, creating one on first use.
 *
 * A missing key next to an existing state file means the key material was
 * deleted, not that this is a fresh install: minting a new key would make every
 * stored secret undecryptable and the failure would only surface later. The
 * caller is told so it can report, and we still create the file so a genuinely
 * fresh install proceeds.
 *
 * @param {string} dir
 * @returns {{ key: Buffer, created: boolean }}
 */
function loadMasterKey(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, MASTER_KEY_FILE)
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    const key = Buffer.from(raw, 'base64')
    if (key.length !== 32) throw new Error(`master key is ${key.length} bytes, expected 32`)
    return { key, created: false }
  } catch (error) {
    if (error && /** @type {any} */ (error).code !== 'ENOENT') throw error
    const key = crypto.randomBytes(32)
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 })
    return { key, created: true }
  }
}

/** Seal a secret as `v1.<iv>.<tag>.<ciphertext>`, every part base64. */
export function sealSecret(masterKey, plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join('.')
}

/** Open a sealed secret. Returns null when the payload is malformed or forged. */
export function openSecret(masterKey, sealed) {
  if (typeof sealed !== 'string') return null
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const iv = Buffer.from(parts[1], 'base64')
    const tag = Buffer.from(parts[2], 'base64')
    const body = Buffer.from(parts[3], 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** A key pool entry, as persisted (the secret stays sealed on disk). */
export function emptyState() {
  return {
    version: STATE_VERSION,
    /** platform -> array of entries */
    keys: {},
    /** "YYYY-MM-DD" -> { "<platform>|<keyId>|<model>": {requests, tokens} } */
    daily: {},
    /** last day observed, so stale rollups can be pruned */
    lastPrunedDay: '',
  }
}

/** How many days of rollups to keep. */
const RETAIN_DAYS = 7

/**
 * The store handle.
 *
 * Reads are cheap (in-memory); writes are debounced so a burst of request
 * accounting does not rewrite the file on every token.
 */
export class StateStore {
  /** @param {{ dir: string }} options */
  constructor(options) {
    this.dir = options.dir
    this.file = path.join(this.dir, 'state.json')
    const { key } = loadMasterKey(this.dir)
    this.masterKey = key
    this.state = this.read()
    /** @type {NodeJS.Timeout | undefined} */
    this.saveTimer = undefined
    this.dirty = false
  }

  /** Load state, tolerating absence but never corruption. */
  read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') throw new Error('state is not an object')
      return {
        version: STATE_VERSION,
        keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
        daily: parsed.daily && typeof parsed.daily === 'object' ? parsed.daily : {},
        lastPrunedDay: typeof parsed.lastPrunedDay === 'string' ? parsed.lastPrunedDay : '',
      }
    } catch (error) {
      if (error && /** @type {any} */ (error).code === 'ENOENT') return emptyState()
      // A corrupt file is moved aside instead of overwritten: the keys in it
      // may be recoverable by hand, and silently replacing it would destroy them.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        fs.renameSync(this.file, backup)
      } catch {
        /* best effort */
      }
      return emptyState()
    }
  }

  /** Persist synchronously. */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    const temp = `${this.file}.tmp-${process.pid}`
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 1), { mode: 0o600 })
    fs.renameSync(temp, this.file)
  }

  /** Mark dirty and schedule a write. */
  touch() {
    this.dirty = true
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      try {
        this.flush()
      } catch {
        /* the next touch retries */
      }
    }, 1200)
    this.saveTimer.unref?.()
  }

  /** Dispose: flush pending writes. */
  close() {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.flush()
  }

  // ── key pool ───────────────────────────────────────────────────────────────

  /** Every configured platform. */
  platforms() {
    return Object.keys(this.state.keys)
  }

  /** Entries for one platform (secrets still sealed). */
  entries(platform) {
    const list = this.state.keys[platform]
    return Array.isArray(list) ? list : []
  }

  /** Add a key for a platform. Returns the created entry id. */
  addKey(platform, secret, label = '') {
    const list = this.state.keys[platform] ?? []
    const id = crypto.randomBytes(6).toString('hex')
    list.push({
      id,
      label,
      secret: sealSecret(this.masterKey, secret),
      status: 'unknown',
      cooldownUntil: 0,
      lastError: '',
      addedAt: Date.now(),
    })
    this.state.keys[platform] = list
    this.touch()
    return id
  }

  /** Remove one key. */
  removeKey(platform, id) {
    const list = this.state.keys[platform]
    if (!Array.isArray(list)) return false
    const next = list.filter(entry => entry.id !== id)
    if (next.length === list.length) return false
    if (next.length === 0) delete this.state.keys[platform]
    else this.state.keys[platform] = next
    this.touch()
    return true
  }

  /** Decrypt one entry's secret. Null when the seal no longer matches. */
  secretOf(platform, id) {
    const entry = this.entries(platform).find(item => item.id === id)
    if (!entry) return null
    return openSecret(this.masterKey, entry.secret)
  }

  /** Update mutable fields on one entry. */
  patchKey(platform, id, patch) {
    const entry = this.entries(platform).find(item => item.id === id)
    if (!entry) return
    Object.assign(entry, patch)
    this.touch()
  }

  // ── usage rollups ──────────────────────────────────────────────────────────

  /** Today's key, in UTC (quota windows reset at the provider's day boundary). */
  static dayKey(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10)
  }

  /** The mutable bucket for one (day, platform, key, model). */
  bucket(platform, keyId, model, now = Date.now()) {
    const day = StateStore.dayKey(now)
    this.prune(day)
    const today = (this.state.daily[day] ??= {})
    const id = `${platform}|${keyId}|${model}`
    return (today[id] ??= { requests: 0, tokens: 0 })
  }

  /** Account one completed request. */
  record(platform, keyId, model, tokens, now = Date.now()) {
    const bucket = this.bucket(platform, keyId, model, now)
    bucket.requests += 1
    bucket.tokens += Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0
    this.touch()
  }

  /** Today's counts for one triple, or zeros. */
  usageOf(platform, keyId, model, now = Date.now()) {
    const day = this.state.daily[StateStore.dayKey(now)]
    const bucket = day?.[`${platform}|${keyId}|${model}`]
    return { requests: bucket?.requests ?? 0, tokens: bucket?.tokens ?? 0 }
  }

  /** Aggregate today's usage for one platform across its keys. */
  platformUsageToday(platform, now = Date.now()) {
    const day = this.state.daily[StateStore.dayKey(now)] ?? {}
    let requests = 0
    let tokens = 0
    for (const [id, bucket] of Object.entries(day)) {
      if (!id.startsWith(`${platform}|`)) continue
      requests += bucket.requests
      tokens += bucket.tokens
    }
    return { requests, tokens }
  }

  /** Drop rollups older than the retention window. */
  prune(day = StateStore.dayKey()) {
    if (this.state.lastPrunedDay === day) return
    this.state.lastPrunedDay = day
    const cutoff = Date.now() - RETAIN_DAYS * 86_400_000
    for (const key of Object.keys(this.state.daily)) {
      const stamp = Date.parse(`${key}T00:00:00Z`)
      if (Number.isFinite(stamp) && stamp < cutoff) delete this.state.daily[key]
    }
    this.touch()
  }
}
