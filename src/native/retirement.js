/**
 * Auto-retirement of models an upstream provider has permanently removed.
 *
 * The cost of not doing this: a model that answers `410 Gone` or "no longer
 * available" forever is tried on every request — a wasted round trip and a
 * burned fallback slot, indefinitely. Routing rules out a model for *one*
 * request after a failure; only a persisted verdict stops the next request from
 * paying the same price.
 *
 * The dangerous half is the opposite error. A single flaky 404 from a load
 * balancer must never kill a healthy model, and a 429 or 500 whose *body*
 * happens to mention a retirement — an advisory notice, a status-page quote, a
 * message about a different model — must not count as evidence either. So the
 * signal is graded:
 *
 *   definitive  a status that itself means "gone" (410 / 451), or a
 *               not-found status carrying end-of-life wording;
 *   probable    a not-found status carrying "no longer available" wording;
 *   neither     everything else, including every non-404 status.
 *
 * A definitive signal retires immediately. A probable one needs corroboration
 * from a second *distinct* request, so one request failing over across sibling
 * keys cannot corroborate itself.
 *
 * Retirement is persisted and reversible: the panel can lift it, and a catalog
 * rebuild that still lists the model starts it clean.
 *
 * @module src/native/retirement.js
 */

// @ts-check

import fs from 'node:fs'
import path from 'node:path'

/** How many distinct requests must report a 'probable' signal before acting. */
export const CONFIRMATIONS_REQUIRED = 2

/**
 * Corroboration must be recent: two "no longer available" 404s a week apart are
 * two outages, two within the hour are a retirement.
 */
export const OBSERVATION_WINDOW_MS = 60 * 60 * 1000

/** End-of-life wording that is only definitive when the status agrees. */
const END_OF_LIFE_PATTERNS = [
  /has reached its end of life/i,
  /end[- ]of[- ]life/i,
  /no longer (available|supported|served)/i,
  /has been (retired|deprecated|discontinued|removed)/i,
  /model (is )?(retired|deprecated|discontinued|sunset)/i,
  /was removed from/i,
]

