/**
 * Active region probing: ask the question before the user pays for the answer.
 *
 * Region detection used to be passive. A provider that serves nothing from this
 * network was only ever discovered when a real request failed, and the cost of
 * that discovery lands on the user: the first call to a region-blocked model
 * burns an attempt and a slot in the failover walk, and a model whose every
 * platform is blocked surfaces as a generic "no route" rather than "not
 * reachable from here". The router also learns it one target at a time, so a
 * fresh install with a Google key pasted in happily offers a whole menu of
 * models that cannot answer from this network at all.
 *
 * This module asks the question directly — one minimal request per target,
 * concurrently — so the panel can show the truth before anything is routed.
 *
 * Three things it deliberately does NOT do, because each one would turn an
 * observation into a side effect:
 *
 *   * it does not record usage. A health check that spends the user's daily
 *     free-tier budget is a health check that cannot be run often, and the
 *     whole point is to run it without thinking;
 *   * it does not bench or cool down a key. A probe that races a provider's
 *     transient 429 would hide a working key for a day — precisely the bug
 *     `region.js` exists to prevent, told to the router from the other end;
 *   * it does not modify any state at all. `probeRegion` takes no store, so the
 *     guarantee is structural rather than a matter of remembering not to call
 *     `patchKey`. State-free by construction survives future edits; a comment
 *     asking nicely does not.
 *
 * The verdict comes from `classifyFailure`, never from the status code alone.
 * Google answers a region block with `400 FAILED_PRECONDITION` and a dead key
 * with `400 API_KEY_INVALID` — same status, opposite meaning — so a
 * "400 means region" shortcut would mark working keys unauthorized, and a
 * "400 means bad request" reading would hide a permanently unreachable platform.
 * That distinction is already solved in `region.js`; re-deriving it here is how
 * two copies drift apart, so this module only maps its outcome onto a verdict.
 *
 * Concurrency is capped because the opposite is indistinguishable from abuse:
 * probing sixty platforms at once from one IP looks like a burst to every
 * provider, and their rate limiter answers 429, which this module would report
 * as `error` — poisoning the very measurement it set out to take.
 *
 * @module src/native/region-probe.js
 */

// @ts-check

import { classifyFailure } from './region.js'
import { authorizationHeader } from './auth.js'

/** What one probe concluded. */
/**
 * @typedef {'reachable' | 'region' | 'unauthorized' | 'error'} ProbeStatus
 *
 * @typedef {object} ProbeTarget
 * @property {string} platform
 * @property {string} modelId
 * @property {string} baseURL
 * @property {string} apiKey
 *
 * @typedef {object} ProbeResult
 * @property {string} platform
 * @property {string} modelId
 * @property {ProbeStatus} status
 * @property {string} detail             short human-readable reason
 * @property {number} [statusCode]       present only when a response arrived
 */

export const PROBE_DEFAULTS = Object.freeze({
  /**
   * Per-request ceiling, deliberately far below `execute.js`'s 120s generation
   * budget. A probe wants one token back; a route that has not answered in eight
   * seconds is a route the sweep should report and move past, not one it should
   * wait two minutes for. With a black-holed network and no cap of its own, a
   * sixty-target sweep would take two hours to say nothing.
   */
  timeoutMs: 8_000,
  /** Requests in flight at once. */
  concurrency: 4,
  /** Hard ceiling, so a hand-edited config cannot stampede every provider. */
  maxConcurrency: 32,
})

/**
 * The smallest request that still reaches the model-selection code upstream.
 *
 * 16, not 1. AI Horde rejects anything below 16 with a 400
 * (`params.max_length: '1 is less than the minimum of 16'`), and because the
 * classifier reads a bare 400 as "the request was malformed" it reported that
 * platform as `error` on every sweep — indistinguishable from a genuine
 * failure, and it hid the fact that the probe was working. Sixteen tokens is
 * still one word of output.
 */
const PROBE_MAX_TOKENS = 16

/** How much of an error body to keep for the classifier and the detail line. */
const SNIPPET_CHARS = 600

/** Collapse whitespace so a multi-line HTML error page stays one short line. */
function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** Length floor for a detail line, so the panel never shows an empty reason. */
function shortDetail(text, fallback) {
  const value = oneLine(text)
  return value === '' ? fallback : value.slice(0, 200)
}

/**
 * Read at most `cap` characters of a response body, then drop the rest.
 *
 * `execute.js` reads the whole error body and slices, which is fine for one
 * interactive request. A sweep is not one interactive request: a proxy that
 * answers with a megabyte of HTML for every target would have that whole page
 * buffered sixty times over, and we only need the wording — the classifier
 * matches a handful of short phrases. So the reader stops early and cancels.
 *
 * @param {Response} response
 * @param {number} cap
 */
