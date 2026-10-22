/**
 * Named fallback chains.
 *
 * `auto` ranks every reachable model and walks them best-first. That is the right
 * default, but it cannot express a preference: "try Qwen3.8 first, then
 * Nemotron, and only then whatever else is around". A chain is that preference,
 * made explicit and addressable as `combo:<name>`.
 *
 * The expansion rule is the whole design, and it exists to keep a chain honest
 * about what it is:
 *
 *   * a step naming a concrete model contributes that model's routes;
 *   * a step naming `auto` contributes the ranked remainder, appended after the
 *     explicit steps rather than interleaved, so a chain never silently reorders
 *     the user's stated preference;
 *   * a step whose model is not in the catalog contributes nothing. Dropping it
 *     is deliberate: keeping a phantom entry would make the chain look longer
 *     than the pool behind it and hide the fact that a model was retired or
 *     renamed.
 *
 * Expansion returns the same shape `catalog.resolve` does — a list of
 * `{ platform, id, name, tools, contextWindow, limits }` — so the router's
 * candidate logic, region filter and retirement filter all apply to a chain
 * exactly as they do to `auto`, with no special case anywhere downstream.
 *
 * @module src/native/chain.js
 */

// @ts-check

/** Prefix that marks a virtual model as a chain reference. */
export const CHAIN_PREFIX = 'combo:'

/** Longest a chain may be, so a hand-edited config cannot build a giant walk. */
export const MAX_CHAIN_STEPS = 24

/** Longest a chain name may be. */
export const MAX_CHAIN_NAME = 64

/**
 * Is this model id a chain reference?
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isChainId(id) {
  return typeof id === 'string' && id.startsWith(CHAIN_PREFIX) && id.length > CHAIN_PREFIX.length
}

/** The chain name inside a `combo:<name>` id, or null. */
export function chainNameOf(id) {
  return isChainId(id) ? id.slice(CHAIN_PREFIX.length) : null
}

/**
 * The id a chain is addressed by.
 *
 * Normalised because the name reaches a model selector and an operator's YAML:
 * trimming keeps `combo: fast` and `combo:fast` the same chain rather than two.
 *
 * @param {string} name
 */
export function chainId(name) {
  return `${CHAIN_PREFIX}${String(name ?? '').trim()}`
}

/**
 * Validate one chain definition.
 *
 * Returns a list of reasons it is unusable. An empty list means it can be
 * mounted. A reason is a sentence, not a code, because it is shown to the user:
 * "step 3 names an unknown model" is actionable, "EINVALID" is not.
 *
 * @param {any} chain
 * @returns {string[]}
 */
export function validateChain(chain) {
  const problems = []
  if (!chain || typeof chain !== 'object') return ['not an object']

  const name = typeof chain.name === 'string' ? chain.name.trim() : ''
  if (name === '') problems.push('missing a name')
  else if (name.length > MAX_CHAIN_NAME) problems.push(`name longer than ${MAX_CHAIN_NAME} characters`)
  else if (isChainId(name)) problems.push('name must not itself start with "combo:"')

  const steps = Array.isArray(chain.steps) ? chain.steps : null
  if (!steps) problems.push('missing a steps array')
  else if (steps.length === 0) problems.push('has no steps')
  else if (steps.length > MAX_CHAIN_STEPS) problems.push(`more than ${MAX_CHAIN_STEPS} steps`)
  else {
    steps.forEach((step, index) => {
      if (typeof step !== 'string' || step.trim() === '') {
        problems.push(`step ${index + 1} is not a model name`)
      }
    })
  }

  const strategy = chain.strategy
  if (strategy !== undefined && strategy !== 'fallback' && strategy !== 'round-robin') {
    problems.push(`unknown strategy "${strategy}"`)
  }

  return problems
}

/**
 * Normalise a chain list from config.
 *
 * Invalid chains are dropped rather than throwing: a typo in one chain must not
 * take the whole router down, and the panel reports what was dropped.
 *
 * @param {any} input
 * @returns {{ chains: Array<{ name: string, steps: string[], strategy: 'fallback' | 'round-robin', stickyRounds: number }>, rejected: Array<{ chain: any, problems: string[] }> }}
 */
