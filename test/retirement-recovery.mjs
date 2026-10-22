/**
 * Tests for model retirement and empty-turn recovery.
 *
 * Both features can do real damage when they misfire, and neither crashes when
 * it does: a wrong retirement silently deletes a working model from the pool,
 * and a wrong recovery duplicates output or double-executes a tool. So the
 * negative cases — what must NOT trigger — carry as much weight here as the
 * positive ones.
 *
 * Run: node test/retirement-recovery.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  RetirementRegistry,
  retirementSignal,
  CONFIRMATIONS_REQUIRED,
  OBSERVATION_WINDOW_MS,
} from '../src/native/retirement.js'
import { recoveryPolicy, canRecover, recoveryMessages, RECOVERY_DEFAULTS } from '../src/native/recovery.js'
import { StateStore } from '../src/native/store.js'
import { QuotaTracker } from '../src/native/quota.js'
import { Router } from '../src/native/router.js'
import { NativeRouterAdapter } from '../src/native/native-adapter.js'

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function tmpFile(name = 'retired.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-retire-'))
  return { file: path.join(dir, name), dir }
}

/** An SSE body that streams reasoning then finishes with no answer text. */
function silentStopBody(reasoning = 'thinking hard...', finish = 'stop') {
  const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
  return frame({ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } })
    + 'data: [DONE]\n\n'
}

/**
 * The shape observed live: the whole output budget goes to hidden reasoning and
 * the turn ends on `length` with an empty body. The user sees "the model said
 * nothing", which is the case recovery exists for — and the one the peer
 * implementation's `sawText` guard skips.
 */
