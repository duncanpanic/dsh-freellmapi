/**
 * Offline tests for active region probing.
 *
 * Everything here runs through an injected `fetchImpl`; `globalThis.fetch` is
 * never touched. That is not tidiness — the module's whole contract is "observe
 * without changing anything", and a test that swapped the global would not be
 * able to prove the probe refrained from recording usage, benching a key or
 * writing state, because the same global is what a stray side effect would
 * reach for.
 *
 * The cases pinned here are the ones that fail *quietly*:
 *
 *   * Google's region block arrives as 400, the same status as a bad API key.
 *     Read the status instead of the wording and the sweep marks every working
 *     key unauthorized — which is the exact bug `region.js` was written to stop,
 *     re-introduced from the probing side;
 *   * a probe that bills the free tier, or benches a key on a transient 429, is
 *     worse than no probe: it makes the feature that reports availability the
 *     reason availability was lost.
 *
 * Run: node test/region-probe.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { probeRegion, summarizeProbe, PROBE_DEFAULTS } from '../src/native/region-probe.js'
import { StateStore } from '../src/native/store.js'

/** Build a stub target. */
const target = (platform, modelId = `${platform}-model`, baseURL = `https://${platform}.test/v1`, apiKey = 'k') =>
  ({ platform, modelId, baseURL, apiKey })

