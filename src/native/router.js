/**
 * The routing brain.
 *
 * Turns one requested model id into an ordered list of concrete
 * (platform, key, model) attempts, then interprets each failure so the next
 * attempt is a better bet rather than a repeat.
 *
 * Failure policy:
 *   * 429 / quota wording  -> bench that key for the stated back-off (or 60s);
 *   * 401 / 403            -> mark the key invalid for a day: the credential is
 *                             wrong, so retrying it soon only wastes attempts;
 *   * 5xx / timeout / net  -> bench briefly; the provider may be having a bad
 *                             minute rather than the key being bad;
 *   * 400 / 422            -> do not bench anything. The request is malformed,
 *                             so every other provider would reject it too — the
 *                             caller must see it.
 *
 * @module src/native/router.js
 */

// @ts-check

import { describeBlock } from './quota.js'
import { isToolDeferred, noteToolRejection, clearToolRejections } from './tool-capability.js'

const MINUTE = 60_000
const DAY = 86_400_000

/** How many attempts one call may make before giving up. */
export const MAX_ATTEMPTS = 8

/** Bench durations by failure class. */
const BENCH = {
  rateLimited: MINUTE,
  unauthorized: DAY,
  server: 30_000,
  transport: 30_000,
}

/** True when the response body/headers suggest a quota rather than a bug. */
function looksRateLimited(status, retryAfter, message) {
  if (status === 429) return true
  if (status === 503 && retryAfter > 0) return true
  return /rate limit|quota|too many requests|resource[_ ]exhausted/i.test(message ?? '')
}

/** Parse `Retry-After` (delta seconds or HTTP-date) into milliseconds. */
export function retryAfterMs(header) {
  if (typeof header !== 'string' || header.trim() === '') return 0
  const text = header.trim()
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, DAY)
  const when = Date.parse(text)
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), DAY)
  return 0
}

export class Router {
  /**
   * @param {{ store: import('./store.js').StateStore, quota: import('./quota.js').QuotaTracker }} deps
   */
  constructor(deps) {
    this.store = deps.store
    this.quota = deps.quota
  }

  /** True when a key entry is currently usable. */
  usable(entry, now = Date.now()) {
    if (!entry) return false
    if (entry.status === 'invalid' && Number(entry.cooldownUntil ?? 0) > now) return false
    return Number(entry.cooldownUntil ?? 0) <= now
  }

  /**
   * Ordered attempts for one model id.
   *
   * `skipped` explains why candidates were dropped, so an empty list can be
   * reported as "no keys" versus "every key is cooling down" versus "quota hit"
   * rather than a generic failure.
   *
   * Tool ordering is a *preference*, never a filter. When the request carries
   * tools, candidates are stably sorted by two keys:
   *
   *   1. `tools=false` in the catalog goes after `tools=true` — the flag is a
   *      family-based declaration, so a false positive (flagged, but 400s on
   *      tools) must stay reachable, and a false negative (unflagged, but
   *      works) must not be excluded outright;
   *   2. a model that has actually rejected tool requests goes last, until its
   *      deferral expires.
   *
   * The sort is stable within each group, so the catalog's own
   * intelligence/speed ranking still decides the order inside a tier.
   *
   * @param {readonly any[]} resolved models from the catalog, best-first
   * @param {{ now?: number, limit?: number, requireTools?: boolean }} [options]
   */
  candidates(resolved, options = {}) {
    const now = options.now ?? Date.now()
    const limit = options.limit ?? MAX_ATTEMPTS
    const requireTools = options.requireTools === true

    // Rank first, so the tier sort below preserves catalog order inside a tier.
    const ordered = requireTools
      ? resolved
          .map((model, index) => ({
            model,
            index,
            tier: (model.tools ? 0 : 1) + (isToolDeferred(model.platform, model.id, now) ? 2 : 0),
          }))
          .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
          .map(entry => entry.model)
      : resolved

    /** @type {any[]} */
    const out = []
    const skipped = { noKey: 0, cooling: 0, quota: 0, unresolved: 0 }
    /** @type {string[]} */
    const reasons = []

    for (const model of ordered) {
      const entries = this.store.entries(model.platform)
      if (entries.length === 0) {
        skipped.noKey += 1
        continue
      }
      // Round-robin across keys: rotate by the least recently started attempt.
      for (const entry of entries) {
        if (!this.usable(entry, now)) {
          skipped.cooling += 1
          continue
        }
        const block = this.quota.blockFor(model.platform, entry.id, model.id, model.limits, now)
        if (block) {
          skipped.quota += 1
          if (reasons.length < 5) reasons.push(`${model.platform}/${model.id}: ${describeBlock(block)}`)
          continue
        }
        out.push({
          platform: model.platform,
          keyId: entry.id,
          label: entry.label || '',
          model: model.id,
          limits: model.limits,
          contextWindow: model.contextWindow,
          tools: model.tools,
        })
        if (out.length >= limit) return { attempts: out, skipped, reasons }
      }
    }

    return { attempts: out, skipped, reasons }
  }

  /** Bench a key after a failure. Returns the bench duration applied. */
  bench(platform, keyId, failure) {
    const status = Number(failure?.status ?? 0)
    const message = typeof failure?.message === 'string' ? failure.message : ''
    const now = Date.now()

    let duration = BENCH.transport
    let statusLabel = 'unknown'

    if (looksRateLimited(status, retryAfterMs(failure?.retryAfter), message)) {
      duration = Math.max(retryAfterMs(failure?.retryAfter), BENCH.rateLimited)
      statusLabel = 'throttled'
    } else if (status === 401 || status === 403) {
      duration = BENCH.unauthorized
      statusLabel = 'invalid'
    } else if (status >= 500) {
      duration = BENCH.server
      statusLabel = 'error'
    } else if (status === 400 || status === 422) {
      // Never bench on a malformed request.
      return 0
    }

    const until = now + duration
    const entry = this.store.entries(platform).find(item => item.id === keyId)
    const existing = Number(entry?.cooldownUntil ?? 0)
    this.store.patchKey(platform, keyId, {
      status: statusLabel,
      cooldownUntil: Math.max(existing, until),
      lastError: message.slice(0, 300),
      lastCheckedAt: now,
    })
    return duration
  }

  /**
   * Account a tool-carrying request this model rejected as a bad request.
   *
   * Only 400/422 count. A 429 or a 5xx says nothing about tool support, and
   * counting those would defer models for the wrong reason.
   *
   * @returns {boolean} true when this rejection crossed the deferral threshold
   */
  noteToolFailure(platform, model, status) {
    if (status !== 400 && status !== 422) return false
    return noteToolRejection(platform, model)
  }

  /**
   * Account a tool-carrying request that succeeded: the model supports tools
   * after all, so any accumulated suspicion was wrong.
   */
  noteToolSuccess(platform, model) {
    clearToolRejections(platform, model)
  }

  /** Clear a key's bench after a success. */
  clear(platform, keyId) {
    const entry = this.store.entries(platform).find(item => item.id === keyId)
    if (!entry) return
    if (entry.status === 'healthy' && Number(entry.cooldownUntil ?? 0) === 0) return
    this.store.patchKey(platform, keyId, { status: 'healthy', cooldownUntil: 0, lastError: '', lastCheckedAt: Date.now() })
  }

  /** Account a completed attempt. */
  record(platform, keyId, model, tokens) {
    this.quota.note(platform, keyId, model, tokens)
  }
}