export function normalizeChains(input) {
  const list = Array.isArray(input) ? input : []
  /** @type {any[]} */
  const chains = []
  /** @type {Array<{ chain: any, problems: string[] }>} */
  const rejected = []
  const seen = new Set()

  for (const candidate of list) {
    const problems = validateChain(candidate)
    if (problems.length > 0) {
      rejected.push({ chain: candidate, problems })
      continue
    }
    const name = candidate.name.trim()
    // Two chains with one name would make `combo:<name>` ambiguous, and the
    // first would win silently. Rejecting the duplicate is visible instead.
    if (seen.has(name.toLowerCase())) {
      rejected.push({ chain: candidate, problems: ['duplicate name'] })
      continue
    }
    seen.add(name.toLowerCase())

    const strategy = candidate.strategy === 'round-robin' ? 'round-robin' : 'fallback'
    const stickyRounds = Number.isSafeInteger(candidate.stickyRounds) && candidate.stickyRounds > 0
      ? Math.min(candidate.stickyRounds, 50)
      : 1

    chains.push({
      name,
      steps: candidate.steps.map(step => String(step).trim()).filter(step => step !== ''),
      strategy,
      stickyRounds,
    })
  }

  return { chains, rejected }
}

/**
 * Expand one chain into candidate routes.
 *
 * `offset` rotates the *explicit steps*, not the routes they expand to, and the
 * distinction matters. A model served by two platforms expands to two routes, so
 * rotating at route level would put `alpha/qwen` and then `beta/qwen` in front —
 * which the user reads as "it picked qwen twice in a row", not as rotation. The
 * steps are what the user wrote, so the steps are what rotate; the routes inside
 * a step stay together, in order, so a step that fails still walks all of its
 * platforms before the chain moves on.
 *
 * `auto` is excluded from rotation and always appended last: it is the
 * catch-all, and rotating a catch-all into the middle would let it outrank an
 * explicit preference on some calls and not others.
 *
 * @param {{ name: string, steps: string[] }} chain
 * @param {{ resolve: (model: string) => any[], auto: () => any[] }} source
 * @param {number} [offset]
 * @returns {{ routes: any[], missing: string[], autoAppended: number }}
 */
export function expandChain(chain, source, offset = 0) {
  /** @type {any[]} */
  const routes = []
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {string[]} */
  const missing = []

  const push = (route) => {
    const key = `${route.platform}|${route.id}`
    // The same model can be served by several platforms and can appear in
    // several steps; the router tries each route once, so duplicates only make
    // the walk longer.
    if (seen.has(key)) return
    seen.add(key)
    routes.push(route)
  }

  const steps = chain.steps ?? []
  const explicit = steps.filter(step => step !== 'auto')
  const ordered = rotateSteps(explicit, offset)

  for (const step of ordered) {
    const resolved = source.resolve(step)
    if (!Array.isArray(resolved) || resolved.length === 0) {
      missing.push(step)
      continue
    }
    for (const route of resolved) push(route)
  }

  // `auto` is appended after every explicit step, in ranked order, so the chain
  // extends the user's preference instead of competing with it.
  let autoAppended = 0
  if (steps.includes('auto')) {
    for (const route of source.auto()) {
      const before = routes.length
      push(route)
      if (routes.length > before) autoAppended += 1
    }
  }

  return { routes, missing, autoAppended }
}

/**
 * Rotate the explicit step list, preserving order otherwise.
 *
 * Kept here rather than imported from `chain-walk.js` so this module stays a
 * pure transformer with no state of its own.
 *
 * @param {readonly string[]} steps
 * @param {number} offset
 */
function rotateSteps(steps, offset) {
  const size = steps.length
  if (size <= 1) return [...steps]
  const start = ((Math.trunc(offset) % size) + size) % size
  if (start === 0) return [...steps]
  return [...steps.slice(start), ...steps.slice(0, start)]
}

/**
 * How many positions a chain can rotate through.
 *
 * Counts explicit steps only, because `auto` never rotates. A chain with no
 * explicit steps has nothing to rotate and must always report 1, or `nextOffset`
 * would compute offsets against a length of zero.
 *
 * @param {{ steps: string[] }} chain
 */
export function rotationWidth(chain) {
  const explicit = (chain.steps ?? []).filter(step => step !== 'auto').length
  return Math.max(1, explicit)
}
