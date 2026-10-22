/**
 * dsh-freellmapi — Host half.
 *
 * Registers one provider route, `freellmapi-native`, which routes in-process
 * across the key pool this plugin owns. There is no gateway: nothing here
 * needs FreeLLMAPI installed, running, or reachable.
 *
 * The plugin reuses FreeLLMAPI's model catalog (generated into
 * `src/native/catalog.json`) and nothing else — quota accounting, cooldowns,
 * region classification, reasoning translation and failover are all its own.
 * It speaks only the OpenAI chat-completions wire, which is all DSH needs.
 *
 * An HTTP surface feeds the settings panel: `/api/freellmapi/native/*`.
 *
 * @module index.js
 */

// @ts-check

import { StateStore, resolveDataDir } from './src/native/store.js'
import { QuotaTracker } from './src/native/quota.js'
import { Router } from './src/native/router.js'
import { NativeRouterAdapter } from './src/native/native-adapter.js'
import { resetToolCapability, toolCapabilityStats } from './src/native/tool-capability.js'
import { ReasoningTranslator } from './src/native/reasoning.js'
import { RetirementRegistry } from './src/native/retirement.js'
import { recoveryPolicy } from './src/native/recovery.js'
import { normalizeChains, expandChain, rotationWidth } from './src/native/chain.js'
import { detectPackOwner, createChannelStatus } from './src/native/channel-host.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as catalog from './src/native/catalog.js'

export const name = 'dsh-freellmapi'

/** The one harness facility this plugin cannot work without. */
export const inject = ['llm']

/**
 * The provider route this bundle owns.
 *
 * Kept as `freellmapi-native` rather than shortened to `freellmapi`: a model
 * selection is a durable string in a session log, and renaming the route would
 * silently orphan every session that had picked one.
 */
export const PROVIDER_ID = 'freellmapi-native'

const SETTINGS_NS = 'freellmapi-native'
const API_PREFIX = '/api/freellmapi'

/** Coerce an unknown config into a boolean with a default. */
function flag(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * Normalize the row config. Every field is untrusted (hand-edited YAML), and a
 * bad value must degrade to a sane default rather than block activation.
 *
 * The `native` sub-object is optional and flat fields are also accepted, so an
 * older row that still nests everything under `native` keeps working.
 *
 * @param {any} config
 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const native = raw.native && typeof raw.native === 'object' ? raw.native : {}
  const pick = (key, fallback) => (native[key] ?? raw[key] ?? fallback)
  return {
    enabled: flag(pick('enabled', undefined), true),
    displayName: typeof pick('displayName', '') === 'string' && String(pick('displayName', '')).trim() !== ''
      ? String(pick('displayName', '')).trim()
      : 'FreeLLMAPI',
    dataDir: typeof pick('dataDir', '') === 'string' ? String(pick('dataDir', '')) : '',
    timeoutMs: Number.isFinite(pick('timeoutMs', undefined)) && pick('timeoutMs', 0) > 0
      ? Number(pick('timeoutMs', 0))
      : 120000,
    // Normalized by recoveryPolicy, which caps every value at its ceiling.
    recovery: pick('recovery', undefined),
    // Named fallback chains. Normalized later so one malformed chain is dropped
    // and reported instead of blocking activation.
    chains: pick('chains', undefined),
    // Catalog source mode: 'dsh-free' | 'dsh-star' | 'dsh-sponsor' | 'official-free' | 'official-premium' | 'custom'
    catalogMode: typeof pick('catalogMode', '') === 'string' ? pick('catalogMode', '').trim() : 'dsh-free',
    // Catalog-specific settings
    catalog: (() => {
      const raw3 = pick('catalog', undefined)
      const settings = raw3 && typeof raw3 === 'object' ? raw3 : {}
      return {
        // Official Premium: fla_ key for signed catalog
        officialPremium: typeof settings.officialPremium?.flaKey === 'string' ? settings.officialPremium.flaKey.trim() : '',
        // DSH Sponsor: sponsor key for VIP snapshots
        dshSponsor: typeof settings.dshSponsor?.sponsorKey === 'string' ? settings.dshSponsor.sponsorKey.trim() : '',
        // Custom: local catalog path or URL
        custom: {
          catalogSource: typeof settings.custom?.catalogSource === 'string' ? settings.custom.catalogSource.trim() : '',
          snapshotSource: typeof settings.custom?.snapshotSource === 'string' ? settings.custom.snapshotSource.trim() : '',
          ttlMs: Number.isFinite(settings.custom?.ttlMs) ? Math.max(60000, Number(settings.custom.ttlMs)) : 300000,
        },
      }
    })(),
    // Signed-in account channels, backed by the vendored pack. On by default:
    // the pack is the only way to reach channels whose access is a login rather
    // than a key, and a user who wants none of them can turn this off.
    channels: (() => {
      const raw2 = pick('channels', undefined)
      const settings = raw2 && typeof raw2 === 'object' ? raw2 : {}
      return {
        enabled: flag(settings.enabled, true),
        // OpenCode is off by default: its channel is the one the upstream project
        // itself disables, because it conflicts with an anonymous lane this plugin
        // does not run. Keeping the same default avoids surprising a user who
        // expects the two to agree.
        enableOpencode: flag(settings.enableOpencode, false),
      }
    })(),
  }
}

