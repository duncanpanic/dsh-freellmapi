/**
 * Quota forecast: can this platform still serve us today, and for how much longer?
 *
 * The native router's limit handling is purely *reactive*: `QuotaTracker` lets a
 * request go out and only learns about the daily budget when the provider
 * answers 429. By then the request is spent, the key gets benched, and the panel
 * can only report "cooled" — a number the user cannot act on, because it looks
 * identical whether 2 requests or 2000 remain. The upstream project shipped
 * that shape and the failure it caused is specific: an agent would drain a
 * platform's remaining daily window in one burst of retries, discover the wall
 * only through failures, and then sit out a cooldown it never needed to enter.
 *
 * This module is the read-only counterpart. It answers two questions *before*
 * a request is sent:
 *
 *   * how many requests are left in today's window (budget minus today's use),
 *   * and how soon that runs out at the current pace.
 *
 * It only reads. `store`, `catalog` and `burnRate` are inspected, never
 * mutated: this feeds a settings panel that may render on every keystroke, and
 * a forecast that perturbs durable usage accounting would corrupt the very
 * numbers it reports.
 *
 * @module src/native/forecast.js
 */

// @ts-check

/**
 * Fraction of a window left below which the balance counts as low.
 *
 * 10% is the point where a shared free tier stops being something to lean on:
 * at that share a normal burst exhausts the window mid-call, halfway through a
 * tool loop that then has to fail over.
 */
export const LOW_BALANCE_THRESHOLD = 0.1

/** ...or fewer than this many requests left, on a window big enough to care. */
export const LOW_BALANCE_ABSOLUTE = 20

/**
 * The smallest window on which the absolute rule is allowed to speak.
 *
 * "20 requests left" and "14400 requests/day" mean opposite things: the first
 * is the edge of a cliff, the second is 99.9% of a window still untouched. The
 * upstream project shipped the absolute rule without this floor and the bug was
 * that *every* small tier warned from its very first request — a 30/day window
 * with 29 left tripped "fewer than 20 remain" on request two — so the flag was
 * permanently on for those platforms and therefore meant nothing at all. The
 * floor makes the flag informative rather than merely loud.
 *
 * Note the arithmetic consequence, which is real and worth knowing: for any
 * window at or above this floor, `remaining < 20` already implies
 * `remaining / limit <= 19/200 = 0.095 < 0.1`. The absolute rule can therefore
 * never *add* a warning below the percentage rule — it only ever agrees with
 * it. It is kept because it names the reason in units a user can act on
 * ("19 requests left", not "0.2%"), and the reason string is where the floor is
 * actually observable. Anything that changes the comparison direction must keep
 * this in mind: at exactly `limit === 200 && remaining === 20` an inclusive
 * `<=` would warn where a strict `<` does not, and that single lattice point is
 * the only input where the two spellings disagree at all.
 */
export const LOW_BALANCE_ABSOLUTE_MIN_LIMIT = 200

/**
 * How far back the injected burn-rate source is expected to look, in minutes.
 *
 * This constant does not measure anything itself — `buildForecast` cannot read
 * timestamps, only whatever the injected source already aggregated. It is the
 * window a caller must configure that source with, and it is reported in the
 * result so a panel can label the rate honestly. It must stay equal to
 * `QuotaTracker.BURN_WINDOW_MS` / 60_000; if the source used a different
 * window, every `burnRatePerMinute` here would be scaled wrong with no
 * visible symptom.
 */
export const BURN_WINDOW_MINUTES = 10

/**
 * @typedef {object} LowBalanceVerdict
 * @property {boolean} low     true when at least one warning rule fired
 * @property {string} reason   which rule(s) fired, or why none could be applied
 */

/**
 * @typedef {object} BurnReading
 * @property {number} [requests]  requests seen inside the source's window
 * @property {number} [perMinute] those requests expressed per minute
 */

/**
 * @typedef {object} ForecastEntry
 * @property {number} requestsToday
 * @property {number} tokensToday
 * @property {number | null} dailyRequestBudget
 * @property {number | null} remainingRequests
 * @property {number} burnRatePerMinute
 * @property {number | null} runwayMinutes
 * @property {boolean} lowBalance
 * @property {string} reason
 * @property {number} recentRequests
 */

/**
 * @typedef {object} Forecast
 * @property {Record<string, ForecastEntry>} platforms
 * @property {{ minutes: number }} window
 * @property {number} generatedAt
 */

