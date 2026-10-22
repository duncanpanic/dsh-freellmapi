/**
 * Rate-limit accounting for the native router.
 *
 * Provider free tiers are limited per (platform, model, key) on four axes:
 * requests/minute, requests/day, tokens/minute, tokens/day. The daily side is
 * durable (it must survive a restart, or a relaunch would quietly reset a
 * budget the upstream still considers spent); the per-minute side is
 * in-memory on purpose — a 60s window has no value across a restart.
 *
 * A missing or non-positive limit means "not published", which is treated as
 * unbounded rather than as zero: refusing a provider because it did not
 * advertise a number would be worse than trying it and failing over.
 *
 * @module src/native/quota.js
 */

// @ts-check

const MINUTE_MS = 60_000

/**
 * How long a per-platform request timestamp is kept, for burn-rate estimation.
 *
 * Longer than the per-minute window because a rate read over one minute is pure
 * jitter: two requests landing together says nothing about today's pace. Ten
 * minutes is short enough to track a burst and long enough to ignore a pause.
 */
export const BURN_WINDOW_MS = 10 * 60_000

/** Coerce a catalog limit into a usable number or Infinity. */
function limitOf(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : Infinity
}

/**
 * Why a request may not go out, or null when it may.
 *
 * @typedef {{ axis: 'rpm' | 'rpd' | 'tpm' | 'tpd', used: number, limit: number }} QuotaBlock
 */

export class QuotaTracker {
  /** @param {import('./store.js').StateStore} store */
  constructor(store) {
    this.store = store
    /** @type {Map<string, { t: number, tokens: number }[]>} */
    this.minute = new Map()
    /**
     * Per-platform request timestamps over BURN_WINDOW_MS.
     *
     * Separate from `minute` because the two answer different questions: that
     * one asks "may I send now", this asks "how fast am I spending". Sharing a
     * bucket would mean widening the enforcement window to suit a read-only
     * estimate, which changes routing behaviour as a side effect.
     *
     * @type {Map<string, number[]>}
     */
    this.burn = new Map()
  }

  /** Drop minute buckets that fell out of the window. */
  sweep(now = Date.now()) {
    const cutoff = now - MINUTE_MS
    for (const [scope, hits] of this.minute) {
      const kept = hits.filter(hit => hit.t > cutoff)
      if (kept.length === 0) this.minute.delete(scope)
      else if (kept.length !== hits.length) this.minute.set(scope, kept)
    }
    const burnCutoff = now - BURN_WINDOW_MS
    for (const [platform, stamps] of this.burn) {
      const kept = stamps.filter(stamp => stamp > burnCutoff)
      if (kept.length === 0) this.burn.delete(platform)
      else if (kept.length !== stamps.length) this.burn.set(platform, kept)
    }
  }

  /**
   * Requests sent to one platform inside the burn window.
   *
   * The returned rate is honest about its own resolution: with no traffic it is
   * zero, and the caller must treat zero as "unknown pace", not "will never run
   * out".
   */
  burnRate(platform, now = Date.now()) {
    const stamps = this.burn.get(platform)
    if (!stamps || stamps.length === 0) return { requests: 0, perMinute: 0 }
    const cutoff = now - BURN_WINDOW_MS
    const recent = stamps.filter(stamp => stamp > cutoff)
    return {
      requests: recent.length,
      perMinute: recent.length / (BURN_WINDOW_MS / MINUTE_MS),
    }
  }

  /** Minute-window totals for one scope. */
  recent(scope, now = Date.now()) {
    const hits = this.minute.get(scope) ?? []
    const cutoff = now - MINUTE_MS
    let requests = 0
    let tokens = 0
    for (const hit of hits) {
      if (hit.t <= cutoff) continue
      requests += 1
      tokens += hit.tokens
    }
    return { requests, tokens }
  }

  /**
   * Check whether one (platform, key, model) triple may send a request now.
   *
   * @param {string} platform
   * @param {string} keyId
   * @param {string} model
   * @param {{ rpm?: number|null, rpd?: number|null, tpm?: number|null, tpd?: number|null }} limits
   * @param {number} [now]
   * @returns {QuotaBlock | null}
   */
  blockFor(platform, keyId, model, limits, now = Date.now()) {
    const scope = `${platform}|${keyId}|${model}`
    const minute = this.recent(scope, now)
    const day = this.store.usageOf(platform, keyId, model, now)

    const rpm = limitOf(limits?.rpm)
    if (minute.requests >= rpm) return { axis: 'rpm', used: minute.requests, limit: rpm }

    const rpd = limitOf(limits?.rpd)
    if (day.requests >= rpd) return { axis: 'rpd', used: day.requests, limit: rpd }

    const tpm = limitOf(limits?.tpm)
    if (minute.tokens >= tpm) return { axis: 'tpm', used: minute.tokens, limit: tpm }

    const tpd = limitOf(limits?.tpd)
    if (day.tokens >= tpd) return { axis: 'tpd', used: day.tokens, limit: tpd }

    return null
  }

  /** Record one completed request on both windows. */
  note(platform, keyId, model, tokens, now = Date.now()) {
    const scope = `${platform}|${keyId}|${model}`
    const used = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0
    const hits = this.minute.get(scope) ?? []
    hits.push({ t: now, tokens: used })
    this.minute.set(scope, hits)

    // Kept per platform rather than per triple: the forecast answers "can I keep
    // using this provider", and a provider's daily budget is the thing that runs
    // out, not one model's slice of it.
    const burns = this.burn.get(platform) ?? []
    burns.push(now)
    this.burn.set(platform, burns)

    this.store.record(platform, keyId, model, used, now)
  }

  /** Snapshot for the settings panel: every configured platform's usage today. */
  summary() {
    this.sweep()
    /** @type {Record<string, { requests: number, tokens: number, keys: number, cooled: number }>} */
    const out = {}
    for (const platform of this.store.platforms()) {
      const totals = this.store.platformUsageToday(platform)
      const entries = this.store.entries(platform)
      const now = Date.now()
      out[platform] = {
        requests: totals.requests,
        tokens: totals.tokens,
        keys: entries.length,
        cooled: entries.filter(entry => Number(entry.cooldownUntil ?? 0) > now).length,
      }
    }
    return out
  }
}

/** Render a block reason for logs and panels. */
export function describeBlock(block) {
  if (!block) return ''
  const unit = block.axis === 'rpm' || block.axis === 'rpd' ? 'requests' : 'tokens'
  return `${block.axis} exhausted (${block.used}/${Number.isFinite(block.limit) ? block.limit : '∞'} ${unit})`
}
