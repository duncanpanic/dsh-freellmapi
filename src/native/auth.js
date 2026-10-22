/**
 * Per-platform credential projection.
 *
 * `no-key` is the sentinel for providers whose free tier needs no account. What
 * that means on the wire is **not uniform**, and assuming it is costs a whole
 * platform:
 *
 *   most keyless providers  omit the Authorization header entirely;
 *   AI Horde               requires the header and expects its documented
 *                          anonymous key — omitting it answers
 *                          401 "Authorization header missing", which reads like
 *                          a bad credential but is really "you forgot the key
 *                          that nobody issues".
 *
 * AI Horde's 32 models were silently unreachable here until a live region probe
 * surfaced the 401; the same omission existed in the request path, so real calls
 * were failing too, just less visibly (the router fell over to another
 * platform and the reason never reached the user).
 *
 * @module src/native/auth.js
 */

// @ts-check

/** The sentinel FreeLLMAPI stores for a platform that needs no real credential. */
export const KEYLESS = 'no-key'

/**
 * AI Horde's documented anonymous key.
 *
 * The upstream provider maps `no-key` (or an empty value) to this instead of
 * omitting the header: their gateway validates the header's presence before it
 * looks at anything else. A registered Horde key replaces it for higher queue
 * priority, which is why a real key must still pass through untouched.
 */
const AIHORDE_ANON_KEY = '0000000000'

/**
 * Platforms that answer an anonymous request but require the header to be
 * present, mapped to the value they expect.
 */
const ANON_BEARER = {
  aihorde: AIHORDE_ANON_KEY,
}

/**
 * Resolve the Authorization header value for one platform, or null to omit it.
 *
 * @param {string} platform
 * @param {string} apiKey the stored credential, possibly `no-key`
 * @returns {string | null} the bearer value, or null when the header must be
 *   omitted
 */
export function resolveAuthorization(platform, apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''

  // A real credential always wins, on every platform including AI Horde — a
  // registered key there means higher queue priority.
  if (key !== '' && key !== KEYLESS) return `Bearer ${key}`

  const anon = ANON_BEARER[platform]
  if (anon !== undefined) {
    // No stored key: use the documented anonymous one. A stored but real key
    // was already returned above, so reaching here means the anonymous path.
    return `Bearer ${anon}`
  }

  // Every other keyless platform rejects a bearer it never issued; omitting the
  // header is what makes an unauthenticated request succeed.
  return null
}

/**
 * Should this platform's requests carry an Authorization header at all?
 *
 * @param {string} platform
 * @param {string} apiKey
 */
export function authorizationHeader(platform, apiKey) {
  const value = resolveAuthorization(platform, apiKey)
  return value === null ? {} : { authorization: value }
}
