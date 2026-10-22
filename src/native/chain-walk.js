/**
 * Chain walk state: which step a chain starts from on the next call.
 *
 * Two strategies, and the difference between them is what the user gets in
 * practice:
 *
 *   `fallback`      always start at step 1. Predictable — the best model does
 *                   the work whenever it can, and the rest of the chain exists
 *                   purely for the days it cannot.
 *
 *   `round-robin`   start one step later each time, so a chain spreads load
 *                   across its members instead of exhausting the first one's
 *                   free tier before touching the second. That is the point:
 *                   stacking free tiers only helps if the traffic is shared.
 *
 * `round-robin` is *sticky*: once a start point is chosen, it stays chosen for
 * `stickyRounds` calls. Advancing on every call would put a different model in
 * front of every message, defeating the context cache the provider keeps per
 * model and making a conversation change voice mid-thread. Sticking means a
 * burst of retries and follow-ups lands on one model, then the chain moves on.
 *
 * State is in-process on purpose. A restart resetting a chain to its first step
 * costs one call, whereas persisting it would add a write on the hot path for a
 * preference no user can observe across a relaunch.
 *
 * @module src/native/chain-walk.js
 */

// @ts-check

export class ChainWalk {
  constructor() {
    /** @type {Map<string, { cursor: number, sticky: number }>} */
    this.state = new Map()
  }

  /**
   * How many steps to rotate the candidate list by, then advance.
   *
   * @param {string} name chain name
   * @param {number} stepCount how many *routes* the chain expanded to
   * @param {{ strategy?: string, stickyRounds?: number }} chain
   * @returns {number} 0 when the chain should start at its first step
   */
  nextOffset(name, stepCount, chain) {
    if (chain?.strategy !== 'round-robin' || stepCount <= 1) return 0

    const current = this.state.get(name) ?? { cursor: 0, sticky: 0 }
    const offset = current.cursor % stepCount

    const stickyRounds = Number.isSafeInteger(chain.stickyRounds) && chain.stickyRounds > 0
      ? chain.stickyRounds
      : 1
    const sticky = current.sticky + 1
    if (sticky >= stickyRounds) {
      // Wrap at stepCount so the cursor tracks a real position rather than
      // growing without bound.
      this.state.set(name, { cursor: (current.cursor + 1) % stepCount, sticky: 0 })
    } else {
      this.state.set(name, { cursor: current.cursor, sticky })
    }

    return offset
  }

  /** Current cursor for one chain, for the panel. */
  peek(name, stepCount) {
    if (stepCount <= 0) return 0
    return (this.state.get(name)?.cursor ?? 0) % stepCount
  }

  /** Forget one chain (it was removed or renamed). */
  forget(name) {
    return this.state.delete(name)
  }

  /** Drop chains that no longer exist, so a removed chain cannot leak state. */
  prune(liveNames) {
    const live = new Set(liveNames)
    let dropped = 0
    for (const name of this.state.keys()) {
      if (!live.has(name)) {
        this.state.delete(name)
        dropped += 1
      }
    }
    return dropped
  }

  /** Test seam. */
  reset() {
    this.state.clear()
  }
}

/**
 * Rotate a list so it starts at `offset`, preserving order otherwise.
 *
 * @template T
 * @param {readonly T[]} list
 * @param {number} offset
 * @returns {T[]}
 */
export function rotate(list, offset) {
  if (!Array.isArray(list) || list.length === 0) return []
  const size = list.length
  const start = ((offset % size) + size) % size
  if (start === 0) return [...list]
  return [...list.slice(start), ...list.slice(0, start)]
}
