/**
 * Render the panel's data-driven blocks headlessly.
 *
 * `client-smoke.mjs` proves the bundle registers correctly. This walks the
 * actual element trees each block produces, across every interesting payload
 * shape, so a crash inside a branch (a missing field, a null array, a stale
 * timestamp) surfaces here instead of as a blank settings panel.
 *
 * Only translated keys are checked, not copy: rendering with `t = key => key`
 * keeps the assertions about structure and makes a missing dictionary entry
 * show up as a literal key string.
 *
 * Run: node test/render-panel.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * React stand-in: elements are plain objects, hooks are inert.
 *
 * `useState` is driven by a queue the test primes before each render. A panel
 * that fetches its data calls `useState(null)` first and renders `null` until
 * the fetch resolves, so an inert hook would leave every data-driven branch
 * untested. Priming the initial values renders the populated tree directly.
 */
let stateQueue = []

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    if (stateQueue.length > 0) return [stateQueue.shift(), () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
}

const documentStub = {
  createElement: () => ({ setAttribute: () => {}, remove: () => {}, textContent: '' }),
  head: { appendChild: () => {} },
}

/** Load the bundle and return its exports. */
function loadBundle() {
  const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
  let captured = null
  const window = { __ModuleLoader__: { load: definition => { captured = definition } } }
  new Function('window', 'require', 'document', source)(
    window,
    id => { if (id === 'react') return React; throw new Error(`unexpected require(${id})`) },
    documentStub,
  )
  assert.ok(captured, 'the bundle must call window.__ModuleLoader__.load')
  return captured.factory(id => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  })
}

/**
 * Walk a rendered tree, invoking function components so their bodies execute.
 *
 * Collects both text children and selected string props: `placeholder` and
 * `title` carry user-visible copy that never appears as a child node, and a
 * test that only reads children would silently pass over a missing one.
 *
 * @returns {{ nodes: number, texts: string[], types: Set<string> }}
 */
const PROP_TEXT_KEYS = ['placeholder', 'title', 'aria-label', 'label']

function walk(node, acc) {
  if (node === null || node === undefined || node === false || node === true) return acc
  if (Array.isArray(node)) {
    for (const child of node) walk(child, acc)
    return acc
  }
  if (typeof node === 'string' || typeof node === 'number') {
    acc.texts.push(String(node))
    return acc
  }
  acc.nodes += 1
  for (const key of PROP_TEXT_KEYS) {
    const value = node.props?.[key]
    if (typeof value === 'string' && value !== '') acc.texts.push(value)
  }
  if (typeof node.type === 'function') {
    acc.types.add(node.type.name || 'anon')
    walk(node.type({ ...(node.props ?? {}), children: node.children }), acc)
    return acc
  }
  acc.types.add(String(node.type))
  walk(node.children, acc)
  return acc
}

const fresh = () => ({ nodes: 0, texts: [], types: new Set() })

const exported = loadBundle()
const {
  ToolCapability, NativePanel, RegionBlock, ReasoningPolicy,
  RetiredBlock, RecoveryBlock, RegionProbeBlock, ForecastBlock, ChainBlock, DICT,
} = exported.__test
const t = key => key