/** Render a ratio as a short percentage for a human-facing reason. */
function percentText(ratio) {
  return `${Math.round(ratio * 1000) / 10}%`
}

/**
 * Decide whether a window's remaining balance is worth warning about.
 *
 * Pure, so the threshold rules can be pinned exactly without a store, a
 * catalog, or a clock.
 *
 * An unknown limit (missing, zero, or non-finite) is not a low balance: it
 * means the provider never published a window, and `quota.js` deliberately
 * treats that as unbounded. Warning about an unknown limit would flag every
 * provider that keeps its limits private, which is most of them.
 *
 * @param {{ remaining?: number|null, limit?: number|null }} balance
 * @returns {LowBalanceVerdict}
 */
export function lowBalanceVerdict({ remaining, limit }) {
  const cap = Number(limit)
  if (!Number.isFinite(cap) || cap <= 0) {
    return { low: false, reason: 'unlimited or unknown' }
  }

  // Check for null/undefined *before* coercing: `Number(null)` is 0, which
  // would read as "zero requests left" and fire the percentage rule on a window
  // whose remaining count is merely unknown. That inverts the meaning of a
  // missing reading, and it is exactly the false "exhausted" alarm this module
  // exists to avoid. `Number('')` and `Number(false)` are 0 for the same reason.
  if (remaining === null || remaining === undefined || typeof remaining === 'boolean') {
    return { low: false, reason: 'remaining unknown' }
  }
  const left = Number(remaining)
  if (!Number.isFinite(left) || left < 0) {
    // Without a usable remaining count there is nothing to compare. Reporting
    // the window as exhausted would be a lie in the other direction.
    return { low: false, reason: 'remaining unknown' }
  }

  /** @type {string[]} */
  const rules = []
  if (cap >= LOW_BALANCE_ABSOLUTE_MIN_LIMIT && left < LOW_BALANCE_ABSOLUTE) {
    rules.push(`fewer than ${LOW_BALANCE_ABSOLUTE} requests left (${left})`)
  }
  const ratio = left / cap
  if (ratio < LOW_BALANCE_THRESHOLD) {
    rules.push(`under ${LOW_BALANCE_THRESHOLD * 100}% of the window left (${percentText(ratio)})`)
  }

  if (rules.length === 0) return { low: false, reason: 'above the warning thresholds' }
  return { low: true, reason: rules.join(' and ') }
}