function budgetEatenBody() {
  const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
  return frame({ choices: [{ index: 0, delta: { reasoning_content: 'very long silent thinking' } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 19, completion_tokens: 64, total_tokens: 83 } })
    + 'data: [DONE]\n\n'
}

/** An SSE body that streams a real answer. */
function answerBody(text = 'the answer') {
  const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
  return frame({ choices: [{ index: 0, delta: { content: text } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })
    + 'data: [DONE]\n\n'
}

function sseResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

// ════════════════════════════════════════════════════════════════════════════
// Part 1 — retirement signal grading
// ════════════════════════════════════════════════════════════════════════════

// 410 is definitive on its own: the status itself means "gone".
assert.equal(retirementSignal({ status: 410, message: 'Gone' }), 'definitive')
assert.equal(retirementSignal({ status: 410, message: '' }), 'definitive')
console.log('ok  410 is definitive on its own')

// A not-found status carrying end-of-life wording is definitive.
assert.equal(
  retirementSignal({ status: 404, message: 'minimaxai/minimax-m2.7 has reached its end of life and is no longer available' }),
  'definitive',
)
console.log('ok  end-of-life wording on a 404 is definitive')

// The trap the upstream project documented: a 429 or 500 whose BODY mentions a
// retirement must not count. Status has to agree the model is absent.
for (const status of [429, 500, 503]) {
  assert.equal(
    retirementSignal({ status, message: 'quota exceeded; see notice: model X has reached its end of life' }),
    null,
    `status ${status} with EOL wording must teach nothing`,
  )
}
console.log('ok  EOL wording on a 429/500/503 does not retire a live model')

// A bare 404 with model-gone wording is only probable: one flaky 404 from a
// load balancer must be corroborated.
assert.equal(retirementSignal({ status: 404, message: 'model not found' }), 'probable')
assert.equal(retirementSignal({ status: 404, message: 'unknown model' }), 'probable')
console.log('ok  a bare not-found is only probable')

// 451 is a legal/region matter, owned by region.js — never a retirement.
assert.equal(retirementSignal({ status: 451, message: 'Unavailable for legal reasons' }), null)
// A plain 400 is the request's fault.
assert.equal(retirementSignal({ status: 400, message: 'invalid tool schema' }), null)
assert.equal(retirementSignal({ status: 200, message: '' }), null)
console.log('ok  451 and plain 400 are not retirements')

// ════════════════════════════════════════════════════════════════════════════
// Part 2 — the registry: corroboration, persistence, reversal
// ════════════════════════════════════════════════════════════════════════════
{
  const { file, dir } = tmpFile()
  const registry = new RetirementRegistry({ file })

  // Definitive retires immediately, no corroboration.
  assert.equal(registry.note('p', 'm', { status: 410, message: 'Gone' }), true)
  assert.equal(registry.isRetired('p', 'm'), true)
  console.log('ok  a definitive signal retires on the spot')

  // Probable needs CONFIRMATIONS_REQUIRED distinct requests.
  const registry2 = new RetirementRegistry({ file: path.join(dir, 'r2.json') })
  for (let i = 1; i < CONFIRMATIONS_REQUIRED; i++) {
    assert.equal(registry2.note('q', 'n', { status: 404, message: 'model not found' }, `req-${i}`), false)
    assert.equal(registry2.isRetired('q', 'n'), false, `retired too early after ${i}`)
  }
  assert.equal(registry2.note('q', 'n', { status: 404, message: 'model not found' }, `req-${CONFIRMATIONS_REQUIRED}`), true)
  assert.equal(registry2.isRetired('q', 'n'), true)
  console.log(`ok  a probable signal waits for ${CONFIRMATIONS_REQUIRED} distinct requests`)

  // The same request failing over across sibling keys is ONE observation.
  const registry3 = new RetirementRegistry({ file: path.join(dir, 'r3.json') })
  for (let i = 0; i < CONFIRMATIONS_REQUIRED + 3; i++) {
    assert.equal(registry3.note('s', 'x', { status: 404, message: 'model not found' }, 'same-request'), false,
      'one request must not corroborate itself')
  }
  assert.equal(registry3.isRetired('s', 'x'), false)
  console.log('ok  one request across sibling keys cannot corroborate itself')

  // Persistence: a retirement survives a restart, because it is a fact about
  // the world, not session state.
  const before = new RetirementRegistry({ file })
  before.note('persist', 'mdl', { status: 410, message: 'gone' })
  const after = new RetirementRegistry({ file })
  assert.equal(after.isRetired('persist', 'mdl'), true, 'a retirement must survive a restart')
  assert.ok(after.list().some(row => row.platform === 'persist'), 'it must appear in the list')
  // And the entry written by the earlier registry in this block is still there,
  // proving the file accumulates rather than being overwritten.
  assert.equal(after.isRetired('p', 'm'), true, 'earlier retirements must not be dropped')
  console.log('ok  retirements persist across a restart')

  // Reversal.
  assert.equal(after.lift('persist', 'mdl'), true)
  assert.equal(after.isRetired('persist', 'mdl'), false)
  assert.equal(new RetirementRegistry({ file }).isRetired('persist', 'mdl'), false, 'the lift must persist too')
  console.log('ok  a retirement can be lifted, and the lift persists')

  for (const target of [file, path.join(dir, 'r2.json'), path.join(dir, 'r3.json'), dir]) {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Part 3 — recovery policy and messages
// ════════════════════════════════════════════════════════════════════════════
{
  const policy = recoveryPolicy(undefined)
  assert.equal(policy.enabled, true, 'recovery is on by default')
  assert.equal(policy.totalTimeoutMs, RECOVERY_DEFAULTS.totalTimeoutMs)

  // A hand-edited config cannot raise a ceiling.
  const raised = recoveryPolicy({ totalTimeoutMs: 999_999_999 })
  assert.equal(raised.totalTimeoutMs, RECOVERY_DEFAULTS.totalTimeoutMs, 'ceiling must hold')

  assert.equal(recoveryPolicy(false).enabled, false)
  assert.equal(recoveryPolicy({ enabled: false }).enabled, false)
  console.log('ok  recovery policy caps hand-edited values')
}

{
  const policy = recoveryPolicy(undefined)
  // Recovery requires nothing delivered.
  assert.equal(canRecover({ sawText: false, sawToolCall: false }, policy, 0), true)
  assert.equal(canRecover({ sawText: true, sawToolCall: false }, policy, 0), false, 'text already delivered')
  assert.equal(canRecover({ sawText: false, sawToolCall: true }, policy, 0), false, 'a tool already ran')
  // A disabled policy never recovers, and a spent window is closed.
  assert.equal(canRecover({ sawText: false, sawToolCall: false }, recoveryPolicy(false), 0), false)
  assert.equal(canRecover({ sawText: false, sawToolCall: false }, policy, policy.totalTimeoutMs + 1), false)
  console.log('ok  recovery is refused once output landed, the policy is off, or time is up')
}

{
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'explain X' }] }]
  const withDraft = recoveryMessages(messages, 'partial reasoning about X')
  const withoutDraft = recoveryMessages(messages, '   ')
  assert.equal(withDraft.length, 2)
  assert.ok(withDraft[1].content[0].text.includes('partial reasoning about X'), 'the draft must be carried')
  assert.ok(withDraft[1].content[0].text.includes('Do not call tools'), 'tools must be refused')
  // An empty checkpoint must not inject an empty JSON blob.
  assert.ok(!withoutDraft[1].content[0].text.includes('Interrupted draft'), 'no draft means no draft block')
  assert.ok(withoutDraft[1].content[0].text.includes('spent its entire output budget'), 'the empty case is explained')
  console.log('ok  continuation messages carry the draft and refuse tools')
}

// ════════════════════════════════════════════════════════════════════════════
// Part 4 — end to end through the adapter
// ════════════════════════════════════════════════════════════════════════════
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-e2e-'))
  const store = new StateStore({ dir })
  const quota = new QuotaTracker(store)
  const router = new Router({ store, quota })
  const retirement = new RetirementRegistry({ file: path.join(dir, 'retired.json') })
  store.addKey('pp', 'k')

  const model = { platform: 'pp', id: 'mm', name: 'M', tools: false, limits: {} }
  const adapter = new NativeRouterAdapter({
    store, router, quota, retirement,
    resolve: () => [model],
    platforms: () => ({ pp: { baseURL: 'https://pp.test/v1' } }),
  })

  const realFetch = globalThis.fetch
  let calls = 0

  // ── silent stop, then a real answer on the retry ──────────────────────────
  calls = 0
  globalThis.fetch = async () => { calls += 1; return sseResponse(calls === 1 ? silentStopBody() : answerBody('recovered answer')) }
  try {
    const chunks = await collect(adapter.stream({
      provider: 'x', model: 'mm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    }))
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(text, 'recovered answer', 'the retry must deliver the answer')
    assert.equal(calls, 2, 'exactly one retry')
    assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
    console.log('ok  a silent stop is recovered by one retry')
  } finally { globalThis.fetch = realFetch }

  // ── silent stop twice: report it rather than return an empty success ──────
  calls = 0
  globalThis.fetch = async () => { calls += 1; return sseResponse(silentStopBody()) }
  try {
    const chunks = await collect(adapter.stream({
      provider: 'x', model: 'mm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    }))
    assert.equal(calls, 2, 'at most one retry — never an unbounded loop')
    const finish = chunks[chunks.length - 1]
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'EMPTY_AFTER_RECOVERY')
    console.log('ok  two silent stops become an explicit error, not an empty success')
  } finally { globalThis.fetch = realFetch }

  // ── budget eaten by reasoning, ending on `length` with an empty body ──────
  // This is the shape observed live, and the reason recovery does not require
  // a `stop` finish: the caller sees an empty turn either way.
  calls = 0
  globalThis.fetch = async () => { calls += 1; return sseResponse(calls === 1 ? budgetEatenBody() : answerBody('answer after budget recovery')) }
  try {
    const chunks = await collect(adapter.stream({
      provider: 'x', model: 'mm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    }))
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(text, 'answer after budget recovery', 'a budget-eaten turn must be recovered too')
    assert.equal(calls, 2)
    console.log('ok  a budget-eaten empty turn is recovered')
  } finally { globalThis.fetch = realFetch }

  // ── a visible answer that merely ends on `length` is NOT retried ──────────
  // This is the case the guard must protect: the user already has text, so a
  // continuation would duplicate it.
  calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
    return sseResponse(
      frame({ choices: [{ index: 0, delta: { content: 'partial answer' } }] })
      + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
      + 'data: [DONE]\n\n',
    )
  }
  try {
    const chunks = await collect(adapter.stream({
      provider: 'x', model: 'mm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    }))
    assert.equal(calls, 1, 'a turn that already produced text must not be re-asked')
    assert.equal(chunks[chunks.length - 1].reason.kind, 'max-tokens')
    console.log('ok  a truncated-but-visible answer is left alone')
  } finally { globalThis.fetch = realFetch }

  // ── a normal answer is never retried ──────────────────────────────────────
  calls = 0
  globalThis.fetch = async () => { calls += 1; return sseResponse(answerBody('fine')) }
  try {
    const chunks = await collect(adapter.stream({
      provider: 'x', model: 'mm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    }))
    assert.equal(calls, 1, 'a working model must not pay for a retry')
    assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
    console.log('ok  a normal answer is not retried')
  } finally { globalThis.fetch = realFetch }

  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── a 410 retires the route so the next call never dials it ────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-ret-'))
  const store = new StateStore({ dir })
  const quota = new QuotaTracker(store)
  const router = new Router({ store, quota })
  const retirement = new RetirementRegistry({ file: path.join(dir, 'retired.json') })
  store.addKey('pp', 'k')

  const gone = { platform: 'pp', id: 'dead', name: 'Dead', tools: false, limits: {} }
  const alive = { platform: 'pp', id: 'live', name: 'Live', tools: false, limits: {} }
  const adapter = new NativeRouterAdapter({
    store, router, quota, retirement,
    resolve: () => [gone, alive],
    platforms: () => ({ pp: { baseURL: 'https://pp.test/v1' } }),
  })

  const realFetch = globalThis.fetch
  const dialed = []
  globalThis.fetch = async (url, init) => {
    const model = JSON.parse(init.body).model
    dialed.push(model)
    if (model === 'dead') {
      return new Response(JSON.stringify({ error: { message: 'Model has reached its end of life' } }), { status: 410 })
    }
    return sseResponse(answerBody('served by live'))
  }

  try {
    const first = await collect(adapter.stream({
      provider: 'x', model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    }))
    assert.equal(first[first.length - 1].reason.kind, 'stop')
    assert.ok(retirement.isRetired('pp', 'dead'), 'the 410 must retire the model')
    assert.deepEqual(dialed, ['dead', 'live'], 'first call tried the dead model once')

    dialed.length = 0
    const second = await collect(adapter.stream({
      provider: 'x', model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }] }],
    }))
    assert.equal(second[second.length - 1].reason.kind, 'stop')
    assert.deepEqual(dialed, ['live'], 'the retired model must not be dialed again')
    console.log('ok  a 410 retires the route and later calls skip it entirely')
  } finally {
    globalThis.fetch = realFetch
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\nretirement-recovery checks passed')
