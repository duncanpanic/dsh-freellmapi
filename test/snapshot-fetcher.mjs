/**
 * Tests for the snapshot consumer.
 *
 * The fetcher is the only part of the snapshot system that ships publicly, and it
 * runs on machines where snapshot.lorcan.top may be blocked, slow, or simply not
 * deployed yet. Two failure modes matter:
 *
 *   * the two-hop protocol (latest.json -> version file) is the contract with a
 *     server we do not control here, so it is pinned against a real HTTP server
 *     rather than a stubbed global fetch;
 *   * a network failure must not take the plugin down — a warm cache has to keep
 *     serving, marked stale, instead of throwing.
 *
 * Run: node test/snapshot-fetcher.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// The cache location is read at import time, so it has to be set before the
// module is loaded.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-snapshot-test-'))
process.env.DSH_FREELLMAPI_CACHE_DIR = cacheDir

const {
  fetchSnapshot,
  getCacheStatus,
  isStarMode,
  clearCache,
  onUpdate,
} = await import('../src/snapshot/snapshot-fetcher.js')

// ── a stand-in for snapshot.lorcan.top ──────────────────────────────────────
let requests = []
let mode = 'normal'

const snapshot = {
  version: '1.0.0',
  generatedAt: '2026-10-22T00:00:00.000Z',
  frequency: 'monthly',
  providers: {
    nvidia: { displayName: 'NVIDIA NIM', basis: 'credits', modelCount: 2, models: [] },
    openrouter: { displayName: 'OpenRouter', basis: 'zero-price', modelCount: 1, models: [] },
  },
  summary: { totalProviders: 2, totalModels: 3, freeModels: 3 },
}

const server = http.createServer((req, res) => {
  requests.push(req.url)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (mode === 'down') return send(500, { error: 'boom' })

  if (req.url === '/latest.json') {
    // 'inline' is the degenerate case where the pointer *is* the snapshot.
    if (mode === 'inline') return send(200, snapshot)
    return send(200, { file: 'snapshot-free-2026-10-22.json', generatedAt: snapshot.generatedAt, frequency: 'monthly', prefix: 'free' })
  }
  if (req.url === '/snapshot-free-2026-10-22.json') return send(200, snapshot)
  if (req.url === '/empty.json') return send(200, { generatedAt: 'x' })
  return send(404, { error: 'not found' })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// star.json is consulted on every call; pin it so the test never touches GitHub.
fs.writeFileSync(path.join(cacheDir, 'star.json'), JSON.stringify({ starCount: 0, isStarMode: false, checkedAt: Date.now() }))

try {
  // ── the two hops actually happen ──────────────────────────────────────────
  {
    const data = await fetchSnapshot({ base })
    assert.equal(data.summary.freeModels, 3, 'the version file body must come back verbatim')
    assert.equal(data.stale, false)
    assert.deepEqual(requests, ['/latest.json', '/snapshot-free-2026-10-22.json'],
      'latest.json is read first, then the file it names')
    console.log('ok  latest.json -> version file, both hops requested')
  }

  // ── a fresh cache means no traffic at all ─────────────────────────────────
  {
    requests = []
    const data = await fetchSnapshot({ base })
    assert.equal(data.summary.freeModels, 3)
    assert.deepEqual(requests, [], 'a cache inside the TTL must not hit the network')
    console.log('ok  fresh cache short-circuits the network')
  }

  // ── force means force ────────────────────────────────────────────────────
  {
    requests = []
    await fetchSnapshot({ base, force: true })
    assert.equal(requests.length, 2, 'force must redo both hops despite a warm cache')
    console.log('ok  force refetches past a warm cache')
  }

  // ── a pointer that is already a snapshot costs one hop ───────────────────
  {
    mode = 'inline'
    clearCache()
    requests = []
    const data = await fetchSnapshot({ base })
    assert.equal(data.summary.freeModels, 3)
    assert.deepEqual(requests, ['/latest.json'], 'an inline snapshot must not trigger a second request')
    console.log('ok  latest.json may carry the snapshot itself')
    mode = 'normal'
  }

  // ── dead server + warm cache = stale data, not an exception ──────────────
  {
    clearCache()
    await fetchSnapshot({ base })       // warm it while the server is healthy
    mode = 'down'
    const data = await fetchSnapshot({ base, force: true })
    assert.equal(data.stale, true, 'a failed refetch must fall back to the cached body')
    assert.equal(data.summary.freeModels, 3)
    console.log('ok  refetch failure falls back to cached data, marked stale')
  }

  // ── dead server + cold cache = a clear error ─────────────────────────────
  {
    clearCache()
    mode = 'down'
    await assert.rejects(
      () => fetchSnapshot({ base }),
      /无法获取快照/,
      'with nothing cached the failure must surface',
    )
    console.log('ok  cold cache and dead server raises a readable error')
  }

  // ── a pointer with no file is a contract violation, not a silent no-op ───
  {
    clearCache()
    mode = 'normal'
    const badBase = base
    const originalLatest = server.listeners('request')[0]
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ generatedAt: 'x' }))
    })
    await assert.rejects(() => fetchSnapshot({ base: badBase }), /no "file" field/)
    server.removeAllListeners('request')
    server.on('request', originalLatest)
    console.log('ok  a pointer without "file" is rejected')
  }

  // ── cache status reports what the panel needs ────────────────────────────
  {
    clearCache()
    await fetchSnapshot({ base })
    const status = await getCacheStatus()
    assert.equal(status.isCached, true)
    assert.equal(status.mode, 'free')
    assert.equal(status.file, 'snapshot-free-2026-10-22.json')
    assert.equal(status.expired, false)
    assert.equal(typeof status.ageSeconds, 'number')
    console.log('ok  getCacheStatus reports mode, file and age')
  }

  // ── clearing leaves nothing behind ──────────────────────────────────────
  {
    clearCache()
    const status = await getCacheStatus()
    assert.equal(status.isCached, false)
    console.log('ok  clearCache drops the cached body')
  }

  // ── Star mode is a plain threshold read ─────────────────────────────────
  {
    clearCache()
    fs.writeFileSync(path.join(cacheDir, 'star.json'), JSON.stringify({ starCount: 100, isStarMode: true, checkedAt: Date.now() }))
    assert.equal(await isStarMode(), true, 'starCount >= 100 means star mode')
    fs.writeFileSync(path.join(cacheDir, 'star.json'), JSON.stringify({ starCount: 99, isStarMode: false, checkedAt: Date.now() }))
    assert.equal(await isStarMode(), false, 'one star short is still free mode')
    console.log('ok  isStarMode reads the cached threshold verdict')
  }

  // ── subscribers are told about a real refetch ───────────────────────────
  {
    // A reload that only touches the disk cache changes nothing for a subscriber,
    // so only an actual fetch may emit.
    clearCache()
    const seen = []
    const off = onUpdate(data => seen.push(data))
    await fetchSnapshot({ base })
    assert.equal(seen.length, 1, 'a real fetch must notify subscribers')
    await fetchSnapshot({ base })
    assert.equal(seen.length, 1, 'serving from cache must stay quiet')
    off()
    console.log('ok  onUpdate fires on fetch, stays quiet on cache hit')
  }
} finally {
  server.close()
  fs.rmSync(cacheDir, { recursive: true, force: true })
}

console.log('\nsnapshot-fetcher checks passed')
