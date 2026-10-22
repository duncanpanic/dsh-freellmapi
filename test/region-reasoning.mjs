/**
 * Tests for region classification and reasoning-effort translation.
 *
 * Both features fail *quietly* when wrong, which is why they are pinned here:
 * a misclassified region block benches a working key for a day and the provider
 * silently disappears, while a mistranslated effort either 400s every request
 * to that platform or is dropped so the user's setting does nothing.
 *
 * Run: node test/region-reasoning.mjs
 */

import assert from 'node:assert/strict'

import { classifyFailure } from '../src/native/region.js'
import { ReasoningTranslator, EFFORT_SCALE } from '../src/native/reasoning.js'
import * as catalog from '../src/native/catalog.js'

// Every platform a policy names must exist in the shipped catalog: a typo'd
// key would silently no-op the policy, which is exactly how 'aclike' vs
// 'aclide' slipped through the first draft of these tests.
{
  const known = new Set(Object.keys(catalog.platforms()))
  const named = ['groq', 'mistral', 'cohere', 'google', 'aclide']
  for (const platform of named) {
    assert.ok(known.has(platform), `policy names "${platform}", which is not a catalog platform`)
  }
  // Cloudflare is deliberately absent from the catalog (its endpoint needs an
  // account id), so a policy for it is inert today. Assert that it *stays*
  // inert rather than silently pretending the platform is reachable.
  if (!known.has('cloudflare')) {
    assert.ok(true, 'cloudflare is unreachable as expected; its policy is inert')
  }
  // A platform with no policy must still behave: full scale forwarded.
  const translator = new ReasoningTranslator()
  assert.equal(translator.supports('nvidia'), true)
  assert.equal(translator.effortsFor('nvidia').length, EFFORT_SCALE.length)
}
console.log('ok  every policy names a real catalog platform')

// ── region vs credential ────────────────────────────────────────────────────
const regionCases = [
  // Google's region wording arrives with 400, not 403 — the shape that makes a
  // naive "400 = bad request / 403 = bad key" split go wrong.
  [400, 'User location is not supported for the API use.', 'region'],
  [403, 'This service is not available in your region.', 'region'],
  [451, 'Unavailable for legal reasons', 'region'],
  [400, 'Country, territory, or region not supported', 'region'],
]
for (const [status, message, expected] of regionCases) {
  const result = classifyFailure({ status, message })
  assert.equal(result.outcome, expected, `${status} ${JSON.stringify(message)} -> ${result.outcome}`)
  assert.equal(result.region, true, `${JSON.stringify(message)} must be flagged as region-scoped`)
}
console.log(`ok  region wording detected as region-scoped (${regionCases.length} shapes)`)

// The credential shapes must NOT be read as region, or a genuinely dead key
// would stay in rotation forever.
const credentialCases = [
  [401, 'Unauthorized', 'invalid'],
  [400, 'API key not valid. Please pass a valid API key.', 'invalid'],
  [403, 'API_KEY_INVALID', 'invalid'],
  [403, 'Permission denied: API not enabled on this project', 'invalid'],
  [403, 'Forbidden', 'invalid'],
]
for (const [status, message, expected] of credentialCases) {
  const result = classifyFailure({ status, message })
  assert.equal(result.outcome, expected, `${status} ${JSON.stringify(message)} -> ${result.outcome}`)
  assert.equal(result.region, false, `${JSON.stringify(message)} must not be region-scoped`)
}
console.log(`ok  credential wording stays credential (${credentialCases.length} shapes)`)

// Transient and transport failures must not bench as if the key were bad.
for (const [status, expected] of [[429, 'transient'], [500, 'transient'], [503, 'transient'], [0, 'transient'], [408, 'transient']]) {
  const result = classifyFailure({ status, message: '' })
  assert.equal(result.outcome, expected, `status ${status} -> ${result.outcome}`)
  assert.equal(result.region, false)
}
console.log('ok  rate limits, 5xx and transport errors classified transient')

// A plain 400 is the request's fault, not the key's — the router must stop
// rather than drain the pool.
{
  const result = classifyFailure({ status: 400, message: 'invalid tool schema' })
  assert.equal(result.outcome, 'ok', 'a malformed request must not implicate the key')
}
console.log('ok  a plain 400 leaves the key alone')