/** A fetch stub that answers with a fixed JSON error body. */
function stub(status, message, { headers = {} } = {}) {
  return async () => new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

async function main() {
  // ── the four verdicts, from one sweep ──────────────────────────────────────
  // The region case is Google's real shape: 400 + "User location is not
  // supported for the API use.", not a 403 or a 451.
  const single = async (fetchImpl, extra = {}) => {
    const results = await probeRegion({
      targets: [target('google')],
      fetchImpl,
      timeoutMs: 1_000,
      ...extra,
    })
    assert.equal(results.length, 1, 'one target must yield exactly one row')
    return results[0]
  }

  {
    const result = await single(stub(400, 'User location is not supported for the API use.'))
    assert.equal(result.status, 'region', `region block classified "${result.status}"`)
    assert.equal(result.platform, 'google')
    assert.equal(result.modelId, 'google-model', 'the row must carry modelId')
    assert.equal(result.statusCode, 400, 'an arrived response must report its status code')
    assert.ok(result.detail.length > 0, 'a detail line is required')
  }
  console.log('ok  400 "User location is not supported" -> region')

  {
    const result = await single(stub(401, 'Incorrect API key provided'))
    assert.equal(result.status, 'unauthorized', `bad key classified "${result.status}"`)
    assert.equal(result.statusCode, 401)
  }
  console.log('ok  401 "Incorrect API key" -> unauthorized')

  {
    const result = await single(stub(500, 'internal error'))
    assert.equal(result.status, 'error', `5xx classified "${result.status}"`)
    assert.equal(result.statusCode, 500)
  }
  console.log('ok  500 -> error')

  {
    const result = await single(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    assert.equal(result.status, 'reachable', `2xx classified "${result.status}"`)
    assert.equal(result.statusCode, 200)
  }
  console.log('ok  200 -> reachable')

  // The 403 split: the same status is a region block or a dead credential
  // depending only on the wording, so both shapes must land on different rows.
  {
    const region = await single(stub(403, 'This service is not available in your region.'))
    assert.equal(region.status, 'region')
    const credential = await single(stub(403, 'Forbidden'))
    assert.equal(credential.status, 'unauthorized')
  }
  console.log('ok  403 splits on wording, not status')

  // ── a thrown fetch is a row, not a crash ───────────────────────────────────
  {
    const results = await probeRegion({
      targets: [target('a'), target('b')],
      fetchImpl: async () => { throw new TypeError('fetch failed') },
      timeoutMs: 1_000,
    })
    assert.equal(results.length, 2, 'a thrown transport error must still produce rows')
    for (const result of results) {
      assert.equal(result.status, 'error')
      assert.match(result.detail, /transport: fetch failed/, `detail should carry the cause: ${result.detail}`)
      assert.equal(result.statusCode, undefined, 'a request that never started has no status code')
    }
  }
  console.log('ok  a thrown fetch becomes an error row and the sweep still resolves')

  // ── minimal request shape and the no-key sentinel ──────────────────────────
  {
    /** @type {Array<{ url: string, init: any }>} */
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, init })
      return new Response('{}', { status: 200 })
    }
    await probeRegion({
      targets: [target('keyless', 'm', 'https://keyless.test/v1/', 'no-key')],
      fetchImpl,
      timeoutMs: 1_000,
    })

    assert.equal(seen.length, 1)
    const { url, init } = seen[0]
    assert.equal(url, 'https://keyless.test/v1/chat/completions', 'trailing slash must not double up')

    // Case-insensitive lookup: the module writes lowercase, but a stub should
    // not depend on which spelling the implementation picked.
    const headerNames = Object.keys(init.headers).map(name => name.toLowerCase())
    assert.ok(!headerNames.includes('authorization'), `no-key must omit Authorization, got ${headerNames.join(', ')}`)
    assert.equal(headerNames.filter(name => name === 'authorization').length, 0)
    assert.equal(init.headers['content-type'], 'application/json')

    const body = JSON.parse(init.body)
    assert.equal(body.model, 'm', 'the request must name the model under test')
    assert.equal(body.stream, false)
    // 16, not 1. AI Horde rejects anything below 16 with a 400, and the probe
    // cannot tell that 400 from a malformed request — it reported the platform
    // as `error` on every sweep. The ceiling that matters is "one word of
    // output", not "one token".
    assert.equal(body.max_tokens, 16, 'a probe must be the smallest request every platform accepts')
    assert.ok(body.max_tokens < 32, 'a probe must stay far below a real completion')
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
    assert.equal(init.method, 'POST')
  }
  console.log('ok  minimal body, and "no-key" omits the Authorization header')

  // A real key must still be sent, or every authenticated probe would 401.
  {
    let seenAuth = null
    await probeRegion({
      targets: [target('authed', 'm', 'https://authed.test/v1', 'secret-key')],
      fetchImpl: async (url, init) => {
        const names = Object.keys(init.headers)
        seenAuth = init.headers[names.find(name => name.toLowerCase() === 'authorization')]
        return new Response('{}', { status: 200 })
      },
      timeoutMs: 1_000,
    })
    assert.equal(seenAuth, 'Bearer secret-key')
  }
  console.log('ok  a real key is sent as a bearer token')

  // ── concurrency is a ceiling, and it is actually used ─────────────────────
  {
    let inFlight = 0
    let peak = 0
    const fetchImpl = async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 20))
      inFlight -= 1
      return new Response('{}', { status: 200 })
    }

    const targets = Array.from({ length: 12 }, (_, i) => target(`p${i}`))
    const results = await probeRegion({ targets, fetchImpl, concurrency: 3, timeoutMs: 5_000 })

    assert.equal(results.length, 12)
    assert.ok(peak <= 3, `at most 3 requests may overlap, saw ${peak}`)
    // A sequential implementation would also satisfy "<=", so assert the pool
    // was genuinely parallel: with 12 targets and 3 workers, at least 3 overlap.
    assert.ok(peak >= 3, `concurrency should be used, peak was only ${peak}`)
    assert.equal(inFlight, 0, 'every request must settle')
    assert.ok(results.every(result => result.status === 'reachable'))
  }
  console.log('ok  at most `concurrency` requests are in flight at once')

  // Order is part of the contract: results[i] describes targets[i].
  {
    const targets = [target('slow', 'slow-model'), target('fast', 'fast-model'), target('mid', 'mid-model')]
    const delays = { slow: 30, fast: 1, mid: 10 }
    const fetchImpl = async url => {
      const name = String(url).split('//')[1].split('.')[0]
      await new Promise(resolve => setTimeout(resolve, delays[name]))
      return new Response('{}', { status: 200 })
    }
    const results = await probeRegion({ targets, fetchImpl, concurrency: 4, timeoutMs: 5_000 })
    assert.deepEqual(results.map(result => result.platform), ['slow', 'fast', 'mid'], 'results must keep input order')
    assert.deepEqual(results.map(result => result.modelId), ['slow-model', 'fast-model', 'mid-model'])
  }
  console.log('ok  results keep the input order despite uneven completion')

  // A fetch stub that behaves like a real one: it only settles when the request
  // signal aborts, and it rejects with that signal's own reason.
  //
  // The ref'd timer stands in for the socket a real `fetch` holds open. This is
  // not decoration: `AbortSignal.timeout`'s timer is unref'd, so with nothing
  // else pending Node drains the event loop and exits *before* the timeout can
  // fire — the stub would look like a module that ignores its timeout, and the
  // conclusion would be about the harness rather than the probe.
  const hungFetch = () => (url, init) => new Promise((resolve, reject) => {
    void url
    void resolve
    const socket = setTimeout(() => {}, 60_000)
    init.signal.addEventListener('abort', () => {
      clearTimeout(socket)
      reject(init.signal.reason ?? new Error('aborted'))
    })
  })

  // ── the signal is honoured ─────────────────────────────────────────────────
  {
    const controller = new AbortController()
    const probe = probeRegion({
      targets: [target('a'), target('b'), target('c')],
      signal: controller.signal,
      // A target that settles only once aborted: without signal support this
      // sweep would sit until the per-request timeout instead of returning at
      // the moment the caller gave up.
      fetchImpl: hungFetch(),
      concurrency: 4,
      timeoutMs: 10_000,
    })
    // The sweep attaches its abort listeners synchronously, so this cancels the
    // in-flight requests; the remaining targets are cancelled before they start.
    controller.abort()

    const results = await probe
    assert.equal(results.length, 3, 'a cancelled sweep still reports every target')
    assert.ok(results.every(result => result.status === 'error'), 'cancelled targets are errors, not exceptions')
    assert.ok(results.every(result => /cancelled/.test(result.detail)), `detail should say why: ${results.map(r => r.detail).join(' | ')}`)
  }
  console.log('ok  aborting the sweep resolves with cancelled rows instead of throwing')

  // Each request carries its own timeout, independent of the caller's signal.
  {
    const started = Date.now()
    const results = await probeRegion({
      targets: [target('blackhole')],
      // Never answers, and never touches the network: only the timeout baked
      // into the request signal can end this, so a missing
      // `AbortSignal.any([signal, AbortSignal.timeout(...)])` hangs the sweep.
      fetchImpl: hungFetch(),
      timeoutMs: 150,
    })
    const elapsed = Date.now() - started
    // `timeout`, not `error`: a provider that queues this network behind paying
    // traffic is not broken, and reporting it as failed invites the user to
    // remove a working provider. AI Horde's anonymous tier measured over 60s
    // for a one-word answer while genuine failures answer in milliseconds.
    assert.equal(results[0].status, 'timeout', 'a hung target must time out, not hang the sweep')
    assert.match(results[0].detail, /within 150ms/, `detail should name the ceiling: ${results[0].detail}`)
    assert.ok(elapsed < 3_000, `the per-request timeout must be near 150ms, took ${elapsed}ms`)

    // A timeout must be counted apart from a failure, or the summary tells the
    // reader that a slow-but-working provider is broken.
    const summary = summarizeProbe(results)
    assert.equal(summary.slow, 1, 'a timeout belongs in `slow`')
    assert.equal(summary.failed, 0, 'a timeout is not a failure')
    assert.equal(summary.reachable + summary.slow + summary.failed, summary.total, 'the counts must add up')
  }
  console.log('ok  every request carries its own timeout, counted apart from failures')

  // ── empty input ────────────────────────────────────────────────────────────
  {
    assert.deepEqual(await probeRegion({ targets: [], fetchImpl: stub(500, 'x') }), [])
    assert.deepEqual(await probeRegion({ fetchImpl: stub(500, 'x') }), [], 'a missing targets list is empty, not a crash')
  }
  console.log('ok  empty targets -> []')

  // ── fetchImpl is genuinely optional ────────────────────────────────────────
  // Production calls this with no `fetchImpl`, so the default must reach the
  // real `fetch` — and must still come back as a row. `.invalid` is reserved by
  // RFC 2606 and never resolves, so this stays offline while exercising the
  // exact call shape the integration uses.
  {
    const results = await probeRegion({
      targets: [target('unresolvable', 'm', 'https://probe-does-not-exist.invalid/v1', 'k')],
      timeoutMs: 5_000,
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].status, 'error', `a real-but-unreachable host is an error row, got "${results[0].status}"`)
    assert.ok(results[0].detail.length > 0, 'even a DNS failure must explain itself')
    assert.equal(results[0].statusCode, undefined, 'no response means no status code')
  }
  console.log('ok  omitting fetchImpl falls back to the real global fetch')

  // ── probing is a pure observation ──────────────────────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-probe-'))
    const store = new StateStore({ dir })
    try {
      const platform = 'probed'
      const keyId = store.addKey(platform, 'live-key')
      const model = 'probed-model'
      // Seed usage so a probe that recorded anything would be visible against a
      // non-zero baseline rather than merely against zero.
      store.record(platform, keyId, model, 42)
      const before = store.usageOf(platform, keyId, model)
      const entryBefore = { ...store.entries(platform)[0] }

      const key = store.secretOf(platform, keyId)
      assert.equal(key, 'live-key')

      const results = await probeRegion({
        targets: [
          { platform, modelId: model, baseURL: 'https://probed.test/v1', apiKey: key },
          { platform, modelId: model, baseURL: 'https://probed.test/v1', apiKey: key },
        ],
        // One success and one 400-region: neither outcome may touch the store.
        fetchImpl: (() => {
          let call = 0
          return async () => {
            call += 1
            return call === 1
              ? new Response('{}', { status: 200 })
              : new Response(JSON.stringify({ error: { message: 'User location is not supported' } }), { status: 400 })
          }
        })(),
        timeoutMs: 1_000,
      })

      assert.equal(results[0].status, 'reachable')
      assert.equal(results[1].status, 'region')

      assert.deepEqual(store.usageOf(platform, keyId, model), before, 'a probe must not record usage')
      assert.equal(store.usageOf(platform, keyId, model).requests, 1, 'the seeded request must be the only one')
      assert.equal(store.usageOf(platform, keyId, model).tokens, 42)

      const entryAfter = store.entries(platform)[0]
      assert.equal(entryAfter.status, entryBefore.status, 'a probe must not bench or validate a key')
      assert.equal(entryAfter.cooldownUntil, entryBefore.cooldownUntil, 'a probe must not cool a key down')
      assert.equal(entryAfter.lastError, entryBefore.lastError, 'a probe must not write an error onto the key')
      assert.equal(store.platforms().length, 1, 'a probe must not invent platforms')
      assert.equal(store.secretOf(platform, keyId), 'live-key', 'a probe must not rewrite the secret')

      // Nothing was flushed, so the on-disk state must not have been touched.
      const stateFile = path.join(dir, 'state.json')
      if (fs.existsSync(stateFile)) {
        const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        assert.ok(!('probed' in (onDisk.keys ?? {})) || onDisk.keys.probed.length === 1)
      }
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  console.log('ok  probing leaves the store untouched (no usage, no bench, no state write)')

  // ── summarizeProbe ─────────────────────────────────────────────────────────
  {
    const results = [
      { platform: 'a', modelId: 'a1', status: 'reachable', detail: '' },
      { platform: 'b', modelId: 'b1', status: 'region', detail: '' },
      { platform: 'b', modelId: 'b2', status: 'region', detail: '' },
      { platform: 'c', modelId: 'c1', status: 'unauthorized', detail: '' },
      { platform: 'd', modelId: 'd1', status: 'error', detail: '' },
      { platform: 'e', modelId: 'e1', status: 'timeout', detail: '' },
    ]
    const summary = summarizeProbe(results)

    assert.deepEqual(summary.regionBlocked, [
      { platform: 'b', modelId: 'b1' },
      { platform: 'b', modelId: 'b2' },
    ], 'regionBlocked must pair platform with modelId, in order')
    assert.equal(summary.reachable, 1)
    assert.equal(summary.slow, 1, 'a timeout is counted separately from a failure')
    assert.equal(summary.failed, 4, 'unauthorized, error and region all count as failed')
    assert.equal(summary.total, 6)
    assert.equal(
      summary.reachable + summary.slow + summary.failed,
      summary.total,
      'the three counts must add up',
    )

    // Only region rows are "blocked from here"; unauthorized and error are not.
    assert.ok(summary.regionBlocked.every(row => row.platform !== 'c' && row.platform !== 'd'))
  }
  console.log('ok  summarizeProbe groups counts and region-blocked targets')

  {
    const empty = summarizeProbe([])
    assert.deepEqual(empty, { regionBlocked: [], reachable: 0, slow: 0, failed: 0, total: 0 })
    assert.deepEqual(summarizeProbe(undefined), { regionBlocked: [], reachable: 0, slow: 0, failed: 0, total: 0 })
  }
  console.log('ok  summarizeProbe on an empty sweep')

  // A default sweep must stay within the documented time ceiling; this also
  // pins that the defaults are exported and sane.
  {
    assert.ok(PROBE_DEFAULTS.timeoutMs > 0 && PROBE_DEFAULTS.concurrency >= 1)
    const results = await probeRegion({
      targets: [target('defaulted')],
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    assert.equal(results[0].status, 'reachable')
  }
  console.log('ok  defaults apply when timeoutMs and concurrency are omitted')

  console.log('\nregion-probe checks passed')
}

main().catch(error => {
  console.error('REGION PROBE FAILED:', error)
  process.exitCode = 1
})
