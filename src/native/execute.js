/**
 * One HTTP attempt against one platform endpoint.
 *
 * Kept separate from the router so the two failure surfaces stay distinct:
 * this module only reports "did the request start, and if not, why"; deciding
 * what that means for the key pool is the router's job.
 *
 * @module src/native/execute.js
 */

// @ts-check

import { authorizationHeader } from './auth.js'

/** Read at most a few hundred bytes of an error body for the message. */
async function errorText(response) {
  try {
    const text = await response.text()
    return text.slice(0, 600)
  } catch {
    return ''
  }
}

/**
 * Start one streamed chat completion.
 *
 * Resolves as soon as the response headers arrive. A non-2xx becomes
 * `{ ok: false }` carrying the status, `Retry-After` and a short message; the
 * caller decides whether to bench the key.
 *
 * @param {{
 *   endpoint: string,
 *   apiKey: string,
 *   body: Record<string, unknown>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   extraHeaders?: Record<string, string>,
 * }} input
 * @returns {Promise<{ ok: true, stream: ReadableStream<Uint8Array> } | { ok: false, status: number, message: string, retryAfter: string | null }>}
 */
export async function executeOnce(input) {
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 120_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout

  const url = `${input.endpoint.replace(/\/+$/, '')}/chat/completions`
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    ...(input.extraHeaders ?? {}),
  }
  // What `no-key` means on the wire is not uniform: most keyless providers want
  // no header at all, while AI Horde rejects the absence of one. `auth.js` owns
  // that distinction — assuming "omit" cost AI Horde's whole catalog.
  Object.assign(headers, authorizationHeader(input.platform ?? '', input.apiKey))

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal,
    })
  } catch (error) {
    const aborted = input.signal?.aborted === true
    return {
      ok: false,
      status: aborted ? 499 : 0,
      message: aborted ? 'request aborted' : `transport: ${error?.message ?? error}`,
      retryAfter: null,
    }
  }

  if (!response.ok || !response.body) {
    const detail = await errorText(response)
    return {
      ok: false,
      status: response.status,
      message: detail === '' ? `HTTP ${response.status}` : detail,
      retryAfter: response.headers.get('retry-after'),
    }
  }

  return { ok: true, stream: response.body }
}