async function readSnippet(response, cap = SNIPPET_CHARS) {
  const body = response?.body
  if (!body) {
    // A bodyless response (a 204, or a stub without a stream): fall back to text.
    try {
      return oneLine(String(await response.text())).slice(0, cap)
    } catch {
      return ''
    }
  }

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let text = ''
  try {
    while (text.length < cap) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) text += decoder.decode(value, { stream: true })
    }
  } catch {
    // The connection died mid-body. Keep whatever arrived; the status code is
    // usually enough to classify, and a body we cannot finish reading is not a
    // reason to turn a diagnosable failure into an exception.
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
  return oneLine(text).slice(0, cap)
}

/** Build one result row, attaching a status code only when there is one. */
function row(platform, modelId, status, detail, statusCode) {
  /** @type {ProbeResult} */
  const result = { platform, modelId, status, detail }
  if (Number.isFinite(statusCode)) result.statusCode = /** @type {number} */ (statusCode)
  return result
}

/**
 * Probe exactly one target. Never throws; every outcome is a row.
 *
 * @param {ProbeTarget} target
 * @param {{ signal: AbortSignal | null, timeoutMs: number, send: typeof fetch }} context
 * @returns {Promise<ProbeResult>}
 */
async function probeOne(target, context) {
  const platform = typeof target?.platform === 'string' ? target.platform : ''
  const modelId = typeof target?.modelId === 'string' ? target.modelId : ''
  const baseURL = typeof target?.baseURL === 'string' ? target.baseURL.trim() : ''
  const apiKey = typeof target?.apiKey === 'string' ? target.apiKey : ''
  const { signal, timeoutMs, send } = context

  // Cancelled before this target's turn. Reporting an error row rather than
  // dropping the target keeps the result index-aligned with the input, which is
  // what lets the caller pair a verdict with the target it came from.
  if (signal?.aborted === true) {
    return row(platform, modelId, 'error', 'cancelled before the probe was sent')
  }
  // A target with no endpoint or no model id cannot even be addressed. Sending
  // `model: ''` would come back 400 and be classified as a malformed request,
  // which is a misleading label for "this row was never configured".
  if (baseURL === '') return row(platform, modelId, 'error', 'no baseURL configured')
  if (modelId === '') return row(platform, modelId, 'error', 'no model id configured')

  // The timeout is the probe's own, not the caller's: `AbortSignal.any` makes
  // the request die at whichever comes first, so an aborted sweep stops at once
  // while a single black-holed target cannot hold a worker slot forever.
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' }
  // Delegate to the shared projection rather than repeating the rule: what
  // `no-key` means on the wire differs per platform (most keyless providers omit
  // the header, AI Horde requires its documented anonymous one), and a second
  // copy of that logic is how the probe and the request path drift apart.
  Object.assign(headers, authorizationHeader(platform, apiKey))

  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: 'hi' }],
    // One token, one word of input: enough to exercise authentication, region
    // gating and model resolution, small enough that a sweep costs nothing worth
    // accounting for. This is also why the probe never reports usage — the
    // request is not a conversation and must not consume a conversation's quota.
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
  })

  /** @type {Response} */
  let response
  try {
    response = await send(url, { method: 'POST', headers, body, signal: combined })
  } catch (error) {
    // Order matters: when a sweep is cancelled the caller's reason is the useful
    // one, even though the per-request timeout may have fired in the same tick.
    if (signal?.aborted === true) {
      return row(platform, modelId, 'error', 'cancelled while the probe was in flight')
    }
    if (timeout.aborted || /** @type {any} */ (error)?.name === 'TimeoutError') {
      // Reported as `timeout`, not `error`. Latency here is queueing rather than
      // generation, and the slowest tier queues longest: AI Horde's anonymous
      // access is its lowest priority and measured over 60s for a one-word
      // answer, while a genuine failure answers in milliseconds. Folding the two
      // together tells the user a working provider is broken.
      return row(platform, modelId, 'timeout', `no response within ${timeoutMs}ms`)
    }
    return row(platform, modelId, 'error', `transport: ${/** @type {any} */ (error)?.message ?? error}`)
  }

  // 2xx is the only evidence that both the credential and the location were
  // accepted. The body is not parsed: this is a reachability check, not a
  // completion, and reading the payload would only tempt someone into recording
  // the usage it reports.
  if (response.ok) {
    try {
      await response.body?.cancel()
    } catch {
      /* nothing to release */
    }
    return row(platform, modelId, 'reachable', `HTTP ${response.status}`, response.status)
  }

  const snippet = await readSnippet(response)
  const verdict = classifyFailure({ status: response.status, message: snippet })
  const reason = shortDetail(snippet, verdict.reason)

  // `outcome === 'ok'` means the request was malformed rather than the
  // credential or the location being wrong, and the spec maps everything that is
  // neither region nor invalid onto `error`.
  if (verdict.outcome === 'region') {
    return row(platform, modelId, 'region', `${verdict.reason}: ${reason}`, response.status)
  }
  if (verdict.outcome === 'invalid') {
    return row(platform, modelId, 'unauthorized', `${verdict.reason}: ${reason}`, response.status)
  }
  return row(platform, modelId, 'error', `${verdict.reason} (HTTP ${response.status}): ${reason}`, response.status)
}