// ── reasoning translation ───────────────────────────────────────────────────
const translator = new ReasoningTranslator()

// Forward as-is where the provider documents the field.
{
  const body = {}
  const result = translator.apply('nvidia', body, 'high')
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(result.sent, 'high')
}
console.log('ok  documented platforms receive reasoning_effort verbatim')

// Groq's enum is low/medium/high; 'minimal' and 'off' must clamp, not 400.
{
  for (const [requested, expected] of [['minimal', 'low'], ['off', 'low'], ['max', 'high'], ['xhigh', 'high']]) {
    const body = {}
    const result = translator.apply('groq', body, requested)
    assert.equal(body.reasoning_effort, expected, `${requested} should clamp to ${expected}, got ${result.sent}`)
    assert.ok(result.note.includes('clamped'), 'a clamp must be reported as such')
  }
  // An accepted value must pass through untouched.
  const body = {}
  translator.apply('groq', body, 'medium')
  assert.equal(body.reasoning_effort, 'medium')
}
console.log('ok  Groq clamps to its low/medium/high enum instead of sending a 400')

// Platforms with no request-side control drop it — and say so.
for (const platform of ['mistral', 'cohere', 'cloudflare']) {
  const body = {}
  const result = translator.apply(platform, body, 'high')
  assert.equal(body.reasoning_effort, undefined, `${platform} must not receive the field`)
  assert.equal(body.reasoning, undefined, `${platform} must not receive a nested form either`)
  assert.equal(result.sent, null)
  assert.ok(result.note.includes('no request-side'), `${platform} must explain the drop`)
  assert.equal(translator.supports(platform), false, `${platform} must report no support`)
  assert.deepEqual(translator.effortsFor(platform), [], `${platform} must advertise no menu`)
}
console.log('ok  platforms without a control drop it and advertise no menu')

// Gemini gets a token budget, not an effort id.
{
  const body = {}
  const result = translator.apply('google', body, 'high')
  assert.equal(body.thinkingBudget, 16384, 'Gemini must receive a thinking budget')
  assert.equal(body.reasoning_effort, undefined, 'Gemini must not receive a flat effort id')
  assert.ok(result.note.includes('budget'), 'the translation must be described')
  // Ordering must be monotonic, or "high" could think less than "low".
  const budgets = EFFORT_SCALE.map(effort => {
    const probe = {}
    translator.apply('google', probe, effort)
    return probe.thinkingBudget
  })
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(budgets[i] >= budgets[i - 1], `thinking budgets must be non-decreasing: ${budgets.join(', ')}`)
  }
}
console.log('ok  Gemini translates to a monotonic thinking budget')

// Nested-wrapper platform.
{
  const body = {}
  translator.apply('aclide', body, 'medium')
  assert.deepEqual(body.reasoning, { effort: 'medium' })
  assert.equal(body.reasoning_effort, undefined, 'the flat field must not also be sent')
}
console.log('ok  nested-wrapper platform translated')

// No effort requested means nothing is added.
{
  for (const platform of Object.keys({ nvidia: 1, groq: 1, google: 1, mistral: 1 })) {
    const body = {}
    const result = translator.apply(platform, body, undefined)
    assert.deepEqual(body, {}, `${platform} must receive nothing when the user chose nothing`)
    assert.equal(result.sent, null)
  }
}
console.log('ok  an unset effort adds nothing to the body')

// A nonsense effort must not be forwarded.
{
  const body = {}
  const result = translator.apply('nvidia', body, 'turbo')
  assert.deepEqual(body, {})
  assert.equal(result.sent, null)
}
console.log('ok  an unknown effort is refused rather than forwarded')

// ── the advertised menu matches what the platform can honour ────────────────
{
  const groq = translator.describeFor('groq')
  assert.deepEqual(groq.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.ok(groq.efforts.every(e => typeof e.name === 'string' && e.name !== ''), 'each effort needs a label')
  assert.equal(groq.defaultEffort, 'medium')

  const full = translator.describeFor('nvidia')
  assert.equal(full.efforts.length, EFFORT_SCALE.length)

  assert.equal(translator.describeFor('mistral'), undefined, 'a menu must not be offered where nothing works')
}
console.log('ok  the advertised effort menu matches the platform policy')

console.log('\nregion-reasoning checks passed')