// ── ChainBlock ──────────────────────────────────────────────────────────────
{
  const empty = walk(ChainBlock({ t, data: { chains: [], rejectedChains: [] } }), fresh()).texts.join('|')
  assert.ok(empty.includes('chainTitle') && empty.includes('chainNone'), 'an empty chain list must be stated')

  const rows = walk(ChainBlock({
    t,
    data: {
      chains: [
        { name: 'coding', id: 'combo:coding', steps: ['qwen'], strategy: 'fallback', stickyRounds: 1, routeCount: 3, missing: [], cursor: 0 },
        { name: 'spread', id: 'combo:spread', steps: ['a', 'b'], strategy: 'round-robin', stickyRounds: 3, routeCount: 4, missing: ['ghost'], cursor: 1 },
      ],
      rejectedChains: [],
    },
  }), fresh()).texts.join('|')

  assert.ok(rows.includes('combo:coding') && rows.includes('combo:spread'), 'each chain is listed by its id')
  assert.ok(rows.includes('chainStrategyFallback'), 'a fallback chain must say so')
  assert.ok(rows.includes('chainStrategyRound'), 'a round-robin chain must say so')
  // A missing step is the one thing a user cannot otherwise discover: the chain
  // still works, just shorter than written.
  assert.ok(rows.includes('chainMissing'), 'a chain with unknown steps must flag them')

  // A sticky label only makes sense when there is something to stick.
  const sticky = walk(ChainBlock({
    t,
    data: {
      chains: [{ name: 's', id: 'combo:s', steps: ['a', 'b'], strategy: 'round-robin', stickyRounds: 3, routeCount: 4, missing: [], cursor: 0 }],
      rejectedChains: [],
    },
  }), fresh()).texts.join('|')
  assert.ok(sticky.includes('chainSticky'), 'a multi-round sticky chain must show its stickiness')
  const noSticky = walk(ChainBlock({
    t,
    data: {
      chains: [{ name: 's', id: 'combo:s', steps: ['a', 'b'], strategy: 'round-robin', stickyRounds: 1, routeCount: 4, missing: [], cursor: 0 }],
      rejectedChains: [],
    },
  }), fresh()).texts.join('|')
  assert.ok(!noSticky.includes('chainSticky'), 'stickyRounds 1 is the default and needs no label')

  // Rejected chains must render with their reasons — that is the only feedback a
  // user gets for a typo in the config.
  const rejected = walk(ChainBlock({
    t,
    data: {
      chains: [],
      rejectedChains: [{ name: 'broken', problems: ['has no steps', 'duplicate name'] }],
    },
  }), fresh()).texts.join('|')
  assert.ok(rejected.includes('chainRejected'), 'a rejected chain must be surfaced')
  assert.ok(rejected.includes('broken'), 'the rejected chain must be named')
  assert.ok(rejected.includes('has no steps'), 'the reason must be shown, not just the fact')

  for (const bad of [undefined, null, {}, { chains: null }, { chains: null, rejectedChains: null }]) {
    assert.doesNotThrow(() => walk(ChainBlock({ t, data: bad }), fresh()), `must tolerate ${JSON.stringify(bad)}`)
  }
  console.log('ok  ChainBlock lists chains, flags missing steps and surfaces rejections')
}

// ── RegionProbeBlock ────────────────────────────────────────────────────────
{
  let probed = 0
  let cleared = 0
  const tree = RegionProbeBlock({
    t,
    onProbe: () => { probed += 1 },
    onClear: () => { cleared += 1 },
    result: { reachable: 3, slow: 1, regionCount: 1, failed: 0 },
    running: false,
  })
  const blob = walk(tree, fresh()).texts.join('|')
  assert.ok(blob.includes('probeTitle') && blob.includes('probeSub'))
  assert.ok(blob.includes('probeRun'), 'the probe button must be present')
  assert.ok(blob.includes('probeClear'), 'the clear control must be present')
  // The stub `t` returns the key, so the interpolation template arrives
  // unsubstituted. Assert the template renders rather than that it was filled:
  // substitution is the shell's job, not this component's.
  assert.ok(blob.includes('probeResult'), 'the result line must render once a sweep has run')
  // The "slow" explanation appears only when a sweep actually had timeouts —
  // on a clean sweep the extra sentence is noise.
  assert.ok(blob.includes('probeSlowHint'), 'a slow platform must be explained')
  const clean = walk(RegionProbeBlock({
    t, result: { reachable: 4, slow: 0, regionCount: 0, failed: 0 }, running: false,
  }), fresh()).texts.join('|')
  assert.ok(!clean.includes('probeSlowHint'), 'the slow hint must not appear on a clean sweep')

  // Both controls must actually be wired.
  ;(function findButtons(node) {
    if (!node) return
    if (Array.isArray(node)) return node.forEach(findButtons)
    if (typeof node !== 'object') return
    if (node.type === 'button' && typeof node.props?.onClick === 'function') {
      node.props.onClick()
      return
    }
    if (typeof node.type === 'function') return findButtons(node.type({ ...(node.props ?? {}), children: node.children }))
    return findButtons(node.children)
  })(tree)
  assert.equal(probed, 1, 'the probe button must call back')
  assert.equal(cleared, 1, 'the clear button must call back')

  // While running, the label changes and the controls lock. Compare exact node
  // text: `probeRunning` contains `probeRun` as a substring, so a `includes`
  // test would pass either way.
  const busyTexts = walk(RegionProbeBlock({ t, running: true }), fresh()).texts
  assert.ok(busyTexts.includes('probeRunning'), 'a running sweep must say so')
  assert.ok(!busyTexts.includes('probeRun'), 'the idle label must not also appear')
  console.log('ok  RegionProbeBlock renders, wires both controls, and reflects running state')
}

