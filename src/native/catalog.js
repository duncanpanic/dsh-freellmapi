/**
 * The model catalog: what the router knows how to reach.
 *
 * Shipped as JSON generated from FreeLLMAPI's own sources, so the plugin
 * inherits a maintained roster (names, context windows, rate limits,
 * capability flags) without vendoring the project. A model id can be served by
 * several platforms; `resolve` returns all of them, ordered best-first.
 *
 * Two virtual routes exist:
 *   * `auto`   — every usable model, ranked;
 *   * `fusion` — declared but unsupported here (it needs a judge model and
 *     parallel fan-out the router does not implement). Selecting it fails with
 *     a clear message instead of silently degrading to `auto`.
 *
 * @module src/native/catalog.js
 */

// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CATALOG_FILE = path.join(here, 'catalog.json')

/**
 * Catalog ordering for `auto`.
 *
 * Both ranks are *lower is better* — the upstream project orders its own
 * fallback chains with `ORDER BY intelligence_rank ASC`, and the numbers bear
 * that out: `gemini-3.8-flash` is 25 while `pythia-70m` is 203 and the
 * SEA-Guard classifier is 200. Reading these as "higher is better" puts the
 * weakest models first, which is the single most damaging mistake this file
 * could make.
 *
 * A missing rank sorts last for intelligence and mid-pack for speed: unknown
 * quality is not a reason to promote a model, and unknown speed is not a
 * reason to bury it.
 */
function rank(a, b) {
  const rankOf = value => (Number.isFinite(value) ? value : Number.POSITIVE_INFINITY)
  const speedOf = value => (Number.isFinite(value) ? value : 1e6)

  // Compare intelligence first, but only when at least one side has a real
  // rank: comparing two infinities yields NaN and must fall through instead.
  const rankA = rankOf(Number(a.intelligence))
  const rankB = rankOf(Number(b.intelligence))
  if (rankA !== rankB) return rankA < rankB ? -1 : 1

  const speedA = speedOf(Number(a.speed))
  const speedB = speedOf(Number(b.speed))
  if (speedA !== speedB) return speedA - speedB

  return (Number(b.contextWindow) || 0) - (Number(a.contextWindow) || 0)
}

/** Load and index the catalog once per process. */
function load() {
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'))
  } catch (error) {
    payload = { platforms: {}, models: [], unresolvedPlatforms: [] }
  }

  /** @type {Record<string, { baseURL: string }>} */
  const platforms = payload.platforms && typeof payload.platforms === 'object' ? payload.platforms : {}
  /** @type {any[]} */
  const models = Array.isArray(payload.models) ? payload.models : []

  /** @type {Map<string, any[]>} */
  const byId = new Map()
  for (const model of models) {
    if (!model || typeof model.id !== 'string') continue
    if (!platforms[model.platform]) continue // unresolved endpoint: not reachable
    const list = byId.get(model.id) ?? []
    list.push(model)
    byId.set(model.id, list)
  }
  for (const list of byId.values()) list.sort(rank)

  const all = [...models]
    .filter(model => platforms[model.platform])
    .sort(rank)

  // Only platforms that actually carry a model are dialable: the generator
  // records every provider it can parse, including media/search-only ones that
  // never appear in the chat roster. Exposing those would offer the user an
  // empty platform to paste a key into.
  /** @type {Record<string, { baseURL: string }>} */
  const reachable = {}
  for (const model of models) {
    const endpoint = platforms[model.platform]
    if (endpoint && !reachable[model.platform]) reachable[model.platform] = endpoint
  }

  return { platforms: reachable, models, byId, all, unresolved: payload.unresolvedPlatforms ?? [] }
}

let cache = null
function catalog() {
  if (cache === null) cache = load()
  return cache
}

/** The platforms the router can dial, with their endpoints. */
export function platforms() {
  return catalog().platforms
}

/** Every reachable model, best-first. */
export function allModels() {
  return catalog().all
}

/** Distinct model ids, best-first (the picker list). */
export function modelIds() {
  const seen = new Set()
  const out = []
  for (const model of allModels()) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

/**
 * Look up one model id across platforms, best-first.
 *
 * `options.configured` restricts the answer to platforms that actually have a
 * key. Without it the catalog answers with every route it knows, which for an
 * `auto` request on this machine is 342 routes of which only 60 can serve — the
 * rest are walked and discarded on every single call, and the panel reports a
 * chain as far longer than it is. Filtering here rather than at each call site
 * means the waste is removed once, where the routes are chosen.
 *
 * The parameter is a predicate rather than a store reference so this module
 * stays a pure reader of its own snapshot: the catalog has no business knowing
 * about credentials, and passing a `Set` keeps it testable without a store.
 *
 * @param {string} modelId
 * @param {{ configured?: Set<string> | null, includeUnconfigured?: boolean }} [options]
 */
export function resolve(modelId, options = {}) {
  const { byId } = catalog()
  const configured = options.includeUnconfigured === true ? null : options.configured
  const keep = (routes) => {
    const mapped = routes.map(model => ({ ...model }))
    if (!(configured instanceof Set)) return mapped
    return mapped.filter(model => configured.has(model.platform))
  }

  if (modelId === 'auto') return keep(allModels())
  const exact = byId.get(modelId)
  if (exact) return keep(exact)

  // Accept the "provider/model" spelling some clients send.
  if (modelId.includes('/')) {
    const tail = modelId.slice(modelId.lastIndexOf('/') + 1)
    const byTail = byId.get(tail)
    if (byTail) return keep(byTail)
  }
  return []
}

/** True when the id is one of the two virtual routes. */
export function isVirtual(modelId) {
  return modelId === 'auto' || modelId === 'fusion'
}

/** Human-facing capability note for one model row. */
export function describe(model) {
  const parts = []
  if (model.contextWindow) parts.push(`${Math.round(model.contextWindow / 1024)}k context`)
  if (model.tools) parts.push('tools')
  if (model.vision) parts.push('vision')
  return parts.join(' · ')
}
