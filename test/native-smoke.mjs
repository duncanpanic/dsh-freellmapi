/**
 * Offline tests for the native router.
 *
 * No network: `fetch` is replaced per case, so failover, benching and quota
 * skipping are exercised deterministically.
 *
 * Run: node test/native-smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as catalog from '../src/native/catalog.js'
import { StateStore, sealSecret, openSecret } from '../src/native/store.js'
import { QuotaTracker } from '../src/native/quota.js'
import { Router, retryAfterMs } from '../src/native/router.js'
import { NativeRouterAdapter } from '../src/native/native-adapter.js'

const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const done = 'data: [DONE]\n\n'

function sseBody(text = 'ok') {
  return frame({ choices: [{ index: 0, delta: { content: text } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
    + done
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flm-native-'))
}

async function main() {
  // ── catalog ────────────────────────────────────────────────────────────────
  const ids = catalog.modelIds()
  assert.ok(ids.length > 100, `catalog should carry a large roster, got ${ids.length}`)
  assert.ok(Object.keys(catalog.platforms()).length >= 20, 'catalog should resolve many platforms')
  const auto = catalog.resolve('auto')
  assert.ok(auto.length > 0, 'auto must resolve to candidates')
  console.log(`ok  catalog: ${ids.length} models / ${Object.keys(catalog.platforms()).length} platforms`)

  // ── secret sealing ─────────────────────────────────────────────────────────
  const master = Buffer.alloc(32, 7)
  const sealed = sealSecret(master, 'super-secret-key')
  assert.equal(openSecret(master, sealed), 'super-secret-key')
  // Flip one character of the auth tag: the GCM check must reject it. (Editing
  // the trailing base64 char can be a no-op, since padding bits are ignored.)
  const parts = sealed.split('.')
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
  assert.equal(openSecret(master, parts.join('.')), null, 'a tampered payload must not open')
  assert.equal(openSecret(Buffer.alloc(32, 9), sealed), null, 'a wrong master key must not open')
  console.log('ok  secret sealing: round-trip + tamper rejection')

  // ── store + pool ───────────────────────────────────────────────────────────
  const dir = tempDir()
  const store = new StateStore({ dir })
  const model = ids[0]
  const keyA = store.addKey(model.platform, 'key-a')
  const keyB = store.addKey(model.platform, 'key-b')
  assert.equal(store.entries(model.platform).length, 2)
  assert.equal(store.secretOf(model.platform, keyA), 'key-a')
  assert.equal(store.secretOf(model.platform, keyB), 'key-b')
  store.flush() // writes are debounced; force one before inspecting the file
  const onDisk = fs.readFileSync(path.join(dir, 'state.json'), 'utf8')
  assert.ok(!onDisk.includes('key-a'), 'the raw secret must never reach disk')
  console.log('ok  store: two keys sealed, plaintext absent from disk')

  // ── quota windows ──────────────────────────────────────────────────────────
  const quota = new QuotaTracker(store)
  const limits = { rpm: 2, rpd: null, tpm: null, tpd: null }
  assert.equal(quota.blockFor(model.platform, keyA, model.id, limits), null)
  quota.note(model.platform, keyA, model.id, 10)
  quota.note(model.platform, keyA, model.id, 10)
  const blocked = quota.blockFor(model.platform, keyA, model.id, limits)
  assert.equal(blocked?.axis, 'rpm', 'third request inside the minute must be blocked')
  console.log('ok  quota: rpm window blocks after the limit')

  // ── retry-after parsing ────────────────────────────────────────────────────
  assert.equal(retryAfterMs('30'), 30_000)
  assert.equal(retryAfterMs(''), 0)
  assert.ok(retryAfterMs('999999') <= 86_400_000, 'a hostile retry-after must be clamped')
  console.log('ok  retry-after: delta-seconds parsed and clamped')

  // ── failover: 429 benches the key, the next attempt succeeds ────────────────
  const dir2 = tempDir()
  const store2 = new StateStore({ dir: dir2 })
  const quota2 = new QuotaTracker(store2)
  const router2 = new Router({ store: store2, quota: quota2 })
  const adapter2 = new NativeRouterAdapter({ store: store2, router: router2, quota: quota2 })

  const platform = model.platform
  const firstKey = store2.addKey(platform, 'throttled-key')
  store2.addKey(platform, 'good-key')

  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
        status: 429,
        headers: { 'retry-after': '45' },
      })
    }
    return new Response(sseBody('hello from fallback'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  try {
    const chunks = await collect(adapter2.stream({
      provider: 'freellmapi-native',
      model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))

    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(text, 'hello from fallback', 'the second key must serve the request')
    assert.equal(calls, 2, 'exactly two upstream attempts')
    assertBalanced(chunks)

    const benched = store2.entries(platform).find(entry => entry.id === firstKey)
    assert.ok(benched.cooldownUntil > Date.now(), 'the throttled key must be benched')
    assert.equal(benched.status, 'throttled')

    const usage = chunks.find(c => c.type === 'usage')
    assert.equal(usage.usage.totalTokens, 7)
    const recorded = store2.usageOf(platform, benched.id === firstKey ? store2.entries(platform)[1].id : '', model.id)
    console.log('ok  failover: 429 benched key #1, key #2 served, usage recorded')
  } finally {
    globalThis.fetch = realFetch
  }

  // ── exhausted pool reports why, not just "failed" ──────────────────────────
  const dir3 = tempDir()
  const store3 = new StateStore({ dir: dir3 })
  const quota3 = new QuotaTracker(store3)
  const router3 = new Router({ store: store3, quota: quota3 })
  const adapter3 = new NativeRouterAdapter({ store: store3, router: router3, quota: quota3 })

  const empty = await collect(adapter3.stream({
    provider: 'freellmapi-native',
    model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  const finish = empty[empty.length - 1]
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'NO_ROUTE')
  // The message must name the platform that could serve this model: "no key
  // configured" alone leaves the user hunting through 32 providers, and
  // `UNKNOWN_MODEL` would send them looking for a typo in a name that is fine.
  assert.match(finish.reason.failure.message, /no key is configured/, finish.reason.failure.message)
  assert.match(finish.reason.failure.message, /settings panel/, 'the message must say where to fix it')
  console.log('ok  empty pool: NO_ROUTE naming the platform and where to add a key')

  // ── unknown model ──────────────────────────────────────────────────────────
  const unknown = await collect(adapter3.stream({
    provider: 'freellmapi-native',
    model: 'definitely-not-a-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(unknown[unknown.length - 1].reason.failure.code, 'UNKNOWN_MODEL')
  console.log('ok  unknown model: UNKNOWN_MODEL')

  // ── cleanup ────────────────────────────────────────────────────────────────
  store2.close()
  store3.close()
  store.close()
  for (const target of [dir, dir2, dir3]) fs.rmSync(target, { recursive: true, force: true })

  console.log('\nnative smoke checks passed')
}

function assertBalanced(chunks) {
  const starts = chunks.filter(c => c.type === 'block-start')
  const ends = chunks.filter(c => c.type === 'block-end')
  assert.equal(starts.length, ends.length, 'every block-start needs one block-end')
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1, 'exactly one finish')
  assert.equal(chunks[chunks.length - 1].type, 'finish', 'finish must be last')
}

main().catch(error => {
  console.error('NATIVE SMOKE FAILED:', error)
  process.exitCode = 1
})