// ── ForecastBlock ───────────────────────────────────────────────────────────
{
  const empty = walk(ForecastBlock({ t, data: { forecast: { platforms: {} } } }), fresh()).texts.join('|')
  assert.ok(empty.includes('forecastTitle') && empty.includes('forecastNone'), 'an empty forecast must be stated')

  const rows = walk(ForecastBlock({
    t,
    data: {
      forecast: {
        window: { minutes: 10 },
        platforms: {
          capped: { requestsToday: 40, dailyRequestBudget: 200, remainingRequests: 160, burnRatePerMinute: 12, runwayMinutes: 13, lowBalance: false, reason: '' },
          low: { requestsToday: 195, dailyRequestBudget: 200, remainingRequests: 5, burnRatePerMinute: 30, runwayMinutes: 1, lowBalance: true, reason: 'below 10%' },
          unlimited: { requestsToday: 3, dailyRequestBudget: null, remainingRequests: null, burnRatePerMinute: 0, runwayMinutes: null, lowBalance: false, reason: 'unlimited or unknown' },
          // A budget exists but the remainder is not a number: distinct from
          // "unlimited", and it must not be rendered as if it were a count.
          unknown: { requestsToday: 7, dailyRequestBudget: 200, remainingRequests: null, burnRatePerMinute: 0, runwayMinutes: null, lowBalance: false, reason: 'unknown' },
        },
      },
    },
  }), fresh()).texts.join('|')

  assert.ok(rows.includes('capped') && rows.includes('low') && rows.includes('unlimited') && rows.includes('unknown'))
  assert.ok(rows.includes('forecastLow'), 'a low-balance platform must be flagged')
  // A budgetless platform must be labelled, not shown as a count. The stub `t`
  // returns the key, so the label arrives as the key itself.
  assert.ok(rows.includes('forecastUnlimited'), 'a budgetless platform must say unlimited')
  assert.ok(rows.includes('forecastUnknown'), 'an unknown balance must not look like a count')

  // Malformed payloads must not throw.
  for (const bad of [undefined, null, {}, { forecast: null }, { forecast: { platforms: null } }]) {
    assert.doesNotThrow(() => walk(ForecastBlock({ t, data: bad }), fresh()), `must tolerate ${JSON.stringify(bad)}`)
  }
  console.log('ok  ForecastBlock distinguishes capped, low and unknown balances')
}

