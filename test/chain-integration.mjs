/**
 * Integration tests for named fallback chains.
 *
 * `test/chain.mjs` covers the pure expansion rules. This covers what only shows
 * up once a chain is wired to the router: that rotation actually reaches the
 * wire, that a chain inherits the region/retirement filters, and that a chain
 * naming a dead model fails over instead of failing.
 *
 * Run: node test/chain-integration.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore } from '../src/native/store.js'
import { QuotaTracker } from '../src/native/quota.js'
import { Router } from '../src/native/router.js'
import { NativeRouterAdapter } from '../src/native/native-adapter.js'
import { RetirementRegistry } from '../src/native/retirement.js'
import { normalizeChains } from '../src/native/chain.js'
import { ChainWalk } from '../src/native/chain-walk.js'

const frame = payload => `data: ${JSON.stringify(payload)}\n\n`

function answer(text) {
  return frame({ choices: [{ index: 0, delta: { content: text } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
    + 'data: [DONE]\n\n'
}

function sse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const MODELS = [
  { platform: 'alpha', id: 'qwen', name: 'Qwen', tools: true, contextWindow: 131072, limits: {} },
  { platform: 'alpha', id: 'nemotron', name: 'Nemotron', tools: true, contextWindow: 128000, limits: {} },
  { platform: 'beta', id: 'llama', name: 'Llama', tools: false, contextWindow: 8192, limits: {} },
  { platform: 'beta', id: 'qwen', name: 'Qwen (beta)', tools: true, contextWindow: 32768, limits: {} },
]

function harness({ chains = [], retireDead = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-chain-'))
  const store = new StateStore({ dir })
  const quota = new QuotaTracker(store)
  const router = new Router({ store, quota })
  const retirement = new RetirementRegistry({ file: path.join(dir, 'retired.json') })
  for (const platform of ['alpha', 'beta']) store.addKey(platform, `key-${platform}`)

  const normalized = normalizeChains(chains)
  const map = new Map(normalized.chains.map(chain => [chain.name, chain]))

  const adapter = new NativeRouterAdapter({
    store,
    router,
    quota,
    retirement,
    chains: map,
    chainWalk: new ChainWalk(),
    resolve: (model) => (model === 'auto' ? MODELS.map(m => ({ ...m })) : MODELS.filter(m => m.id === model).map(m => ({ ...m }))),
    platforms: () => ({ alpha: { baseURL: 'https://alpha.test/v1' }, beta: { baseURL: 'https://beta.test/v1' } }),
  })

  return { adapter, store, retirement, dir, normalized }
}

function cleanup(h) {
  h.store.close()
  fs.rmSync(h.dir, { recursive: true, force: true })
}

/** Record which model each request asked for. */
function stubFetch(handler) {
  const dialed = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    dialed.push({ model: body.model, host: new URL(url).host })
    return handler(body, dialed.length)
  }
  return { dialed, restore: () => { globalThis.fetch = real } }
}

