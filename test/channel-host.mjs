/**
 * Tests for the account-channel host decision.
 *
 * The rule this pins is a coexistence requirement, not a feature: this plugin
 * must work on a machine that has never seen a channel pack, and must not fight
 * a machine that already runs one. Getting it wrong is expensive in both
 * directions —
 *
 *   * mounting when another plugin already has the pack throws
 *     `service "codeartsAuth" has been registered`, and the failure lands during
 *     `apply`, so the user sees a broken plugin rather than a channel page;
 *   * refusing to mount on a clean machine means the thirteen channels silently
 *     never exist, with nothing in the UI to explain it.
 *
 * So the detection is tested directly, including the shapes `ctx.get()` actually
 * returns when a service is absent or unresolvable.
 *
 * Run: node test/channel-host.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  detectPackOwner,
  createChannelStatus,
  PACK_SERVICES,
  PACK_ROUTES,
} from '../src/native/channel-host.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// ── a clean machine must be seen as clean ───────────────────────────────────
{
  const result = detectPackOwner({ get: () => undefined })
  assert.equal(result.owned, false, 'a composition without the pack is not an owner')
  assert.equal(result.service, null)
}
console.log('ok  a clean composition reports no owner')

// ── another plugin owning the service must be detected ──────────────────────
for (const service of PACK_SERVICES) {
  const ctx = { get: (name) => (name === service ? { some: 'handle' } : undefined) }
  const result = detectPackOwner(ctx)
  assert.equal(result.owned, true, `owning "${service}" must be detected`)
  assert.equal(result.service, service, 'the owner must be named so the panel can say who')
}
console.log(`ok  every pack service is a detection trigger (${PACK_SERVICES.join(', ')})`)

// A mid-mount plugin has only reached its first service. Detection must not
// depend on the *last* one being present, or a race would slip through.
{
  const result = detectPackOwner({ get: (name) => (name === 'accountPool' ? {} : undefined) })
  assert.equal(result.owned, true, 'a half-mounted pack is still an owner')
}
console.log('ok  a partially mounted pack is still detected')

// ── the awkward shapes ctx.get() can return ─────────────────────────────────
{
  // An unresolvable name throws rather than returning undefined in some
  // compositions. That is the same answer for our purpose, and it must not
  // propagate: a throw during apply would take the router down with it.
  assert.doesNotThrow(() => detectPackOwner({ get: () => { throw new Error('unknown service') } }))
  assert.equal(detectPackOwner({ get: () => { throw new Error('unknown service') } }).owned, false)

  // A service registered as null is not an owner either.
  assert.equal(detectPackOwner({ get: () => null }).owned, false)
  assert.equal(detectPackOwner({ get: () => 0 }).owned, true, 'any non-null value counts as registered')

  // A ctx without `get` at all must not throw — that would be a composition this
  // plugin cannot inspect, and refusing to start is worse than not mounting.
  assert.doesNotThrow(() => detectPackOwner({}))
}
console.log('ok  throwing, null and missing get() are all handled without propagating')

// ── the status record is shared and mutable ─────────────────────────────────
{
  const holder = createChannelStatus()
  assert.equal(holder.snapshot().state, 'unavailable', 'the initial state is "nothing attempted"')
  assert.notEqual(holder.snapshot(), holder.status, 'snapshot must be detached, not the live object')

  holder.set({ state: 'ready', channels: 13 })
  const snap = holder.snapshot()
  assert.equal(snap.state, 'ready')
  assert.equal(snap.channels, 13)

  // Mutating the snapshot must not write back: the panel reads it over HTTP and
  // a leak there would let a request change plugin state.
  snap.state = 'tampered'
  assert.equal(holder.snapshot().state, 'ready', 'a snapshot must not be a live reference')
}
console.log('ok  the status holder mutates explicitly and snapshots are detached')

// ── the vendored files exist and are the expected pair ──────────────────────
{
  const root = path.join(here, '..', 'vendor', 'channel-pack')
  const pack = path.join(root, 'pack.js')
  const wasm = path.join(root, 'qoder-auth-wasm.wasm')
  const notice = path.join(root, 'NOTICE.md')
  const license = path.join(root, 'LICENSE')

  // The channel pack is NOT distributed with this repo (it embeds OAuth
  // client credentials). If it is missing, skip the file-existence checks
  // rather than failing the whole suite — the plugin works fine without it.
  if (!fs.existsSync(root)) {
    console.log('ok  vendor/channel-pack not present (expected in clean checkout); skipping file checks')
  } else {
    for (const file of [pack, wasm, notice, license]) {
      assert.ok(fs.existsSync(file), `vendor/channel-pack must ship ${path.basename(file)}`)
    }
    // The WASM must sit beside pack.js: the pack locates it by import.meta.url, so
    // moving it to another directory breaks Qoder without any error at load time.
    assert.equal(path.dirname(wasm), path.dirname(pack), 'the WASM must share pack.js\'s directory')
    assert.ok(fs.statSync(pack).size > 1_000_000, 'pack.js should be the real bundle, not a stub')
    console.log('ok  the vendored pack, its WASM sibling, licence and notice are present')

    // ── the notice carries the provenance a licence requires ────────────────────
    const noticeContent = fs.readFileSync(notice, 'utf8')
    assert.match(noticeContent, /gitee\.com/, 'the upstream repository must be named')
    assert.match(noticeContent, /MIT/, 'the licence must be stated')
    assert.match(noticeContent, /codeartsAuth/, 'the collision must be documented')
    console.log('ok  NOTICE.md records provenance, licence and the collision')
  }
}

// ── what a user is told depends on the state ────────────────────────────────
{
  // `owned` and `failed` call for different words: one means "someone else has
  // it, go there", the other means "this host cannot run it". Collapsing them
  // would send a user looking for a plugin that is not installed.
  const holder = createChannelStatus()
  const states = ['ready', 'owned', 'disabled', 'unavailable', 'failed']
  for (const state of states) {
    holder.set({ state })
    assert.equal(holder.snapshot().state, state)
  }
  console.log('ok  all five host states round-trip')
}

console.log('\nchannel-host checks passed')