/** Normalise one burn reading into a usable non-negative rate count. */
function rateOf(reading, field) {
  const value = Number(reading?.[field])
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Minutes until the current daily window would be exhausted, or null.
 *
 * Null is returned in three distinct situations, and the panel renders them all
 * as "—" deliberately, because each one means "there is no exhaustion risk worth
 * reporting today":
 *
 *   * the balance is unknown — nothing to project from;
 *   * the observed pace is zero — no basis for a projection;
 *   * the projection runs past the end of the day. This is the case worth
 *     spelling out: a daily budget refills at midnight, so a figure larger than
 *     the remaining day is not a longer runway, it is a number the reader would
 *     have to clamp by hand. Reporting it as "9990 minutes" would read as
 *     "plenty" while the honest answer is "you cannot spend it fast enough to
 *     matter before it resets".
 *
 * Upstream reaches the same conclusion — `estimateExhaustionAt` returns null
 * rather than a capped value when the window resets first.
 *
 * @param {number | null} remaining
 * @param {number} perMinute
 * @param {number} now
 * @returns {number | null}
 */
function runwayMinutesFor(remaining, perMinute, now) {
  if (remaining === null || !(perMinute > 0)) return null
  const minutes = remaining / perMinute
  if (!Number.isFinite(minutes)) return null

  // Minutes left in the UTC day, matching `store`'s day boundary.
  const endOfDay = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000
  const minutesOfDayLeft = (endOfDay - now) / 60_000
  if (minutes >= minutesOfDayLeft) return null

  return Math.round(minutes * 100) / 100
}

/**
 * Build a per-platform forecast for today's request windows.
 *
 * The burn rate is *injected* rather than derived here, and that is a design
 * decision with a cost that must be stated plainly: `store` keeps only
 * whole-day rollups (`platformUsageToday`), so a rate computed from it would be
 * "one day's requests divided by the part of the day elapsed" — a number that
 * says nothing about a burst five minutes ago, and that a panel refreshing
 * every second would render as a slowly drifting fiction. Rather than dress
 * that up as precision, the caller passes a real observation source
 * (`QuotaTracker.burnRate`, which timestamps requests per platform over
 * `BURN_WINDOW_MINUTES`).
 *
 * When `burnRate` is omitted or cannot answer, this degrades to the honest
 * statement of ignorance: `burnRatePerMinute: 0` and `runwayMinutes: null`.
 * Zero means "no observed pace", never "will never run out" — the two are
 * indistinguishable in the number, so `runwayMinutes` carries the distinction
 * by going null instead of Infinity.
 *
 * @param {object} input
 * @param {{ platforms: () => string[], platformUsageToday: (platform: string, now?: number) => { requests: number, tokens: number } }} input.store
 * @param {{ modelIds: () => any[] }} input.catalog
 * @param {((platform: string) => BurnReading) | undefined} [input.burnRate]
 * @param {number} [input.now]
 * @returns {Forecast}
 */
export function buildForecast({ store, catalog, burnRate, now = Date.now() }) {
  const models = typeof catalog?.modelIds === 'function' ? catalog.modelIds() : []
  const roster = Array.isArray(models) ? models : []

  // A model's daily quota is its own; a platform's daily capacity is what all
  // of its models can spend together. Models whose provider never published an
  // rpd contribute nothing rather than zero, so an all-unknown platform stays
  // null (unknown) instead of silently reading as "no budget at all".
  /** @type {Map<string, number>} */
  const budget = new Map()
  for (const model of roster) {
    const platform = model?.platform
    if (typeof platform !== 'string' || platform === '') continue
    const rpd = Number(model?.limits?.rpd)
    if (!Number.isFinite(rpd) || rpd <= 0) continue
    budget.set(platform, (budget.get(platform) ?? 0) + rpd)
  }

  /** @type {Record<string, ForecastEntry>} */
  const platforms = {}

  for (const platform of store.platforms()) {
    const usage = store.platformUsageToday(platform, now)
    const requestsToday = Number(usage?.requests)
    const tokensToday = Number(usage?.tokens)

    const dailyRequestBudget = budget.has(platform) ? budget.get(platform) : null
    // Clamped at zero: a platform can go over its published window (the
    // provider kept accepting, or the roster's rpd is stale), and a negative
    // remaining would render as a strange negative runway.
    const remainingRequests = dailyRequestBudget === null
      ? null
      : Math.max(0, dailyRequestBudget - (Number.isFinite(requestsToday) ? requestsToday : 0))

    const reading = typeof burnRate === 'function' ? burnRate(platform) : undefined
    const recentRequests = rateOf(reading, 'requests')
    const burnRatePerMinute = rateOf(reading, 'perMinute')

    const verdict = lowBalanceVerdict({
      remaining: remainingRequests === null ? 0 : remainingRequests,
      limit: dailyRequestBudget,
    })

    platforms[platform] = {
      requestsToday: Number.isFinite(requestsToday) ? requestsToday : 0,
      tokensToday: Number.isFinite(tokensToday) ? tokensToday : 0,
      dailyRequestBudget,
      remainingRequests,
      burnRatePerMinute,
      // A zero rate yields null, not Infinity: no observed traffic is not the
      // same as an infinite runway, and a panel that renders Infinity is worse
      // than one that renders "unknown".
      //
      // The projection is also capped at the day boundary, and reports null
      // rather than a clamped number once it crosses. A daily budget resets, so
      // "4990 left at 0.5/min = 9980 minutes" is arithmetically true and
      // practically false — nobody can spend tomorrow's window today, and a
      // 166-hour runway reads as "plenty" when the real answer is "the window
      // refills long before you could use it up". Upstream reaches the same
      // conclusion and returns no projection at all rather than a capped one;
      // a number the reader has to mentally clamp is worse than an honest
      // "no risk of exhaustion today".
      runwayMinutes: runwayMinutesFor(remainingRequests, burnRatePerMinute, now),
      lowBalance: verdict.low,
      reason: verdict.reason,
      // Not part of the panel contract, but it separates "quiet platform" from
      // "no observation source wired up" — both show rate 0, and only this
      // tells the reader which one they are looking at.
      recentRequests,
    }
  }

  return {
    platforms,
    window: { minutes: BURN_WINDOW_MINUTES },
    generatedAt: now,
  }
}
