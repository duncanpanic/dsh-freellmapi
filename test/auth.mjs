/**
 * Tests for per-platform credential projection.
 *
 * This module exists because `no-key` does not mean one thing. Assuming it did
 * cost AI Horde's entire 32-model catalog: the request path and the region probe
 * both omitted the Authorization header, and AI Horde answers that with
 * `401 "Authorization header missing"` — which reads like a bad credential but
 * is really "you left out the key nobody issues". Anonymous access there is a
 * documented shared key, `0000000000`, not the absence of one.
 *
 * The distinction is invisible in a passing adapter test (the router just failed
 * over to another platform), so it is pinned here directly.
 *
 * Run: node test/auth.mjs
 */

import assert from 'node:assert/strict'

import { resolveAuthorization, authorizationHeader, KEYLESS } from '../src/native/auth.js'

// ── the keyless platforms that genuinely omit the header ────────────────────
for (const platform of ['kilo', 'ovh', 'llm7']) {
  assert.equal(
    resolveAuthorization(platform, KEYLESS),
    null,
    `${platform} rejects a bearer it never issued, so the header must be omitted`,
  )
  assert.deepEqual(authorizationHeader(platform, KEYLESS), {})
}
console.log('ok  keyless platforms that omit the header still omit it')

// ── AI Horde: the case that was broken ─────────────────────────────────────
assert.equal(
  resolveAuthorization('aihorde', KEYLESS),
  'Bearer 0000000000',
  'AI Horde requires its documented anonymous key, not an absent header',
)
assert.deepEqual(authorizationHeader('aihorde', KEYLESS), { authorization: 'Bearer 0000000000' })
console.log('ok  AI Horde sends its documented anonymous key')

// A registered Horde key must pass through untouched: it buys queue priority,
// so silently replacing it with the anonymous one would silently deprioritize
// everything the user configured.
assert.equal(resolveAuthorization('aihorde', 'real-horde-key'), 'Bearer real-horde-key')
console.log('ok  a registered Horde key is forwarded verbatim')

// ── real credentials win everywhere ─────────────────────────────────────────
for (const platform of ['groq', 'nvidia', 'aihorde', 'kilo']) {
  assert.equal(resolveAuthorization(platform, 'sk-real'), 'Bearer sk-real', `${platform} must forward a real key`)
}
console.log('ok  a real credential is forwarded on every platform')

// ── degenerate input ────────────────────────────────────────────────────────
{
  // An empty stored value is the same state as the sentinel: no credential.
  assert.equal(resolveAuthorization('kilo', ''), null)
  assert.equal(resolveAuthorization('aihorde', ''), 'Bearer 0000000000', 'an empty value still means anonymous')
  // Whitespace around a sentinel is still the sentinel.
  assert.equal(resolveAuthorization('kilo', `  ${KEYLESS}  `), null)
  assert.equal(resolveAuthorization('aihorde', `  ${KEYLESS}  `), 'Bearer 0000000000')
  // Non-string input must not throw.
  for (const bad of [null, undefined, 0, {}, []]) {
    assert.doesNotThrow(() => resolveAuthorization('aihorde', bad))
    assert.equal(resolveAuthorization('aihorde', bad), 'Bearer 0000000000')
    assert.doesNotThrow(() => resolveAuthorization('kilo', bad))
    assert.equal(resolveAuthorization('kilo', bad), null)
  }
  console.log('ok  empty, padded and non-string credentials resolve safely')
}

// ── an unknown platform is treated as the common case (omit) ────────────────
{
  // Unknown platforms get the majority behaviour. A future provider needing an
  // anonymous key must be added to the map deliberately rather than inheriting
  // a guess.
  assert.equal(resolveAuthorization('some-new-platform', KEYLESS), null)
  assert.equal(resolveAuthorization(undefined, KEYLESS), null)
  assert.equal(resolveAuthorization(undefined, 'sk-real'), 'Bearer sk-real')
  console.log('ok  an unknown platform falls back to omitting the header')
}

console.log('\nauth checks passed')