/** Weaker "the model is not here" wording: needs corroboration. */
const MODEL_GONE_PATTERNS = [
  /model[_ ]not[_ ]found/i,
  /unknown model/i,
  /no such model/i,
  /does not exist/i,
  /invalid model/i,
  /model [`'"]?[a-z0-9._:/-]+[`'"]? not found/i,
]

/**
 * Statuses that by themselves mean the resource is gone.
 *
 * 410 is the canonical "gone permanently". 451 is "unavailable for legal
 * reasons", which is a location problem rather than a retirement — it is
 * deliberately NOT here; `region.js` claims it.
 */
const GONE_STATUSES = new Set([410])

/** Statuses that can carry a "not found" body worth reading. */
const NOT_FOUND_STATUSES = new Set([404])

/** Is this status a plain "this endpoint does not exist" (bad URL, not model)? */
export function isModelNotFound(status, message) {
  if (NOT_FOUND_STATUSES.has(Number(status))) return true
  const text = String(message ?? '')
  return MODEL_GONE_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Grade one failure's evidence that a model is retired.
 *
 * @param {{ status?: number, message?: string }} failure
 * @returns {'definitive' | 'probable' | null}
 */
export function retirementSignal(failure) {
  const status = Number(failure?.status ?? 0)
  const message = String(failure?.message ?? '')

  const gone = GONE_STATUSES.has(status) || /\b410 gone\b/i.test(message)
  const eolWording = END_OF_LIFE_PATTERNS.some(pattern => pattern.test(message))

  // A definitive verdict skips the corroboration gate, so the wording alone must
  // never grant it: the status has to agree the model is actually absent.
  if (gone) return 'definitive'
  if (isModelNotFound(status, message) && eolWording) return 'definitive'

  if (!isModelNotFound(status, message)) return null
  return MODEL_GONE_PATTERNS.some(pattern => pattern.test(message)) ? 'probable' : null
}

/**
 * Tracks retirements, with corroboration, and persists them.
 *
 * Persistence matters here in a way it does not for tool capability: a
 * retirement is a durable fact about the world, and forgetting it on restart
 * would resume paying the round trip on every launch.
 */
export class RetirementRegistry {
  /**
   * @param {{ file?: string, logger?: any }} [options]
   */
  constructor(options = {}) {
    this.file = options.file ?? ''
    this.logger = options.logger
    /** @type {Map<string, { reason: string, at: number }>} */
    this.retired = new Map()
    /** @type {Map<string, { count: number, firstSeenAt: number, lastRequest: unknown }>} */
    this.observations = new Map()
    this.load()
  }

  /** The registry key for one route. */
  static keyOf(platform, model) {
    return `${platform}|${model}`
  }

  load() {
    if (this.file === '') return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const entries = parsed && typeof parsed.entries === 'object' ? parsed.entries : {}
      for (const [key, value] of Object.entries(entries)) {
        if (!value || typeof value !== 'object') continue
        this.retired.set(key, {
          reason: String(value.reason ?? 'retired'),
          at: Number(value.at ?? 0),
        })
      }
    } catch (error) {
      if (error && /** @type {any} */ (error).code !== 'ENOENT') {
        this.logger?.warn?.(`freellmapi-native: retirement state unreadable (${error?.message ?? error})`)
      }
    }
  }

  save() {
    if (this.file === '') return
    const payload = {
      version: 1,
      entries: Object.fromEntries(this.retired),
    }
    const temp = `${this.file}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(temp, JSON.stringify(payload, null, 1), { mode: 0o600 })
      fs.renameSync(temp, this.file)
    } catch (error) {
      this.logger?.warn?.(`freellmapi-native: could not persist retirement state (${error?.message ?? error})`)
    }
  }

  /** Is this route retired? */
  isRetired(platform, model) {
    return this.retired.has(RetirementRegistry.keyOf(platform, model))
  }

  /** Every retired route, for the panel. */
  list() {
    return [...this.retired.entries()].map(([key, value]) => {
      const [platform, ...rest] = key.split('|')
      return { platform, model: rest.join('|'), reason: value.reason, at: value.at }
    })
  }

  /** Undo a retirement — the panel's escape hatch, and the catalog's. */
  lift(platform, model) {
    const key = RetirementRegistry.keyOf(platform, model)
    const had = this.retired.delete(key)
    if (had) this.save()
    return had
  }

  /** Drop every retirement. */
  liftAll() {
    const count = this.retired.size
    this.retired.clear()
    this.observations.clear()
    this.save()
    return count
  }

  /**
   * Record one failure and retire the route when the evidence allows it.
   *
   * @param {string} platform
   * @param {string} model
   * @param {{ status?: number, message?: string }} failure
   * @param {unknown} [requestToken] identity of the request, so one request
   *   failing over across sibling keys cannot corroborate itself.
   * @returns {boolean} true when this call performed the retirement
   */
  note(platform, model, failure, requestToken) {
    const confidence = retirementSignal(failure)
    if (confidence === null) return false

    const key = RetirementRegistry.keyOf(platform, model)
    if (confidence === 'probable' && !this.corroborate(key, requestToken)) return false

    const reason = String(failure?.message ?? 'upstream reports it retired').slice(0, 200)
    this.retired.set(key, { reason, at: Date.now() })
    this.observations.delete(key)
    this.save()
    this.logger?.warn?.(`freellmapi-native: ${platform}/${model} retired — upstream reports it gone: ${reason}`)
    return true
  }

  /** Whether a 'probable' verdict has enough distinct corroboration now. */
  corroborate(key, requestToken) {
    const now = Date.now()
    const existing = this.observations.get(key)
    if (!existing || now - existing.firstSeenAt > OBSERVATION_WINDOW_MS) {
      this.observations.set(key, { count: 1, firstSeenAt: now, lastRequest: requestToken })
      return CONFIRMATIONS_REQUIRED <= 1
    }
    // The same request failing over across this model's sibling keys is one
    // request's worth of evidence, however many keys it burned.
    if (requestToken !== undefined && existing.lastRequest === requestToken) return false
    existing.count += 1
    existing.lastRequest = requestToken
    return existing.count >= CONFIRMATIONS_REQUIRED
  }

  /** Test seam. */
  resetObservations() {
    this.observations.clear()
  }
}
