/**
 * Region and permission classification for upstream failures.
 *
 * The naive reading of HTTP is "401/403 means the credential is bad", and it is
 * wrong for several of these providers. Google in particular answers:
 *
 *   * `400 INVALID_ARGUMENT` / `API_KEY_INVALID`  -> the key really is bad;
 *   * `403 PERMISSION_DENIED` / `SERVICE_DISABLED` -> API not enabled;
 *   * `403 PERMISSION_DENIED`                      -> IP / referrer restriction;
 *   * `400 FAILED_PRECONDITION`                    -> "User location is not supported".
 *
 * The last two mean the *same key* would work from another network. Treating
 * them as a bad credential benches a working key for a day, and the user sees a
 * provider they configured simply stop being used, with no explanation. The
 * upstream project shipped exactly that bug and documented the correction; this
 * module is that lesson applied here.
 *
 * So a failure is classified along two independent axes:
 *
 *   `outcome`  — what to do with the key: `ok`, `transient`, `invalid`, `region`;
 *   `region`   — whether the model is unreachable from this network.
 *
 * A `region` verdict never benches the key. It marks the model route as
 * unavailable from here, which is something the router can route around and the
 * panel can explain.
 *
 * @module src/native/region.js
 */

// @ts-check

/**
 * @typedef {'ok' | 'transient' | 'invalid' | 'region'} FailureOutcome
 *
 * @typedef {object} Classification
 * @property {FailureOutcome} outcome
 * @property {boolean} region    true when the failure is location-scoped
 * @property {string} reason     short human label, for logs and the panel
 */

/** Provider wording that means "not from where you are". */
const REGION_PATTERNS = [
  /user location is not supported/i,
  /location is not supported/i,
  /not available in your (region|country|location)/i,
  /unsupported (region|country|location)/i,
  /service is not available in your/i,
  /country, territory, or region/i,
  /geo[- ]?(blocked|restricted)/i,
]

/** Wording that means the credential itself is rejected. */
const CREDENTIAL_PATTERNS = [
  /api[_ ]key[_ ]invalid/i,
  /api key not valid/i,
  /api key expired/i,
  /invalid api key/i,
  /incorrect api key/i,
  /invalid[_ ]token/i,
  /unauthorized/i,
  /authentication (failed|error|required)/i,
  /missing authorization/i,
]

/** Wording that means the account lacks access — not a region problem. */
const PERMISSION_PATTERNS = [
  /permission[_ ]denied/i,
  /service[_ ]disabled/i,
  /api (is )?not enabled/i,
  /does not have permission/i,
  /insufficient (permission|scope|quota)/i,
  /forbidden/i,
]

function matches(patterns, text) {
  return patterns.some(pattern => pattern.test(text))
}

/**
 * Classify one failed upstream response.
 *
 * @param {{ status?: number, message?: string, headers?: Record<string, string> }} failure
 * @returns {Classification}
 */
export function classifyFailure(failure) {
  const status = Number(failure?.status ?? 0)
  const message = typeof failure?.message === 'string' ? failure.message : ''
  const retryAfter = failure?.headers?.['retry-after'] ?? null

  // A transport failure (status 0) says nothing about the credential.
  if (status === 0) {
    return { outcome: 'transient', region: false, reason: 'transport error' }
  }

  if (status === 429) {
    return { outcome: 'transient', region: false, reason: 'rate limited' }
  }
  if (status >= 500) {
    return { outcome: 'transient', region: false, reason: `upstream ${status}` }
  }
  if (status === 408 || status === 504) {
    return { outcome: 'transient', region: false, reason: `upstream ${status}` }
  }

  // Region first: a region message can arrive with 400, 403, or 451.
  if (matches(REGION_PATTERNS, message)) {
    return { outcome: 'region', region: true, reason: 'not available from this location' }
  }
  if (status === 451) {
    return { outcome: 'region', region: true, reason: 'unavailable for legal reasons' }
  }

  if (status === 401) {
    return { outcome: 'invalid', region: false, reason: 'credential rejected' }
  }

  if (status === 403) {
    // 403 is ambiguous on purpose. Only the wording separates "bad key" from
    // "this network is not allowed", and getting it wrong is expensive in both
    // directions: benching a good key hides a working provider for a day, while
    // retrying a genuinely bad key burns an attempt on every call.
    if (matches(CREDENTIAL_PATTERNS, message)) {
      return { outcome: 'invalid', region: false, reason: 'credential rejected' }
    }
    if (matches(PERMISSION_PATTERNS, message)) {
      return { outcome: 'invalid', region: false, reason: 'permission denied on this account' }
    }
    return { outcome: 'invalid', region: false, reason: `forbidden (${status})` }
  }

  if (status === 400 || status === 422) {
    // A 400 carrying credential wording is Google's bad-key shape.
    if (matches(CREDENTIAL_PATTERNS, message)) {
      return { outcome: 'invalid', region: false, reason: 'credential rejected' }
    }
    return { outcome: 'ok', region: false, reason: 'request rejected upstream' }
  }

  void retryAfter
  return { outcome: 'ok', region: false, reason: `unclassified ${status}` }
}

/**
 * Should the caller stop the whole call rather than try the next candidate?
 *
 * Only for a malformed request: every other provider would reject the same
 * bytes identically, so walking the pool just costs time and quota.
 *
 * @param {Classification} classification
 * @param {boolean} carriesTools
 */
export function isFatal(classification, carriesTools) {
  // A tool-carrying 400 may mean this model cannot do tools, which is a
  // property of the model, not the request — so it fails over.
  if (carriesTools && classification.outcome === 'ok') return false
  return classification.outcome === 'ok'
}