// ── RetiredBlock ────────────────────────────────────────────────────────────
{
  const empty = walk(RetiredBlock({ t, data: { retired: [] } }), fresh()).texts.join('|')
  assert.ok(empty.includes('retiredTitle') && empty.includes('retiredNone'), 'an empty list must be stated')

  const rows = walk(RetiredBlock({
    t,
    data: { retired: [{ platform: 'nvidia', model: 'minimax-m2.7', reason: 'end of life', at: Date.now() }] },
  }), fresh()).texts.join('|')
  assert.ok(rows.includes('minimax-m2.7') && rows.includes('nvidia'), 'the retired route must be listed')
  assert.ok(rows.includes('retiredLift'), 'each row must offer a restore action')

  // The restore control must be wired: a row with no handler is a dead button.
  let lifted = null
  const tree = RetiredBlock({
    t,
    data: { retired: [{ platform: 'p', model: 'm', reason: 'gone', at: 1 }] },
    onLift: (platform, model) => { lifted = { platform, model } },
  })
  // Find the restore button and invoke it.
  ;(function find(node) {
    if (lifted || !node) return
    if (Array.isArray(node)) return node.forEach(find)
    if (typeof node !== 'object') return
    if (node.props?.className === 'dsh-flm-link' && typeof node.props.onClick === 'function') {
      node.props.onClick()
      return
    }
    if (typeof node.type === 'function') return find(node.type({ ...(node.props ?? {}), children: node.children }))
    return find(node.children)
  })(tree)
  assert.deepEqual(lifted, { platform: 'p', model: 'm' }, 'restore must call back with the exact route')
  console.log('ok  RetiredBlock lists routes and wires the restore action')

  for (const bad of [undefined, null, {}, { retired: null }]) {
    assert.doesNotThrow(() => walk(RetiredBlock({ t, data: bad }), fresh()), `must tolerate ${JSON.stringify(bad)}`)
  }
  console.log('ok  RetiredBlock tolerates malformed payloads')
}

// ── RecoveryBlock ───────────────────────────────────────────────────────────
{
  // Absent policy renders nothing rather than an empty shell.
  for (const bad of [undefined, null, {}, { recovery: null }]) {
    const out = walk(RecoveryBlock({ t, data: bad }), fresh())
    assert.equal(out.nodes, 0, `RecoveryBlock must render nothing for ${JSON.stringify(bad)}`)
  }
  const on = walk(RecoveryBlock({ t, data: { recovery: { enabled: true, maxOutputTokens: 8192 } } }), fresh()).texts.join('|')
  assert.ok(on.includes('recoveryTitle') && on.includes('recoveryOn') && on.includes('8192'))
  const off = walk(RecoveryBlock({ t, data: { recovery: { enabled: false, maxOutputTokens: 4096 } } }), fresh()).texts.join('|')
  assert.ok(off.includes('recoveryOff'), 'a disabled policy must say so')
  console.log('ok  RecoveryBlock reports on/off and the budget')
}

// ── RegionBlock ─────────────────────────────────────────────────────────────
{
  const empty = walk(RegionBlock({ t, data: { regionBlocked: [] } }), fresh()).texts.join('|')
  assert.ok(empty.includes('regionTitle'), 'the region block must always carry its heading')
  assert.ok(empty.includes('regionNone'), 'an empty list must say so rather than render nothing')

  const rows = walk(RegionBlock({
    t,
    data: { regionBlocked: [{ platform: 'google', model: 'gemini-2.5-flash' }] },
  }), fresh()).texts.join('|')
  assert.ok(rows.includes('gemini-2.5-flash') && rows.includes('google'), 'each blocked route must be listed')
  assert.ok(rows.includes('regionSub'), 'the explanation must accompany the list')

  // A malformed payload must not throw.
  for (const bad of [undefined, null, {}, { regionBlocked: null }]) {
    assert.doesNotThrow(() => walk(RegionBlock({ t, data: bad }), fresh()), `RegionBlock must tolerate ${JSON.stringify(bad)}`)
  }
  console.log('ok  RegionBlock renders empty, populated and malformed payloads')
}

// ── ReasoningPolicy ─────────────────────────────────────────────────────────
{
  const none = walk(ReasoningPolicy({ t, data: { reasoningPolicies: {} } }), fresh()).texts.join('|')
  assert.ok(none.includes('reasonTitle') && none.includes('reasonNone'), 'an empty policy set must be stated')

  const rows = walk(ReasoningPolicy({
    t,
    data: {
      reasoningPolicies: {
        groq: { supports: true, efforts: ['low', 'medium', 'high'] },
        google: { supports: true, efforts: ['off', 'low', 'high'] },
      },
    },
  }), fresh()).texts.join('|')
  assert.ok(rows.includes('groq') && rows.includes('low') && rows.includes('medium') && rows.includes('high'))
  assert.ok(rows.includes('google'), 'every configured platform must be listed')

  // A platform with no efforts must be omitted, not shown as an empty row.
  const filtered = walk(ReasoningPolicy({
    t,
    data: { reasoningPolicies: { mistral: { supports: false, efforts: [] }, groq: { supports: true, efforts: ['low'] } } },
  }), fresh()).texts.join('|')
  assert.ok(filtered.includes('groq'), 'a supported platform must appear')
  assert.ok(!filtered.includes('mistral'), 'a platform with no efforts must not appear')

  for (const bad of [undefined, null, {}, { reasoningPolicies: null }]) {
    assert.doesNotThrow(() => walk(ReasoningPolicy({ t, data: bad }), fresh()), `ReasoningPolicy must tolerate ${JSON.stringify(bad)}`)
  }
  console.log('ok  ReasoningPolicy renders only platforms that accept an effort')
}