/** Coerce a caller-supplied concurrency into a usable worker count. */
function workerCount(requested, targetCount) {
  const value = Number(requested)
  const limit = Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), PROBE_DEFAULTS.maxConcurrency)
    : PROBE_DEFAULTS.concurrency
  return Math.max(1, Math.min(limit, targetCount))
}

/**
 * Probe every target, at most `concurrency` at a time.
 *
 * Resolves with one row per target, in the input's order — a caller that maps
 * `targets[i]` to a platform panel row must not have to re-key the results.
 * This function never rejects: a cancelled sweep, a DNS failure, a hung socket
 * and a 500 all become rows, because the caller's job is to render a table, not
 * to handle a probe exception.
 *
 * @param {{
 *   targets: ProbeTarget[],
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   concurrency?: number,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<ProbeResult[]>}
 */
export async function probeRegion(input) {
  const targets = Array.isArray(input?.targets) ? input.targets : []
  if (targets.length === 0) return []

  const timeoutMs = Number.isFinite(input?.timeoutMs) && Number(input.timeoutMs) > 0
    ? Number(input.timeoutMs)
    : PROBE_DEFAULTS.timeoutMs
  const signal = input?.signal && typeof input.signal.aborted === 'boolean' ? input.signal : null
  const send = typeof input?.fetchImpl === 'function' ? input.fetchImpl : globalThis.fetch
  const workers = workerCount(input?.concurrency, targets.length)

  /** @type {ProbeResult[]} */
  const results = new Array(targets.length)
  /** @type {number} */
  let cursor = 0

  // A work-stealing cursor instead of slicing the input into fixed batches: a
  // batch of four that finishes unevenly (one slow target, three fast) would
  // leave slots idle, and the whole reason to probe concurrently is to collapse
  // the sweep into roughly one timeout rather than N of them.
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= targets.length) return
      const target = targets[index]
      try {
        results[index] = await probeOne(target, { signal, timeoutMs, send })
      } catch (error) {
        // `probeOne` is written not to throw. If it ever does, the caller asked
        // for one row per target and must still get one.
        const platform = typeof target?.platform === 'string' ? target.platform : ''
        const modelId = typeof target?.modelId === 'string' ? target.modelId : ''
        results[index] = row(platform, modelId, 'error', `probe failed: ${/** @type {any} */ (error)?.message ?? error}`)
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, worker))
  return results
}

/**
 * Group probe rows for the panel.
 *
 * `reachable + failed + slow === total` always holds, so a partly-cancelled
 * sweep still adds up. `slow` is counted separately from `failed` because the
 * two call for different responses from the reader: a timeout means the provider
 * is queueing this network behind paying traffic (AI Horde's anonymous tier is
 * its lowest priority), while an error means it is actually broken. Reporting
 * both as "failed" invites someone to remove a provider that works.
 *
 * `regionBlocked` is the actionable subset: those are the targets whose *only*
 * problem is this network, so the panel can say "not from here" instead of
 * "broken".
 *
 * @param {readonly ProbeResult[]} results
 * @returns {{ regionBlocked: Array<{ platform: string, modelId: string }>, reachable: number, slow: number, failed: number, total: number }}
 */
export function summarizeProbe(results) {
  const rows = Array.isArray(results) ? results : []
  /** @type {Array<{ platform: string, modelId: string }>} */
  const regionBlocked = []
  let reachable = 0
  let slow = 0

  for (const result of rows) {
    if (result?.status === 'reachable') {
      reachable += 1
      continue
    }
    if (result?.status === 'timeout') {
      slow += 1
      continue
    }
    if (result?.status === 'region') {
      regionBlocked.push({ platform: result.platform, modelId: result.modelId })
    }
  }

  return {
    regionBlocked,
    reachable,
    slow,
    failed: rows.length - reachable - slow,
    total: rows.length,
  }
}