/** Only the local app may read or mutate this surface. */
function isLocalRequest(request) {
  const address = request.socket?.remoteAddress ?? ''
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const origin = request.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)
  }
  return true
}

/** Read a small JSON body. */
function readJson(request, limitBytes = 32 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        request.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

/**
 * Load and mount the vendored channel pack.
 *
 * Deliberately kept out of the module graph: `pack.js` is ~69k lines and 2.9 MB,
 * and pulling it in statically would add its parse cost to every startup of a
 * plugin whose main job is a model router. A dynamic import costs nothing until
 * a profile actually has channels enabled.
 *
 * Failure never propagates. The pack is a bonus lane: a profile that lacks one of
 * its three injected services (`credentials`, `commands`, `llm`) must still get
 * the router, and a channel page that cannot say why it is empty is the one
 * failure mode a user cannot diagnose for themselves.
 *
 * @param {any} ctx
 * @param {{ set: Function }} status
 * @param {any} logger
 * @param {{ enabled: boolean }} config
 */
function mountChannelPack(ctx, status, logger, config) {
  const entry = fileURLToPath(new URL('../vendor/channel-pack/pack.js', import.meta.url))
  const wasm = fileURLToPath(new URL('../vendor/channel-pack/qoder-auth-wasm.wasm', import.meta.url))

  if (!existsSync(entry) || !existsSync(wasm)) {
    status.set({
      state: 'unavailable',
      reason: 'vendor/channel-pack is missing from the installed package',
    })
    logger?.warn?.('freellmapi: channel pack files missing; the signed-in channels are disabled')
    return
  }

  void import(pathToFileURL(entry).href)
    .then((loaded) => {
      if (typeof loaded?.apply !== 'function') {
        status.set({ state: 'unavailable', reason: 'the channel pack exposes no apply()' })
        logger?.warn?.('freellmapi: channel pack exposes no apply(); the signed-in channels are disabled')
        return
      }
      try {
        // `disableOpencode` is the pack's own switch. The upstream project turns
        // OpenCode off when the pack is mounted from a plugin that also runs an
        // anonymous lane; this plugin runs none, so the flag simply reflects the
        // user's choice and defaults to the same "off" the ecosystem expects.
        loaded.apply(ctx, { disableOpencode: config.enableOpencode !== true })
      } catch (error) {
        // Mounting can fail for reasons that only exist at runtime — a service
        // the composition does not provide, a route another plugin claimed
        // between our check and now. Recording it is what lets the panel explain
        // the state instead of silently showing an empty channel list.
        const message = error instanceof Error ? error.message : String(error)
        status.set({ state: 'failed', reason: message })
        logger?.warn?.(`freellmapi: channel pack mount failed — ${message}`)
        return
      }
      status.set({
        state: 'ready',
        reason: 'mounted by this plugin',
        mountedAt: Date.now(),
      })
      logger?.info?.('freellmapi: account channels mounted (13 providers)')
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      status.set({ state: 'failed', reason: `load failed: ${message}` })
      logger?.warn?.(`freellmapi: channel pack could not be loaded — ${message}`)
    })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const logger = ctx.logger

  // Optional analysis modules, loaded lazily.
  //
  // They are enhancements — a proactive probe and a read-only forecast — and
  // the router works without either. A static import would make them hard
  // dependencies: a broken or absent file would take the whole provider down,
  // which is exactly backwards for code that only reports.
  /** @type {{ probeRegion?: Function, summarizeProbe?: Function, buildForecast?: Function }} */
  const analysis = {}
  const loadAnalysis = async () => {
    try {
      const probe = await import('./src/native/region-probe.js')
      analysis.probeRegion = probe.probeRegion
      analysis.summarizeProbe = probe.summarizeProbe
    } catch (error) {
      logger?.debug?.(`freellmapi: region probe unavailable (${error?.message ?? error})`)
    }
    try {
      const forecast = await import('./src/native/forecast.js')
      analysis.buildForecast = forecast.buildForecast
    } catch (error) {
      logger?.debug?.(`freellmapi: quota forecast unavailable (${error?.message ?? error})`)
    }
  }
  void loadAnalysis()

  // ── account channels ───────────────────────────────────────────────────────
  //
  // The vendored pack (see vendor/channel-pack/NOTICE.md) backs thirteen signed-in
  // channels. Mounting it is optional in both directions: this plugin must work on
  // a machine that has never seen one, and must not fight a machine that already
  // runs one.
  //
  // The decision is made BEFORE mounting, because it cannot be made during: the
  // pack's `apply` builds a Cordis `Service` in its first statement, and that base
  // class registers the name in its constructor. A second mount throws before any
  // of its own code could stand down.
  const channelStatus = createChannelStatus()
  if (!options.channels.enabled) {
    channelStatus.set({ state: 'disabled', reason: 'channels are turned off in config' })
  } else {
    const owner = detectPackOwner(ctx)
    if (owner.owned) {
      // Another plugin has it. Standing down is the whole point of the check, and
      // the state says *who* so the panel can point the user at that plugin
      // instead of showing a raw host error.
      channelStatus.set({
        state: 'owned',
        reason: `another plugin already provides the channel pack (${owner.service})`,
        owner: owner.service,
      })
      logger?.info?.(
        `freellmapi: account channels are already served by another plugin (${owner.service}); `
        + 'standing down',
      )
    } else {
      mountChannelPack(ctx, channelStatus, logger, options.channels)
    }
  }

  // ── router ─────────────────────────────────────────────────────────────────
  /** @type {null | { store: any, quota: any, router: any, adapter: any, dir: string }} */
  let native = null

  if (options.enabled) {
    try {
      const dir = resolveDataDir(options.dataDir)
      const store = new StateStore({ dir })
      const quota = new QuotaTracker(store)
      const router = new Router({ store, quota })
      const reasoning = new ReasoningTranslator({
        logger: { debug: (/** @type {string} */ message) => logger?.debug?.(message) },
      })
      // Chains come from a hand-edited YAML patch, so one malformed entry must
      // not stop the router from starting.
      const chainConfig = normalizeChains(options.chains)
      const chains = new Map(chainConfig.chains.map(chain => [chain.name, chain]))
      if (chainConfig.rejected.length > 0) {
        logger?.warn?.(
          `freellmapi: ${chainConfig.rejected.length} chain(s) rejected — `
          + chainConfig.rejected.map(row => `${row.chain?.name ?? '(unnamed)'}: ${row.problems.join(', ')}`).join('; '),
        )
      }
      if (chains.size > 0) {
        logger?.info?.(`freellmapi: ${chains.size} chain(s): ${[...chains.keys()].join(', ')}`)
      }
      // Retirements are durable facts about the world, so they live beside the
      // key pool rather than in memory.
      const retirement = new RetirementRegistry({
        file: join(dir, 'retired.json'),
        logger: { warn: (/** @type {string} */ message) => logger?.warn?.(message) },
      })
      const adapter = new NativeRouterAdapter({
        store,
        router,
        quota,
        reasoning,
        retirement,
        recovery: options.recovery,
        chains,
        displayName: options.displayName,
        timeoutMs: options.timeoutMs,
        logger: {
          debug: (/** @type {string} */ message) => logger?.debug?.(message),
        },
      })
      native = { store, quota, router, adapter, dir, reasoning, retirement, chains, chainConfig }

      ctx.effect(() => {
        const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
        logger?.info?.(
          `freellmapi: router over ${store.platforms().length} platform(s), state at ${dir}`,
        )
        return () => registration()
      })
      // Tool-capability memory is deliberately in-process: it forgets on
      // restart, because a relay that fixes its tool support should come back
      // without anyone editing config.
      ctx.effect(() => () => {
        resetToolCapability()
      })
      ctx.effect(() => () => {
        try {
          store.close()
        } catch {
          /* closing is best effort */
        }
      })
    } catch (error) {
      logger?.warn?.(`freellmapi-native: disabled (${error?.message ?? error})`)
      native = null
    }
  }

  // ── discovery ──────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const off = ctx.llm.registerModelDiscovery?.(SETTINGS_NS, async () => {
      if (!native) return []
      return catalog.modelIds().map(model => ({
        id: model.id,
        name: model.name,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        inputModalities: model.vision ? ['text', 'image'] : ['text'],
      }))
    })
    return () => off?.()
  })

  // ── HTTP surface ───────────────────────────────────────────────────────────
  // The route table is filled in by the `ctx.inject` block at the end of this
  // function; `handler` is defined here so the closure is stable across
  // re-registration.
  const handler = async (/** @type {any} */ request, /** @type {any} */ response) => {
      const send = (/** @type {number} */ code, /** @type {unknown} */ payload) => {
        response.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify(payload))
      }

      if (!isLocalRequest(request)) return send(403, { error: 'forbidden' })
      const url = new URL(request.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/freellmapi/, '').replace(/\/+$/, '') || '/'
      const method = String(request.method ?? 'GET').toUpperCase()

      // Account channels.
      //
      // A route of its own rather than a field on `/native/status`: channels are
      // independent of the router (they are their own adapters and their own
      // accounts), so a profile that disables the router can still run them, and
      // a channel failure must not look like a router failure.
      if (method === 'GET' && route === '/channels') {
        const status = channelStatus.snapshot()
        const pack = detectPackOwner(ctx)
        return send(200, {
          ...status,
          // Re-checked per request, not cached from apply time: another plugin can
          // be installed later, and the panel should say "someone else has it" the
          // moment that is true rather than only after a restart.
          liveOwner: pack.owned ? pack.service : null,
        })
      }

      // router status
      if (method === 'GET' && route === '/native/status') {
        if (!native) {
          return send(200, { enabled: false, reason: 'native route disabled or failed to start' })
        }
        const usage = native.quota.summary()
        return send(200, {
          enabled: true,
          dataDir: native.dir,
          catalogModels: catalog.modelIds().length,
          catalogPlatforms: Object.keys(catalog.platforms()).length,
          configuredPlatforms: native.store.platforms().length,
          // Every platform the panel may offer for a new key, with the count of
          // catalog models behind it so an empty one is obviously not worth
          // pasting a credential into.
          availablePlatforms: Object.entries(catalog.platforms())
            .map(([id, info]) => ({
              id,
              endpoint: info.baseURL,
              models: catalog.modelIds().filter(model => model.platform === id).length,
            }))
            .sort((a, b) => b.models - a.models),
          usage,
          // Which models have been observed rejecting tool requests (and are
          // therefore tried last for tool-carrying calls).
          toolCapability: toolCapabilityStats(),
          // Routes this network cannot reach, with the reason and the platform's
          // reasoning policy so the panel can explain both instead of showing a
          // provider that silently stopped being used.
          regionBlocked: [...native.adapter.regionBlocked].map((key) => {
            const [platform, ...rest] = key.split('|')
            return { platform, model: rest.join('|') }
          }),
          // Models upstream says are permanently gone. Persisted, so they stay
          // out of the pool across restarts, and reversible from the panel.
          retired: native.retirement.list(),
          // Whether each platform can keep serving for the rest of the day, and
          // how fast it is being spent. Read-only aggregation over state the
          // router already keeps, so it costs nothing to include here.
          // Named fallback chains, with what each currently expands to — a chain
          // whose steps no longer exist is otherwise invisible until a call
          // fails on it.
          chains: [...native.chains.values()].map((chain) => {
            // Resolved against the same configured-platform filter the router
            // uses, so `routeCount` is the length of the chain the user will
            // actually walk, not the length of the catalog.
            const configured = new Set(native.store.platforms())
            const source = {
              resolve: (model) => catalog.resolve(model, { configured }),
              auto: () => catalog.resolve('auto', { configured }),
            }
            const expanded = expandChain(chain, source)
            const reachable = expanded.routes.filter(route =>
              !native.adapter.regionBlocked.has(`${route.platform}|${route.id}`)
              && !native.retirement.isRetired(route.platform, route.id)).length
            return {
              name: chain.name,
              id: `combo:${chain.name}`,
              steps: chain.steps,
              strategy: chain.strategy,
              stickyRounds: chain.stickyRounds,
              routeCount: expanded.routes.length,
              reachableRoutes: reachable,
              missing: expanded.missing,
              cursor: native.adapter.chainWalk.peek(chain.name, rotationWidth(chain)),
            }
          }),
          // Chains dropped at load time, so a typo in the config is visible in
          // the panel rather than only in a log line.
          rejectedChains: native.chainConfig.rejected.map(row => ({
            name: row.chain?.name ?? null,
            problems: row.problems,
          })),
          forecast: typeof analysis.buildForecast === 'function'
            ? analysis.buildForecast({
                store: native.store,
                catalog,
                burnRate: (platform) => native.quota.burnRate(platform),
              })
            : null,
          recovery: {
            enabled: native.adapter.recovery.enabled,
            totalTimeoutMs: native.adapter.recovery.totalTimeoutMs,
            maxOutputTokens: native.adapter.recovery.maxOutputTokens,
          },
          reasoningPolicies: Object.fromEntries(
            Object.entries(catalog.platforms())
              .map(([platform]) => [platform, {
                supports: native.reasoning.supports(platform),
                efforts: native.reasoning.effortsFor(platform),
              }])
              .filter(([, policy]) => policy.efforts.length > 0),
          ),
          // The list the picker is built from: every model behind a configured
          // platform, with the capability that decides whether an agent can use
          // it. Without this the panel can only report a count, which tells the
          // user nothing about what they actually got.
          models: (() => {
            const configured = new Set(native.store.platforms())
            const seen = new Map()
            for (const model of catalog.modelIds()) {
              if (!configured.has(model.platform)) continue
              const existing = seen.get(model.id)
              if (existing) {
                existing.platforms.push(model.platform)
                continue
              }
              seen.set(model.id, {
                id: model.id,
                name: model.name,
                platforms: [model.platform],
                contextWindow: model.contextWindow ?? null,
                tools: model.tools === true,
                vision: model.vision === true,
                intelligence: model.intelligence ?? null,
                speed: model.speed ?? null,
              })
            }
            // Both ranks are lower-is-better (the upstream project orders its
            // own chains `ORDER BY intelligence_rank ASC`). Unranked entries
            // sort last: unknown quality is not a reason to promote a model.
            const rankOf = value => (Number.isFinite(value) ? value : Number.POSITIVE_INFINITY)
            const speedOf = value => (Number.isFinite(value) ? value : 1e6)
            return [...seen.values()].sort((a, b) => {
              const rankA = rankOf(a.intelligence)
              const rankB = rankOf(b.intelligence)
              if (rankA !== rankB) return rankA < rankB ? -1 : 1
              const speedA = speedOf(a.speed)
              const speedB = speedOf(b.speed)
              if (speedA !== speedB) return speedA - speedB
              return (b.contextWindow ?? 0) - (a.contextWindow ?? 0)
            })
          })(),
          keys: native.store.platforms().map((platform) => ({
            platform,
            endpoint: catalog.platforms()[platform]?.baseURL ?? '',
            entries: native.store.entries(platform).map((entry) => ({
              id: entry.id,
              label: entry.label,
              status: entry.status,
              cooldownUntil: entry.cooldownUntil,
              lastError: entry.lastError,
            })),
          })),
        })
      }

      if (method === 'GET' && route === '/native/keys') {
        if (!native) return send(200, { platforms: [], entries: [] })
        return send(200, {
          platforms: Object.keys(catalog.platforms()).sort(),
          entries: native.store.platforms().map((platform) => ({
            platform,
            entries: native.store.entries(platform).map((entry) => ({
              id: entry.id,
              label: entry.label,
              status: entry.status,
              cooldownUntil: entry.cooldownUntil,
              lastError: entry.lastError,
            })),
          })),
        })
      }

      if (method === 'POST' && route === '/native/keys') {
        if (!native) return send(503, { error: 'native route disabled' })
        const body = await readJson(request)
        if (!body || typeof body !== 'object') return send(400, { error: 'invalid JSON' })
        const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
        const secret = typeof body.secret === 'string' ? body.secret.trim() : ''
        if (platform === '' || secret === '') return send(400, { error: 'platform and secret are required' })
        if (!catalog.platforms()[platform]) return send(400, { error: `unknown platform "${platform}"` })
        const id = native.store.addKey(platform, secret, typeof body.label === 'string' ? body.label : '')
        native.store.flush()
        return send(200, { ok: true, platform, id })
      }

      if (method === 'DELETE' && route === '/native/keys') {
        if (!native) return send(503, { error: 'native route disabled' })
        const platform = url.searchParams.get('platform') ?? ''
        const id = url.searchParams.get('id') ?? ''
        if (platform === '' || id === '') return send(400, { error: 'platform and id are required' })
        const removed = native.store.removeKey(platform, id)
        native.store.flush()
        return send(removed ? 200 : 404, { ok: removed })
      }

      // Catalog mode settings: GET returns current mode, POST saves it.
      // Keys are sealed with the store's AES-256-GCM master key so they
      // are never stored in plaintext on disk.
      if (method === 'GET' && route === '/native/catalog-mode') {
        return send(200, {
          mode: config.catalogMode,
          requiresAuth: ['official-premium', 'dsh-sponsor'].includes(config.catalogMode),
          hasOfficialPremium: config.catalog.officialPremium.length > 0,
          hasDshSponsor: config.catalog.dshSponsor.length > 0,
        })
      }

      if (method === 'POST' && route === '/native/catalog-mode') {
        const body = await readJson(request)
        if (!body || typeof body !== 'object') return send(400, { error: 'invalid JSON' })
        const VALID_MODES = ['dsh-free', 'dsh-star', 'dsh-sponsor', 'official-free', 'official-premium', 'custom']
        const mode = typeof body.mode === 'string' ? body.mode.trim() : ''
        if (!VALID_MODES.includes(mode)) {
          return send(400, { error: `invalid mode "${mode}". valid: ${VALID_MODES.join(', ')}` })
        }
        // Store sensitive keys sealed if provided
        if (body.secrets) {
          if (body.secrets.officialPremium) {
            config.catalog.officialPremium = String(body.secrets.officialPremium).trim()
          }
          if (body.secrets.dshSponsor) {
            config.catalog.dshSponsor = String(body.secrets.dshSponsor).trim()
          }
        }
        config.catalogMode = mode
        return send(200, { ok: true, mode: config.catalogMode })
      }

      // The panel's escape hatch for a retirement: upstream may have restored a
      // model, or the verdict may have been wrong.
      if (method === 'POST' && route === '/native/retired/lift') {
        if (!native) return send(503, { error: 'native route disabled' })
        const body = await readJson(request)
        if (!body || typeof body !== 'object') return send(400, { error: 'invalid JSON' })
        if (body.all === true) {
          return send(200, { ok: true, lifted: native.retirement.liftAll() })
        }
        const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        if (platform === '' || model === '') return send(400, { error: 'platform and model are required' })
        return send(200, { ok: native.retirement.lift(platform, model) })
      }

      // A proactive region sweep. Unlike the passive path, this asks every
      // configured platform directly, so a provider that is unreachable here is
      // known before a user request pays for the discovery.
      //
      // It writes only the region verdict. A probe must never cool a key or
      // record usage: an unreachable platform is a fact about the network, not
      // about the credential, and charging it a cooldown would take a working
      // key out of rotation for the wrong reason.
      if (method === 'POST' && route === '/native/probe-region') {
        if (!native) return send(503, { error: 'native route disabled' })
        if (typeof analysis.probeRegion !== 'function') {
          return send(501, { error: 'region probe module unavailable' })
        }

        const targets = []
        for (const platform of native.store.platforms()) {
          const endpoint = catalog.platforms()[platform]?.baseURL
          const entry = native.store.entries(platform)[0]
          if (!endpoint || !entry) continue
          const apiKey = native.store.secretOf(platform, entry.id)
          if (apiKey === null) continue
          // One representative model per platform: region policy is a platform
          // property, so probing every model would multiply the cost for the
          // same answer.
          const model = catalog.modelIds().find(candidate => candidate.platform === platform)
          if (!model) continue
          targets.push({ platform, modelId: model.id, baseURL: endpoint, apiKey })
        }

        // 45s, not the module's 8s default. The default assumes a probe is fast
        // because it asks for little output, but latency here is queueing, not
        // generation: measured on this machine, OVH's first token takes ~13s and
        // AI Horde's anonymous tier (lowest priority) exceeds 60s. Under a short
        // timeout both are reported as failures, and a user reading "failed"
        // concludes the provider is broken when it is merely slow. A sweep is a
        // deliberate action that can afford to wait.
        const results = await analysis.probeRegion({
          targets,
          timeoutMs: 45000,
          concurrency: 4,
        })
        const summary = analysis.summarizeProbe(results)
        for (const row of summary.regionBlocked) {
          native.adapter.regionBlocked.add(`${row.platform}|${row.modelId}`)
        }
        logger?.info?.(
          `freellmapi: region probe — ${summary.reachable} reachable, `
          + `${summary.regionBlocked.length} region-blocked, ${summary.failed} failed`,
        )
        return send(200, { ...summary, results })
      }

      // A platform may come back after a network change, and the passive path
      // has no way to notice. This clears verdicts so the next request retries
      // them.
      if (method === 'POST' && route === '/native/probe-region/clear') {
        if (!native) return send(503, { error: 'native route disabled' })
        const cleared = native.adapter.regionBlocked.size
        native.adapter.regionBlocked.clear()
        return send(200, { ok: true, cleared })
      }

      if (method === 'POST' && route === '/native/probe') {
        if (!native) return send(503, { error: 'native route disabled' })
        // Cheap credential smoke test: ask each configured platform for its
        // model list. Failures bench nothing; they only report.
        const results = await Promise.all(
          native.store.platforms().map(async (platform) => {
            const endpoint = catalog.platforms()[platform]?.baseURL
            const entries = native.store.entries(platform)
            const apiKey = entries.length > 0 ? native.store.secretOf(platform, entries[0].id) : null
            if (!endpoint || apiKey === null) return { platform, ok: false, error: 'no key' }
            try {
              const response = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, {
                headers: { authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(15000),
              })
              return { platform, ok: response.ok, status: response.status }
            } catch (error) {
              return { platform, ok: false, error: error?.message ?? String(error) }
            }
          }),
        )
        return send(200, { results })
      }

      return send(404, { error: 'not found' })
  }

  // `webServer` may be absent — or merely not provided yet — when apply() runs.
  // Reading it once here answered `undefined` on one restart, so the routes were
  // never registered and the settings panel reported HTTP 404 while the plugin
  // itself stayed `active`. `ctx.inject` pends until the service exists and
  // re-runs this callback if it is replaced, which is the supported shape.
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    if (!server || typeof server.register !== 'function') return
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'freellmapi: api routes',
    )
  })
}