// ── NativePanel: the block the user actually reads ───────────────────────────
// `ctx.locale.bind` supplies the real `t`; the stub returns the key itself.
const panelCtx = { locale: { bind: () => t } }

const panelCases = [
  ['disabled', { enabled: false }, ['nativeTitle', 'nativeOff']],
  ['empty pool', {
    enabled: true,
    configuredPlatforms: 0,
    catalogModels: 297,
    availablePlatforms: [{ id: 'groq', endpoint: 'https://api.groq.com/openai/v1', models: 7 }],
    usage: {},
    keys: [],
    toolCapability: { tracked: [], deferred: [] },
  }, ['nativeTitle', 'nativeNoKeys', 'tabOverview', 'tabModels', 'tabKeys', 'tabTools']],
  ['populated', {
    enabled: true,
    configuredPlatforms: 2,
    catalogModels: 297,
    availablePlatforms: [{ id: 'kilo', endpoint: 'https://api.kilo.ai/api/gateway/v1', models: 11 }],
    usage: { kilo: { requests: 12, tokens: 3456, keys: 1, cooled: 0 } },
    models: [
      { id: 'qwen3-coder', name: 'Qwen3 Coder', platforms: ['kilo'], contextWindow: 131072, tools: true, vision: false },
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', platforms: ['kilo', 'ovh'], contextWindow: 128000, tools: true, vision: false },
      { id: 'pythia-70m', name: 'Pythia 70M', platforms: ['kilo'], contextWindow: 2048, tools: false, vision: false },
    ],
    keys: [{
      platform: 'kilo',
      endpoint: 'https://api.kilo.ai/api/gateway/v1',
      entries: [
        { id: 'abc123', label: '', status: 'healthy', cooldownUntil: 0, lastError: '' },
        { id: 'def456', label: '', status: 'throttled', cooldownUntil: Date.now() + 60_000, lastError: 'rate limited' },
      ],
    }],
    toolCapability: {
      tracked: [{ key: 'llm7/mistral-Nemo-Instruct-2407', rejections: 1 }],
      deferred: [{ key: 'kilo/lfm-2.5-2.6b:free', until: Date.now() + 6 * 3_600_000 }],
    },
    // The diagnostics tab renders the recovery switch and the reasoning policy,
    // so the fixture has to carry both or those blocks correctly render nothing.
    recovery: { enabled: true, totalTimeoutMs: 1_800_000, maxOutputTokens: 8192 },
    regionBlocked: [{ platform: 'kilo', model: 'retired-ish-model' }],
    retired: [{ platform: 'ovh', model: 'gone-model', reason: 'end of life', at: 1 }],
    reasoningPolicies: { kilo: { supports: true, efforts: ['off', 'low', 'high'] } },
  }, ['nativeTitle', 'kilo', 'tabModels', 'healthUsable']],
  ['malformed payloads', {
    enabled: true,
    configuredPlatforms: 1,
    catalogModels: 297,
    availablePlatforms: null,
    usage: null,
    keys: null,
    models: null,
    toolCapability: { tracked: null, deferred: null },
  }, ['nativeTitle', 'tabOverview']],
]

