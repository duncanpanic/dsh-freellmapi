/**
 * Tests for tool-calling-aware routing.
 *
 * The three behaviours under test, all offline:
 *   1. a tools flag demotes but never drops;
 *   2. rejections accumulate per (platform, model) and defer only after the
 *      threshold, and only for tool-carrying requests;
 *   3. one success clears the accumulated suspicion.
 *
 * Run: node test/tool-routing.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore } from '../src/native/store.js'
import { QuotaTracker } from '../src/native/quota.js'
import { Router } from '../src/native/router.js'
import { NativeRouterAdapter } from '../src/native/native-adapter.js'
import {
  resetToolCapability,
  isToolDeferred,
  noteToolRejection,
  TOOL_REJECTION_LIMIT,
} from '../src/native/tool-capability.js'

const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const done = 'data: [DONE]\n\n'

function sse(text = 'ok') {
  return frame({ choices: [{ index: 0, delta: { content: text } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })
    + done
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-tools-'))
  return { store: new StateStore({ dir }), dir }
}

const TOOLS = [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }]

async function main() {
  resetToolCapability()

  // ── 1. the flag demotes, it does not filter ─────────────────────────────────
  {
    const { store, dir } = tempStore()
    const quota = new QuotaTracker(store)
    const router = new Router({ store, quota })

    // Build a synthetic candidate list: one flagged, one not, same platform.
    const flagged = { platform: 'p', id: 'flagged', name: 'Flagged', tools: true, limits: {} }
    const unflagged = { platform: 'p', id: 'unflagged', name: 'Unflagged', tools: false, limits: {} }
    store.addKey('p', 'k')

    const withTools = router.candidates([unflagged, flagged], { requireTools: true })
    assert.deepEqual(
      withTools.attempts.map(a => a.model),
      ['flagged', 'unflagged'],
      'a tool request must order the flagged model first',
    )
    assert.equal(withTools.attempts.length, 2, 'the unflagged model must still be reachable')

    const withoutTools = router.candidates([unflagged, flagged], { requireTools: false })
    assert.deepEqual(
      withoutTools.attempts.map(a => a.model),
      ['unflagged', 'flagged'],
      'a plain chat request must keep catalog order untouched',
    )

    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
    console.log('ok  tools flag demotes, never drops (plain chat untouched)')
  }

  // ── 2. deferral needs repeated evidence ─────────────────────────────────────
  {
    resetToolCapability()
    for (let i = 1; i < TOOL_REJECTION_LIMIT; i++) {
      noteToolRejection('p', 'm')
      assert.equal(isToolDeferred('p', 'm'), false, `deferred too early after ${i} rejection(s)`)
    }
    noteToolRejection('p', 'm')
    assert.equal(isToolDeferred('p', 'm'), true, `must defer at ${TOOL_REJECTION_LIMIT} rejections`)
    console.log(`ok  deferral waits for ${TOOL_REJECTION_LIMIT} rejections, then applies`)

    // ── 3. a success clears it ─────────────────────────────────────────────────
    const { clearToolRejections } = await import('../src/native/tool-capability.js')
    clearToolRejections('p', 'm')
    assert.equal(isToolDeferred('p', 'm'), false, 'a success must clear the deferral')
    console.log('ok  one success clears the deferral')
  }

  // ── 4. end to end: a tool request fails over past a tool-hostile model ──────
  {
    resetToolCapability()
    const { store, dir } = tempStore()
    const quota = new QuotaTracker(store)
    const router = new Router({ store, quota })

    const hostile = { platform: 'h', id: 'hostile', name: 'Hostile', tools: true, limits: {} }
    const good = { platform: 'g', id: 'good', name: 'Good', tools: false, limits: {} }
    store.addKey('h', 'kh')
    store.addKey('g', 'kg')

    // `hostile` is catalog-flagged for tools but 400s on them; `good` is not
    // flagged yet handles them. That is exactly the false-positive /
    // false-negative pair the ordering has to survive.
    const adapter = new NativeRouterAdapter({
      store,
      router,
      quota,
      resolve: () => [hostile, good],
      platforms: () => ({ h: { baseURL: 'https://host.test/v1' }, g: { baseURL: 'https://good.test/v1' } }),
    })

    const realFetch = globalThis.fetch
    const seen = []
    globalThis.fetch = async (url) => {
      const target = String(url)
      seen.push(target)
      if (target.includes('host.test')) {
        return new Response(JSON.stringify({ error: { message: 'this model does not support tools' } }), { status: 400 })
      }
      return new Response(sse('served by the tolerant model'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    try {
      // A tool-carrying request must reach the model that works.
      const chunks = await collect(adapter.stream({
        provider: 'freellmapi-native',
        model: 'anything',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read a file' }] }],
        tools: TOOLS,
      }))
      const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
      assert.equal(text, 'served by the tolerant model', 'the tool-capable model must serve the request')
      assert.deepEqual(
        seen.map(u => new URL(u).host),
        ['host.test', 'good.test'],
        'the flagged model is tried first, then the working one',
      )
      assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
      console.log('ok  tool request fails over from a tool-hostile model to a working one')

      // A plain chat request gets the catalog order and stops at the best one.
      // The stub must answer sane content here: `hostile` only rejects the
      // tool-carrying shape, which is the point of the distinction.
      seen.length = 0
      globalThis.fetch = async (url) => {
        const target = String(url)
        seen.push(target)
        return new Response(sse('plain answer'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      const chat = await collect(adapter.stream({
        provider: 'freellmapi-native',
        model: 'anything',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }))
      assert.equal(chat[chat.length - 1].reason.kind, 'stop')
      assert.equal(seen.length, 1, 'a plain chat request must not pay for the tool detour')
      console.log('ok  plain chat still takes the first candidate')

      // A non-tool 400 is the caller's fault and must stop the call, not walk
      // the whole pool.
      seen.length = 0
      globalThis.fetch = async (url) => {
        seen.push(String(url))
        return new Response(JSON.stringify({ error: { message: 'bad schema' } }), { status: 400 })
      }
      const bad = await collect(adapter.stream({
        provider: 'freellmapi-native',
        model: 'anything',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      }))
      assert.equal(bad[bad.length - 1].reason.failure.code, 'BAD_REQUEST')
      assert.equal(seen.length, 1, 'a malformed plain request must not try every model')
      console.log('ok  a non-tool 400 stops immediately instead of draining the pool')
    } finally {
      globalThis.fetch = realFetch
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\ntool-routing checks passed')
}

main().catch(error => {
  console.error('TOOL ROUTING FAILED:', error)
  process.exitCode = 1
})
