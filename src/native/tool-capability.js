/**
 * Observed tool-calling rejections.
 *
 * `catalog.json`'s `tools` flag is a *declaration*: FreeLLMAPI derives it by
 * matching model families that document native function calling, and its own
 * source calls the result deliberately conservative. It is wrong in both
 * directions — some flagged models still 400 every tool-carrying request, and
 * some unflagged ones work fine.
 *
 * So the flag is a hint, never a filter. This module remembers real rejections
 * and lets the router *defer* a model for tool-carrying requests only:
 *
 *   * a deferred model is still tried once everything else is exhausted;
 *   * plain chat requests are untouched;
 *   * nothing is persisted — a restart forgets, which matches how short-lived
 *     the upstream situation is (a relay that fixes its tools comes back the
 *     same day without anyone editing config).
 *
 * Keyed per (platform, model), not per key: tool support is a property of the
 * model behind one endpoint, and sibling keys share it.
 *
 * @module src/native/tool-capability.js
 */

// @ts-check

/**
 * Distinct requests that must see a rejection before the model is deferred.
 * One odd request must not condemn a model.
 */
export const TOOL_REJECTION_LIMIT = 3

/** Rejections older than this are forgotten, so a blip cannot accumulate. */
export const TOOL_REJECTION_WINDOW_MS = 60 * 60 * 1000

/** How long a deferred model stays at the back of the order. */
export const TOOL_BENCH_MS = 6 * 60 * 60 * 1000

/** @type {Map<string, number[]>} */
const rejections = new Map()
/** @type {Map<string, number>} */
const deferredUntil = new Map()

/** The accounting key for one model behind one endpoint. */
export function toolCapabilityKey(platform, modelId) {
  return `${platform}/${modelId}`
}

/** True while this model should be tried last for tool-carrying requests. */
export function isToolDeferred(platform, modelId, now = Date.now()) {
  const until = deferredUntil.get(toolCapabilityKey(platform, modelId))
  if (until === undefined) return false
  if (until > now) return true
  deferredUntil.delete(toolCapabilityKey(platform, modelId))
  return false
}

/** Defer this model immediately; the evidence is already conclusive. */
export function deferForTools(platform, modelId, now = Date.now()) {
  const key = toolCapabilityKey(platform, modelId)
  const already = (deferredUntil.get(key) ?? 0) > now
  deferredUntil.set(key, now + TOOL_BENCH_MS)
  rejections.delete(key)
  return !already
}

/** One tool-carrying request was rejected by this model as a bad request. */
export function noteToolRejection(platform, modelId, now = Date.now()) {
  const key = toolCapabilityKey(platform, modelId)
  const recent = (rejections.get(key) ?? []).filter(stamp => now - stamp < TOOL_REJECTION_WINDOW_MS)
  recent.push(now)
  if (recent.length >= TOOL_REJECTION_LIMIT) return deferForTools(platform, modelId, now)
  rejections.set(key, recent)
  return false
}

/** The model served a tool-carrying request: it supports tools after all. */
export function clearToolRejections(platform, modelId) {
  const key = toolCapabilityKey(platform, modelId)
  rejections.delete(key)
  deferredUntil.delete(key)
}

/** Snapshot for diagnostics. */
export function toolCapabilityStats(now = Date.now()) {
  const tracks = []
  for (const [key, stamps] of rejections) {
    const recent = stamps.filter(stamp => now - stamp < TOOL_REJECTION_WINDOW_MS)
    if (recent.length > 0) tracks.push({ key, rejections: recent.length })
  }
  const deferred = []
  for (const [key, until] of deferredUntil) {
    if (until > now) deferred.push({ key, until })
  }
  return { tracked: tracks, deferred }
}

/** Drop all memory. Test seam. */
export function resetToolCapability() {
  rejections.clear()
  deferredUntil.clear()
}