// NativePanel's hooks, in order:
//   [data, platform, secret, busy, note, tab, query, toolsOnly, showAll, probeResult, probing,
//    channelData, catalogMode, catalogModeLoading, catalogModeError]
// `data` is seeded per case; `tab` picks which view is under test.
const seed = (data, tab = 'overview', probeResult = null) => [
  data, '', '', false, '', tab, '', false, false, probeResult, false,
  null, '', true, '', '',
]

for (const [label, data, expected] of panelCases) {
  let tree
  assert.doesNotThrow(() => { stateQueue = seed(data); tree = NativePanel({ ctx: panelCtx }) }, `${label}: must not throw`)
  stateQueue = []
  const result = walk(tree, fresh())
  const blob = result.texts.join('|')
  for (const needle of expected) {
    assert.ok(blob.includes(needle), `${label}: expected ${JSON.stringify(needle)} in ${JSON.stringify(result.texts.slice(0, 18))}`)
  }
  console.log(`ok  NativePanel renders (${label})`)
}

// ── the tab views, each rendered on demand ──────────────────────────────────
const richData = panelCases.find(([label]) => label === 'populated')[1]

const tabCases = [
  // The overview answers "is it working?" and nothing else: one usable count, a
  // health bar, a budget meter per platform. It must NOT carry the diagnostic
  // blocks — they are what made it a nine-section wall.
  ['overview', richData,
    ['healthUsable', 'budgetTitle', 'legendOk'],
    ['nativePlaceholder', 'availSearch', 'chainTitle', 'diagTitle', 'forecastTitle', 'regionTitle']],
  ['models', richData,
    ['availSearch', 'availToolsOnly', 'qwen3-coder', 'llama-3.3-70b', 'tagTools', '128k', '2×'],
    // The keys view must not leak into the models view.
    ['nativePlaceholder']],
  ['keys', richData, ['nativePlaceholder', 'kilo', 'nativeHealthy', 'nativeCooling'], ['availSearch']],
  ['chains', richData, ['chainTitle'], ['availSearch']],
  ['tools', richData, ['toolTitle', 'toolObserved', 'toolDeferred'], ['diagTitle']],
  // Diagnostics is where the reporting blocks live: region verdicts, the probe
  // control, retirement, recovery and the reasoning policy.
  ['health', richData,
    ['diagTitle', 'forecastTitle', 'regionTitle', 'probeTitle', 'retiredTitle', 'recoveryTitle', 'reasonTitle'],
    ['availSearch', 'nativePlaceholder']],
  ['models', { ...richData, models: [] }, ['availNone'], []],
]

for (const [tab, data, present, absent] of tabCases) {
  stateQueue = seed(data, tab)
  const tree = NativePanel({ ctx: panelCtx })
  stateQueue = []
  const blob = walk(tree, fresh()).texts.join('|')
  for (const needle of present) {
    assert.ok(blob.includes(needle), `tab ${tab}: expected ${JSON.stringify(needle)}`)
  }
  for (const needle of absent) {
    assert.ok(!blob.includes(needle), `tab ${tab}: must not contain ${JSON.stringify(needle)}`)
  }
  console.log(`ok  tab "${tab}" shows the right view`)
}

// ── the overview must stay small ─────────────────────────────────────────────
{
  // A guard against the regression this rewrite fixed: every new feature was
  // once appended to the overview, so the page grew without anyone deciding it
  // should. Pinning a ceiling makes that a test failure instead of a slow drift.
  stateQueue = seed(richData, 'overview')
  const tree = NativePanel({ ctx: panelCtx })
  stateQueue = []
  const rendered = walk(tree, fresh())
  // Count only the section headings, which is what a reader perceives as
  // "blocks", not the individual text nodes inside them.
  const headings = rendered.texts.filter(text =>
    text === 'budgetTitle' || text === 'diagTitle' || text === 'chainTitle'
    || text === 'regionTitle' || text === 'retiredTitle' || text === 'recoveryTitle'
    || text === 'reasonTitle' || text === 'toolTitle' || text === 'forecastTitle')
  assert.deepEqual(headings, ['budgetTitle'],
    `the overview must carry a single section (budget); found ${JSON.stringify(headings)}`)
  console.log('ok  the overview stays to one section')
}

