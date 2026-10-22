/**
 * Offline tests for the quota forecast.
 *
 * No network and no clock dependence that matters: `now` is passed in, and the
 * burn rate is injected, so every number here is fixed by the test rather than
 * by how fast the machine runs.
 *
 * The boundary cases are the point of this file. `lowBalanceVerdict` is the
 * kind of function whose obvious implementation is subtly wrong, so the exact
 * lattice points (10% exactly, 20 left exactly, the 200-request floor) are
 * pinned rather than approximated.
 *
 * Run: node test/forecast.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore } from '../src/native/store.js'
import {
  BURN_WINDOW_MINUTES,
  LOW_BALANCE_ABSOLUTE,
  LOW_BALANCE_ABSOLUTE_MIN_LIMIT,
  LOW_BALANCE_THRESHOLD,
  buildForecast,
  lowBalanceVerdict,
} from '../src/native/forecast.js'

let checks = 0
/** Print one passing check. Kept tiny so failures (`node:assert`) stand out. */
function ok(label) {
  checks += 1
  console.log(`ok  ${label}`)
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flm-forecast-'))
}

function main() {
  const NOW = Date.UTC(2026, 2, 4, 12, 0, 0)

  // ── the exported contract ──────────────────────────────────────────────────
  // The integration code and the panel both branch on these values. Asserting
  // them here means a silent edit to any of them fails loudly instead of
  // changing behaviour somewhere far away.
  assert.equal(LOW_BALANCE_THRESHOLD, 0.1)
  assert.equal(LOW_BALANCE_ABSOLUTE, 20)
  assert.equal(LOW_BALANCE_ABSOLUTE_MIN_LIMIT, 200)
  assert.equal(BURN_WINDOW_MINUTES, 10)
  ok('constants: threshold / absolute / floor / burn window locked')

  // ── lowBalanceVerdict: percentage rule ─────────────────────────────────────
  // Exactly 10% is not "under 10%". The comparison is strict, and this is the
  // case that decides whether a window right at the line flaps.
  assert.equal(lowBalanceVerdict({ remaining: 10, limit: 100 }).low, false, 'exactly 10% must not warn')
  assert.equal(lowBalanceVerdict({ remaining: 9, limit: 100 }).low, true, 'just under 10% must warn')
  ok('percentage rule: exactly 10% is not low, 9% is')

  // ── lowBalanceVerdict: the absolute floor ──────────────────────────────────
  // Exactly 20 left is not "fewer than 20". NOTE: the upstream TypeScript uses
  // `remaining <= LOW_BALANCE_ABSOLUTE` here, which warns at exactly 20. This
  // module follows the written rule (`remaining < LOW_BALANCE_ABSOLUTE`), so
  // this single input is the one place the two disagree. See the report.
  assert.equal(lowBalanceVerdict({ remaining: 20, limit: 200 }).low, false, 'exactly 20 left must not warn')
  assert.equal(lowBalanceVerdict({ remaining: 19, limit: 200 }).low, true, '19 left on a 200 window must warn')
  ok('absolute rule: exactly 20 left is not low, 19 is')

  // This is what LOW_BALANCE_ABSOLUTE_MIN_LIMIT actually buys, and it is not a
  // change in the boolean at the 200 line: it is a change in *why*. At limit
  // 199 the absolute rule is gated off, so only the percentage rule speaks; at
  // 200 both fire. (Both warn here because 19/199 = 9.5% is under 10% too —
  // that overlap is inherent, since any remaining < 20 on a limit >= 200 is
  // already below 10%.)
  const belowFloor = lowBalanceVerdict({ remaining: 19, limit: 199 })
  const atFloor = lowBalanceVerdict({ remaining: 19, limit: 200 })
  assert.equal(belowFloor.low, true)
  assert.equal(atFloor.low, true)
  assert.ok(!/fewer than 20/.test(belowFloor.reason), 'limit 199 must not invoke the absolute rule')
  assert.ok(/fewer than 20/.test(atFloor.reason), 'limit 200 must invoke the absolute rule')
  assert.ok(/under 10%/.test(atFloor.reason), 'limit 200 should report both rules')
  ok('floor boundary: limit 199 uses the percentage rule only, limit 200 adds the absolute rule')

  // The reason the floor exists. A 30/day tier with 15 left still has half its
  // window; without the gate the absolute rule would call that low. This is the
  // case that keeps the flag meaningful on small free tiers instead of turning
  // it on permanently.
  assert.equal(lowBalanceVerdict({ remaining: 15, limit: 30 }).low, false, 'small window must ignore the absolute rule')
  assert.equal(lowBalanceVerdict({ remaining: 2, limit: 30 }).low, true, 'small window still warns once the percentage bites')
  ok('small windows: absolute rule is gated off, percentage rule still applies')

  // ── lowBalanceVerdict: the cases named in the brief ────────────────────────
  assert.equal(lowBalanceVerdict({ remaining: 15, limit: 100 }).low, false, '15% of a 100 window is not low')
  assert.equal(lowBalanceVerdict({ remaining: 5, limit: 100 }).low, true, '5% of a 100 window is low')
  assert.equal(lowBalanceVerdict({ remaining: 19, limit: 10000 }).low, true, '19 left on a huge window is low')
  ok('mixed thresholds: 100/15 quiet, 100/5 low, 10000/19 low')

  // The brief lists `limit 10000, remaining 25` as "no warning". That cannot
  // hold under the rules it also states: 25/10000 is 0.25%, far under the 10%
  // percentage threshold, and the percentage rule fires on its own. Upstream
  // has the same behaviour (its `low_balance` is an OR of the two rules). So
  // the truth here is `true`, and asserting the brief's expectation would
  // require deleting the percentage rule — which is the rule that catches a
  // 14400/day window being nearly gone at 25 requests. Recorded as a deviation.
  assert.equal(lowBalanceVerdict({ remaining: 25, limit: 10000 }).low, true, '25 left on a huge window is low by percentage')
  ok('10000/25 warns: the percentage rule alone decides (documented deviation from the brief)')

  // ── lowBalanceVerdict: unknown limits ──────────────────────────────────────
  // Missing, zero, and non-finite all mean "the provider never published a
  // window". `quota.js` treats that as unbounded, so warning would flag almost
  // every platform in the catalog.
  for (const limit of [null, 0, undefined, NaN, Infinity, -5]) {
    const verdict = lowBalanceVerdict({ remaining: 1, limit })
    assert.equal(verdict.low, false, `limit ${String(limit)} must not warn`)
    assert.equal(verdict.reason, 'unlimited or unknown')
  }
  // A known limit with no remaining count is also not a warning: claiming
  // exhaustion would be a different lie.
  assert.equal(lowBalanceVerdict({ remaining: null, limit: 100 }).low, false)
  ok('unknown limits (null/0/undefined/NaN/Infinity/negative) never warn')

  // ── buildForecast: empty store ─────────────────────────────────────────────
  const emptyDir = tempDir()
  const emptyStore = new StateStore({ dir: emptyDir })
  const emptyForecast = buildForecast({ store: emptyStore, catalog: { modelIds: () => [] }, now: NOW })
  assert.deepEqual(emptyForecast.platforms, {}, 'a store with no keys has no platforms')
  assert.equal(emptyForecast.window.minutes, BURN_WINDOW_MINUTES)
  assert.equal(emptyForecast.generatedAt, NOW)
  assert.deepEqual(Object.keys(emptyForecast).sort(), ['generatedAt', 'platforms', 'window'])
  ok('empty store: platforms is an empty object, window and generatedAt are present')

  // ── buildForecast: budgets, sums, burn rate, immutability ──────────────────
  const dir = tempDir()
  const store = new StateStore({ dir })

  // Two models on one platform carry separate daily windows, so the platform's
  // capacity is the sum. A third publishes no rpd and must contribute nothing
  // (rather than zero, which would read as "no budget").
  const catalog = {
    modelIds: () => [
      { id: 'alpha-big', platform: 'alpha', limits: { rpm: 60, rpd: 100 } },
      { id: 'alpha-small', platform: 'alpha', limits: { rpm: 60, rpd: 50 } },
      { id: 'alpha-unknown', platform: 'alpha', limits: { rpm: 60, rpd: null } },
      // rpd 0 means "not published", matching limitOf() in quota.js.
      { id: 'alpha-zero', platform: 'alpha', limits: { rpm: 60, rpd: 0 } },
      { id: 'beta-only', platform: 'beta', limits: { rpm: null, rpd: null } },
    ],
  }

  const alphaKey = store.addKey('alpha', 'alpha-key')
  store.addKey('beta', 'beta-key')

  // Spend 130 requests on alpha: 20% of its 150 budget is gone, so 20 remain of
  // 150 — above the 10% percentage rule and on a window below the absolute
  // floor, so this must NOT warn.
  for (let i = 0; i < 130; i += 1) store.record('alpha', alphaKey, 'alpha-big', 3, NOW)
  const frozen = JSON.stringify(store.state)

  const rates = { alpha: { requests: 30, perMinute: 3 }, beta: { requests: 0, perMinute: 0 } }
  const forecast = buildForecast({
    store,
    catalog,
    burnRate: platform => rates[platform] ?? { requests: 0, perMinute: 0 },
    now: NOW,
  })

  const alpha = forecast.platforms.alpha
  assert.ok(alpha, 'alpha must appear in the forecast')
  assert.equal(alpha.requestsToday, 130, 'today\'s requests read from the store')
  assert.equal(alpha.tokensToday, 390, 'today\'s tokens read from the store')
  assert.equal(alpha.dailyRequestBudget, 150, 'budget is the sum of every published rpd (100 + 50)')
  assert.equal(alpha.remainingRequests, 20, 'remaining is budget minus today\'s use')
  assert.equal(alpha.burnRatePerMinute, 3, 'burn rate comes from the injected source')
  assert.equal(alpha.recentRequests, 30, 'the raw window count is reported alongside the rate')
  // 20 / 3 = 6.666... -> rounded to 2dp by the module.
  assert.equal(alpha.runwayMinutes, 6.67, 'runway is remaining over rate, rounded to 2dp')
  assert.equal(alpha.lowBalance, false, '20% of a 150 window is not low')
  ok('budget: rpd summed across models, unknown rpd contributes nothing')

  // A platform whose provider published no rpd at all must report null, not 0.
  const beta = forecast.platforms.beta
  assert.ok(beta, 'beta must appear in the forecast')
  assert.equal(beta.dailyRequestBudget, null, 'no published rpd means an unknown budget')
  assert.equal(beta.remainingRequests, null, 'unknown budget means unknown remaining')
  assert.equal(beta.runwayMinutes, null, 'unknown remaining means no runway')
  assert.equal(beta.lowBalance, false, 'an unknown budget is never a low balance')
  assert.equal(beta.reason, 'unlimited or unknown')
  ok('unknown budget: null budget/remaining/runway, never a false warning')

  // The forecast must be a pure read. It feeds a panel that can re-render at
  // any time, and durable accounting is the source of truth for routing.
  assert.equal(JSON.stringify(store.state), frozen, 'buildForecast must not mutate the store')
  const reread = store.platformUsageToday('alpha', NOW)
  assert.equal(reread.requests, 130, 'usage after the forecast is unchanged')
  ok('purity: buildForecast leaves the store byte-for-byte unchanged')

  // ── buildForecast: a zero rate is "unknown pace", not "infinite runway" ────
  const negativeRates = forecast.platforms.alpha
  const zeroRate = buildForecast({
    store,
    catalog,
    burnRate: () => ({ requests: 0, perMinute: 0 }),
    now: NOW,
  })
  assert.equal(zeroRate.platforms.alpha.burnRatePerMinute, 0)
  assert.equal(zeroRate.platforms.alpha.runwayMinutes, null, 'zero rate must yield a null runway, never Infinity')
  assert.equal(negativeRates.runwayMinutes, 6.67, 'a real rate still produces a runway')
  ok('zero burn rate: runwayMinutes is null (unknown), not Infinity')

  // A missing burn source is the same honest degradation as a zero reading.
  const noSource = buildForecast({ store, catalog, now: NOW })
  assert.equal(noSource.platforms.alpha.burnRatePerMinute, 0)
  assert.equal(noSource.platforms.alpha.runwayMinutes, null)
  assert.equal(noSource.platforms.alpha.requestsToday, 130, 'the rest of the forecast still works without a rate source')
  ok('missing burn source: degrades to rate 0 and null runway, other fields intact')

  // A rate that overstates the remaining balance clamps to an exhausted window
  // rather than a negative runway.
  const exhausted = buildForecast({
    store,
    catalog,
    burnRate: () => ({ requests: 50, perMinute: 5 }),
    now: NOW,
  })
  assert.equal(exhausted.platforms.alpha.remainingRequests, 20)
  assert.equal(exhausted.platforms.alpha.runwayMinutes, 4)
  ok('runway: remaining 20 at 5/min is 4 minutes')

  // A projection that runs past the end of the day is NOT reported. A daily
  // budget refills at midnight, so "20 left at 0.01/min = 2000 minutes" is
  // arithmetically true and practically meaningless: nobody can spend tomorrow's
  // window today, and the figure reads as "plenty" when the honest answer is
  // "you cannot exhaust it before it resets". Upstream returns null here too.
  {
    const slow = buildForecast({
      store,
      catalog,
      burnRate: () => ({ requests: 1, perMinute: 0.01 }),
      now: NOW,
    })
    const row = slow.platforms.alpha
    assert.ok(row.remainingRequests !== null, 'the balance itself is still reported')
    assert.equal(
      row.runwayMinutes,
      null,
      `a projection past the day boundary must be withheld, got ${row.runwayMinutes}`,
    )
    ok('runway: a projection past the day boundary is withheld rather than clamped')
  }

  // The boundary is "before midnight UTC", so the same balance and rate DO
  // produce a number when the day is nearly over. Without this case the null
  // above could come from a broken projection rather than from the cap.
  {
    const lateNow = Math.floor(NOW / 86_400_000) * 86_400_000 + 86_400_000 - 3 * 60_000
    const late = buildForecast({
      store,
      catalog,
      burnRate: () => ({ requests: 40, perMinute: 10 }),
      now: lateNow,
    })
    assert.equal(late.platforms.alpha.runwayMinutes, 2, 'a runway inside the remaining day is reported')
    ok('runway: a projection inside the remaining day is still reported')
  }

  // Over-spending the published budget (provider kept accepting, or the rpd is
  // stale) must not produce a negative remaining or a negative runway.
  const overKey = store.addKey('gamma', 'gamma-key')
  const overCatalog = { modelIds: () => [{ id: 'gamma-1', platform: 'gamma', limits: { rpd: 10 } }] }
  for (let i = 0; i < 12; i += 1) store.record('gamma', overKey, 'gamma-1', 1, NOW)
  const over = buildForecast({
    store,
    catalog: overCatalog,
    burnRate: () => ({ requests: 6, perMinute: 1 }),
    now: NOW,
  })
  assert.equal(over.platforms.gamma.requestsToday, 12)
  assert.equal(over.platforms.gamma.dailyRequestBudget, 10)
  assert.equal(over.platforms.gamma.remainingRequests, 0, 'remaining clamps at zero')
  assert.equal(over.platforms.gamma.runwayMinutes, 0, 'an exhausted window has no runway')
  assert.equal(over.platforms.gamma.lowBalance, true, 'zero remaining is low on any window')
  ok('over-budget: remaining clamps at zero, runway is zero, low balance')

  // ── cleanup ────────────────────────────────────────────────────────────────
  emptyStore.close()
  store.close()
  for (const target of [emptyDir, dir]) fs.rmSync(target, { recursive: true, force: true })

  console.log(`\n${checks} checks passed`)
  console.log('forecast checks passed')
}

try {
  main()
} catch (error) {
  console.error('FORECAST FAILED:', error)
  process.exitCode = 1
}