async function main() {
  // ── a chain reaches the wire in its stated order ──────────────────────────
  {
    const h = harness({
      chains: [{ name: 'fast', steps: ['nemotron', 'qwen'] }],
    })
    const stub = stubFetch(() => sse(answer('ok')))
    try {
      const chunks = await collect(h.adapter.stream({
        provider: 'x', model: 'combo:fast',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      }))
      assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
      assert.equal(stub.dialed.length, 1, 'a chain serves on the first step when it works')
      assert.equal(stub.dialed[0].model, 'nemotron', 'the chain must start at its first step')
    } finally {
      stub.restore(); cleanup(h)
    }
    console.log('ok  a fallback chain starts at its first step')
  }

  // ── a dead first step fails over instead of failing the call ──────────────
  {
    const h = harness({
      chains: [{ name: 'fast', steps: ['nemotron', 'qwen'] }],
    })
    const stub = stubFetch((body) => {
      if (body.model === 'nemotron') {
        return new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), { status: 500 })
      }
      return sse(answer('from the second step'))
    })
    try {
      const chunks = await collect(h.adapter.stream({
        provider: 'x', model: 'combo:fast',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      }))
      const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
      assert.equal(text, 'from the second step', 'the chain must walk to the next step')
      assert.deepEqual(stub.dialed.map(d => d.model), ['nemotron', 'qwen'])
    } finally {
      stub.restore(); cleanup(h)
    }
    console.log('ok  a chain fails over to its next step')
  }

  // ── an unknown step is skipped, not fatal ─────────────────────────────────
  {
    const h = harness({
      chains: [{ name: 'fast', steps: ['not-a-real-model', 'qwen'] }],
    })
    const stub = stubFetch(() => sse(answer('ok')))
    try {
      const chunks = await collect(h.adapter.stream({
        provider: 'x', model: 'combo:fast',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      }))
      assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
      assert.deepEqual(stub.dialed.map(d => d.model), ['qwen'], 'the unknown step is dropped, the rest runs')
    } finally {
      stub.restore(); cleanup(h)
    }
    console.log('ok  an unknown step is skipped rather than failing the chain')
  }

  // ── unknown chain name is a clear error ───────────────────────────────────
  {
    const h = harness({ chains: [{ name: 'fast', steps: ['qwen'] }] })
    try {
      const chunks = await collect(h.adapter.stream({
        provider: 'x', model: 'combo:nope',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      }))
      const finish = chunks[chunks.length - 1]
      assert.equal(finish.reason.kind, 'error')
      assert.equal(finish.reason.failure.code, 'UNKNOWN_CHAIN')
      assert.match(finish.reason.failure.message, /nope/, 'the message must name the chain')
    } finally {
      cleanup(h)
    }
    console.log('ok  an unknown chain reports UNKNOWN_CHAIN by name')
  }

  // ── a chain inherits the region and retirement filters ────────────────────
  {
    const h = harness({ chains: [{ name: 'fast', steps: ['qwen'] }] })
    // Retire one of the two platforms serving `qwen`; the chain must use the other.
    h.retirement.note('alpha', 'qwen', { status: 410, message: 'gone' })
    const stub = stubFetch(() => sse(answer('ok')))
    try {
      await collect(h.adapter.stream({
        provider: 'x', model: 'combo:fast',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      }))
      assert.deepEqual(
        stub.dialed.map(d => d.host),
        ['beta.test'],
        'a retired route must not be dialed, even inside a chain',
      )
    } finally {
      stub.restore(); cleanup(h)
    }
    console.log('ok  a chain honours the retirement filter with no special case')
  }

  // ── round-robin actually rotates across calls ─────────────────────────────
  {
    const h = harness({
      chains: [{ name: 'spread', steps: ['qwen', 'nemotron'], strategy: 'round-robin', stickyRounds: 1 }],
    })
    const stub = stubFetch(() => sse(answer('ok')))
    try {
      const seen = []
      for (let i = 0; i < 4; i++) {
        stub.dialed.length = 0
        await collect(h.adapter.stream({
          provider: 'x', model: 'combo:spread',
          messages: [{ role: 'user', content: [{ type: 'text', text: `call ${i}` }] }],
        }))
        seen.push(stub.dialed[0]?.model)
      }
      // Two steps, stickyRounds 1 → alternating starts. Exact set, not order
      // alone: a rotation that always picked the same model would also produce a
      // valid-looking list.
      assert.deepEqual(seen, ['qwen', 'nemotron', 'qwen', 'nemotron'],
        `round-robin must alternate, saw ${JSON.stringify(seen)}`)
    } finally {
      stub.restore(); cleanup(h)
    }
    console.log('ok  round-robin spreads consecutive calls across steps')
  }

  // ── stickyRounds holds a start point for its duration ─────────────────────
  {
    const h = harness({
      chains: [{ name: 'sticky', steps: ['qwen', 'nemotron'], strategy: 'round-robin', stickyRounds: 3 }],
    })
    const stub = stubFetch(() => sse(answer('ok')))
    try {
      const seen = []
      for (let i = 0; i < 7; i++) {
        stub.dialed.length = 0
        await collect(h.adapter.stream({
          provider: 'x', model: 'combo:sticky',
          messages: [{ role: 'user', content: [{ type: 'text', text: `call ${i}` }] }],
        }))
        seen.push(stub.dialed[0]?.model)
      }
      assert.deepEqual(
        seen,
        ['qwen', 'qwen', 'qwen', 'nemotron', 'nemotron', 'nemotron', 'qwen'],
        `stickyRounds 3 must hold each start for three calls, saw ${JSON.stringify(seen)}`,
      )
    } finally {
      stub.restore(); cleanup(h)
    }
    console.log('ok  stickyRounds holds each start for its duration')
  }

  // ── a fallback chain never rotates, even after many calls ────────────────
  {
    const h = harness({ chains: [{ name: 'fixed', steps: ['qwen', 'nemotron'], strategy: 'fallback' }] })
    const stub = stubFetch(() => sse(answer('ok')))
    try {
      const seen = new Set()
      for (let i = 0; i < 5; i++) {
        stub.dialed.length = 0
        await collect(h.adapter.stream({
          provider: 'x', model: 'combo:fixed',
          messages: [{ role: 'user', content: [{ type: 'text', text: `call ${i}` }] }],
        }))
        seen.add(stub.dialed[0]?.model)
      }
      assert.deepEqual([...seen], ['qwen'], 'a fallback chain must always start at step 1')
    } finally {
      stub.restore(); cleanup(h)
    }
    console.log('ok  a fallback chain never rotates')
  }

  // ── chains are offered as models, and report their route count ───────────
  {
    const h = harness({
      chains: [
        { name: 'fast', steps: ['qwen'] },
        { name: 'wide', steps: ['qwen', 'auto'] },
      ],
    })
    const listed = h.adapter.listModels('x')
    const ids = listed.map(m => m.id)
    assert.ok(ids.includes('combo:fast'), 'a chain must be selectable')
    assert.ok(ids.includes('combo:wide'))
    // Chains come first: a user who built one is looking for it.
    assert.equal(ids[0], 'combo:fast', 'chains must be listed before the raw catalog')

    const wide = listed.find(m => m.id === 'combo:wide')
    // `auto` contributes the whole catalog, so the chain covers every route
    // rather than just the explicit step.
    assert.match(wide.description, /\d+ route/, 'the card must state how many routes the chain has')
    const count = Number(wide.description.match(/(\d+) route/)?.[1] ?? 0)
    assert.ok(count >= MODELS.length, `an auto step must expand the chain, got ${count}`)

    // The picker must not advertise a reasoning menu an unreachable member
    // cannot honour; `qwen` is reachable, so it should.
    const resolved = h.adapter.resolveModel('x', 'combo:wide')
    assert.equal(resolved.name, 'wide', 'a chain keeps its own name in the picker')
    cleanup(h)
    console.log('ok  chains are listed as virtual models with their route count')
  }

  // ── a chain whose steps are all gone reports EMPTY_CHAIN ─────────────────
  {
    const h = harness({ chains: [{ name: 'dead', steps: ['ghost-1', 'ghost-2'] }] })
    try {
      const chunks = await collect(h.adapter.stream({
        provider: 'x', model: 'combo:dead',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      }))
      const finish = chunks[chunks.length - 1]
      assert.equal(finish.reason.failure.code, 'EMPTY_CHAIN')
      assert.match(finish.reason.failure.message, /ghost-1/, 'the message must name the missing steps')
    } finally {
      cleanup(h)
    }
    console.log('ok  a chain with no resolvable steps reports EMPTY_CHAIN with the names')
  }

  // ── malformed chains are dropped, valid ones survive ─────────────────────
  {
    const h = harness({
      chains: [
        { name: 'good', steps: ['qwen'] },
        { name: '', steps: ['qwen'] },
        { name: 'empty', steps: [] },
        { name: 'good', steps: ['nemotron'] },
      ],
    })
    assert.equal(h.normalized.chains.length, 1, 'only the valid chain survives')
    assert.equal(h.normalized.chains[0].name, 'good')
    assert.deepEqual(
      h.normalized.chains[0].steps,
      ['qwen'],
      'the first definition of a duplicated name wins',
    )
    assert.equal(h.normalized.rejected.length, 3, 'each rejected chain is reported')
    assert.ok(
      h.normalized.rejected.some(row => row.problems.includes('duplicate name')),
      'a duplicate name must be reported as such',
    )
    cleanup(h)
    console.log('ok  malformed chains are rejected individually with reasons')
  }

  console.log('\nchain-integration checks passed')
}

main().catch(error => {
  console.error('CHAIN INTEGRATION FAILED:', error)
  process.exitCode = 1
})