// ── the health card reflects what needs attention ───────────────────────────
{
  // A clean pool says so rather than showing an empty list.
  stateQueue = seed({ ...richData, retired: [], regionBlocked: [], toolCapability: { tracked: [], deferred: [] } }, 'overview')
  const clean = walk(NativePanel({ ctx: panelCtx }), fresh()).texts.join('|')
  stateQueue = []
  assert.ok(clean.includes('healthAllGood'), 'a healthy pool must say it is healthy')

  // Each problem class surfaces as one attention row, and the count matches.
  stateQueue = seed({
    ...richData,
    retired: [{ platform: 'p', model: 'dead-model', reason: 'gone', at: 1 }],
    regionBlocked: [{ platform: 'q', model: 'blocked-model' }],
    toolCapability: { tracked: [], deferred: [{ key: 'r/demoted', until: Date.now() + 1000 }] },
  }, 'overview')
  const issues = walk(NativePanel({ ctx: panelCtx }), fresh()).texts.join('|')
  stateQueue = []
  assert.ok(issues.includes('healthAttention'), 'issues must be counted')
  assert.ok(issues.includes('attnRetired'), 'a retirement must be listed')
  assert.ok(issues.includes('attnRegion'), 'a region block must be listed')
  assert.ok(issues.includes('attnTools'), 'a tool demotion must be listed')
  assert.ok(!issues.includes('healthAllGood'), 'a pool with issues must not claim to be healthy')
  console.log('ok  the health card counts and names what needs attention')
}

// ── ToolCapability across every payload shape ────────────────────────────────
const toolCases = [
  ['nothing observed', { tracked: [], deferred: [] }, ['toolNone']],
  ['one observed', { tracked: [{ key: 'a/b', rejections: 1 }], deferred: [] },
    ['toolObserved', 'a/b', '1 toolRejects']],
  ['one deferred', { tracked: [], deferred: [{ key: 'x/y', until: Date.now() + 3_600_000 }] },
    ['toolDeferred', 'x/y']],
  ['both', {
    tracked: [{ key: 'p/m', rejections: 2 }],
    deferred: [{ key: 'q/n', until: Date.now() + 1000 }],
  }, ['toolObserved', 'toolDeferred', 'p/m', 'q/n']],
  ['missing arrays', {}, ['toolNone']],
  ['null arrays', { tracked: null, deferred: null }, ['toolNone']],
]

for (const [label, cap, expected] of toolCases) {
  const result = walk(ToolCapability({ t, data: { toolCapability: cap } }), fresh())
  assert.ok(result.nodes > 0, `${label}: must render something`)
  const blob = result.texts.join('|')
  for (const needle of expected) {
    assert.ok(
      blob.includes(needle),
      `${label}: expected ${JSON.stringify(needle)} in ${JSON.stringify(result.texts.slice(0, 12))}`,
    )
  }
  // The explanatory copy must always be present, so the block is never a
  // context-free list of model ids.
  assert.ok(result.texts.includes('toolTitle'), `${label}: title must render`)
  assert.ok(result.texts.includes('toolSub'), `${label}: explanation must render`)
  console.log(`ok  ToolCapability renders (${label})`)
}

// ── dictionary completeness, enforced where the strings live ────────────────
{
  const zh = Object.keys(DICT.zh)
  const en = Object.keys(DICT.en)
  assert.deepEqual(zh.filter(k => !en.includes(k)), [], 'every zh key needs an en value')
  assert.deepEqual(en.filter(k => !zh.includes(k)), [], 'every en key needs a zh value')
  // Every key the tool block asks for must exist, or the panel shows raw keys.
  for (const key of ['toolTitle', 'toolSub', 'toolObserved', 'toolDeferred', 'toolNone', 'toolRejects', 'toolUntil', 'toolHint']) {
    assert.ok(DICT.zh[key], `zh is missing ${key}`)
    assert.ok(DICT.en[key], `en is missing ${key}`)
  }
  console.log(`ok  dictionaries complete (${zh.length} keys x 2)`)
}

console.log('\nrender checks passed')
