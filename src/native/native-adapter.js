/**
 * The in-process adapter: DSH's model calls routed directly across the
 * platform pool, with no FreeLLMAPI process in between.
 *
 * This is the "native" counterpart to `src/adapter.js` (which forwards to a
 * running gateway). Both implement the same DSH adapter contract, so a profile
 * can mount either or both.
 *
 * @module src/native/native-adapter.js
 */

// @ts-check

import { buildChatBody, streamChatCompletion } from '../openai.js'
import { executeOnce } from './execute.js'
import { describeBlock } from './quota.js'
import { classifyFailure } from './region.js'
import { ReasoningTranslator } from './reasoning.js'
import { RetirementRegistry } from './retirement.js'
import { estimateTokens } from './tokens.js'
import {
  recoveryPolicy,
  canRecover,
  recoveryMessages,
} from './recovery.js'
import { chainNameOf, expandChain, rotationWidth } from './chain.js'
import { ChainWalk } from './chain-walk.js'
import * as catalog from './catalog.js'

/** A terminal failure chunk. */
function failure(message, code, status) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message,
        code,
        ...(Number.isFinite(status) && status > 0 ? { status } : {}),
      },
    },
  }
}

export class NativeRouterAdapter {
  /**
   * @param {{
   *   store: import('./store.js').StateStore,
   *   router: import('./router.js').Router,
   *   quota: import('./quota.js').QuotaTracker,
   *   displayName?: string,
   *   timeoutMs?: number,
   *   logger?: any,
   *   resolve?: (model: string) => any[],
   *   platforms?: () => Record<string, { baseURL: string }>,
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store
    this.router = deps.router
    this.quota = deps.quota
    this.displayName = deps.displayName || 'FreeLLMAPI (native)'
    this.timeoutMs = deps.timeoutMs ?? 120_000
    this.logger = deps.logger
    // Injectable so the routing loop can be exercised against a fixed candidate
    // set; production uses the shipped catalog.
    //
    // The resolve wrapper restricts every lookup to platforms with a key. That
    // belongs here rather than at each call site: an `auto` request on this
    // machine resolves 342 routes of which 60 are usable, so without it every
    // call walks 282 dead routes and a chain reports a length it cannot serve.
    this.resolve = deps.resolve ?? ((model) => catalog.resolve(model, {
      configured: new Set(this.store.platforms()),
    }))
    this.platforms = deps.platforms ?? catalog.platforms
    this.reasoning = deps.reasoning ?? new ReasoningTranslator({ logger: deps.logger })
    /** Models observed to be unreachable from this network: "platform|model". */
    this.regionBlocked = deps.regionBlocked ?? new Set()
    /** Persisted retirements, so a dead model stops costing a round trip. */
    this.retirement = deps.retirement ?? new RetirementRegistry({ logger: deps.logger })
    /** Recovery from turns that produced no answer. */
    this.recovery = recoveryPolicy(deps.recovery)
    /** Named fallback chains, keyed by name. Empty when none are configured. */
    this.chains = deps.chains ?? new Map()
    /** Rotation state for `round-robin` chains. */
    this.chainWalk = deps.chainWalk ?? new ChainWalk()
  }

  /** @param {string} provider */
  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  /** Let DSH own retries; this adapter already fails over internally. */
  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image?.width ?? 1024, height: image?.height ?? 1024, maxBytes: 1024 * 1024 }
  }

  /**
   * Advertise the models the pool can actually serve: a model whose platform
   * has no key yet is not offered, because selecting it could only fail.
   *
   * @param {string} provider
   */
  listModels(provider) {
    const configured = new Set(this.store.platforms())
    const seen = new Set()
    const out = []
    for (const model of catalog.modelIds()) {
      if (!configured.has(model.platform)) continue
      if (seen.has(model.id)) continue
      seen.add(model.id)
      out.push({
        provider,
        id: model.id,
        name: model.name,
        description: catalog.describe(model),
        inputModalities: model.vision ? ['text', 'image'] : ['text'],
      })
    }

    // Chains are offered as virtual models, listed first so a user who built one
    // sees it above the raw catalog they built it from. Collected then prepended
    // in order: `unshift` inside the loop would reverse them, showing a user's
    // chains in the opposite order to the one they wrote.
    /** @type {any[]} */
    const chainModels = []
    for (const chain of this.chains.values()) {
      const expired = expandChain(chain, {
        resolve: (model) => this.resolve(model),
        auto: () => this.resolve('auto'),
      })
      chainModels.push({
        provider,
        id: `combo:${chain.name}`,
        name: chain.name,
        description: `chain · ${chain.strategy} · ${expired.routes.length} route(s)`,
        inputModalities: ['text'],
      })
    }
    out.unshift(...chainModels)

    return out
  }

  /**
   * @param {string} provider
   * @param {string} model
   */
  resolveModel(provider, model) {
    if (model === 'fusion') {
      /** @type {any} */
      const resolved = { provider, id: model, name: 'Fusion (not supported by the native router)' }
      return resolved
    }

    // A chain is addressed like a model, so this reports the *first route it
    // would try* as the model's identity. The name stays the chain's own, though:
    // a picker showing the underlying model would be wrong the moment
    // round-robin moves the chain on.
    const chainName = chainNameOf(model)
    if (chainName !== null) {
      const chain = this.chains.get(chainName)
      if (!chain) {
        return { provider, id: model, name: `${model} (unknown chain)` }
      }
      const expanded = expandChain(chain, {
        resolve: (candidate) => this.resolve(candidate),
        auto: () => this.resolve('auto'),
      })
      // Context and reasoning come from a route the chain can actually reach, so
      // the picker does not advertise a menu no member of the chain honours.
      const route = expanded.routes[0]
      /** @type {any} */
      const resolved = { provider, id: model, name: chain.name }
      if (route?.contextWindow) resolved.context = { contextWindow: route.contextWindow }
      if (route?.tools) resolved.tools = true
      if (route) {
        const reasoning = this.reasoning.describeFor(route.platform)
        if (reasoning) resolved.reasoning = reasoning
      }
      return resolved
    }

    const matches = this.resolve(model)
    const first = matches[0]
    /** @type {any} */
    const resolved = {
      provider,
      id: model,
      name: first?.name ?? model,
    }
    if (first?.contextWindow) resolved.context = { contextWindow: first.contextWindow }
    if (first?.tools) resolved.tools = true

    // Declaring the reasoning menu is what makes DSH offer it. This is reported
    // from the *first* candidate, which is the route dispatch normally takes;
    // when a model is served by several platforms with different scales, the
    // translation at dispatch time clamps to whatever the chosen platform
    // accepts, so a menu entry can still be honoured as the nearest value
    // rather than being rejected.
    if (first) {
      const reasoning = this.reasoning.describeFor(first.platform)
      if (reasoning) resolved.reasoning = reasoning
    }
    return resolved
  }

  /** @param {string} provider @param {string} model */
  async prepareCall(provider, model) {
    const resolved = this.resolveModel(provider, model)
    return { model: resolved, stream: (/** @type {any} */ options) => this.stream(options) }
  }

  /**
   * Route one call across the pool.
   *
   * @param {any} options DSH GenerateOptions
   * @returns {AsyncGenerator<any, void, void>}
   */
  async *stream(options) {
    const requested = String(options?.model ?? '')
    if (requested === 'fusion') {
      yield failure(
        'this adapter does not implement fusion; pick `auto` or a concrete model',
        'UNSUPPORTED_MODEL',
      )
      return
    }

    // A chain is expanded into ordinary candidate routes before anything else
    // runs, so the region filter, retirement filter, tool demotion and quota
    // logic below apply to it with no special case. The only chain-specific
    // behaviour is the start offset `round-robin` rotation produces.
    const chainName = chainNameOf(requested)
    let resolved
    if (chainName !== null) {
      const chain = this.chains.get(chainName)
      if (!chain) {
        yield failure(
          `unknown chain "${chainName}"; configure it in the FreeLLMAPI settings panel`,
          'UNKNOWN_CHAIN',
        )
        return
      }
      // Rotation is measured in *steps*, not routes: one step can expand to
      // several platforms, and rotating per route would show the same model name
      // twice in a row instead of moving on.
      const offset = this.chainWalk.nextOffset(chainName, rotationWidth(chain), chain)
      const expanded = expandChain(chain, {
        resolve: (model) => this.resolve(model),
        auto: () => this.resolve('auto'),
      }, offset)
      if (expanded.routes.length === 0) {
        yield failure(
          `chain "${chainName}" resolved to no routes`
          + (expanded.missing.length > 0 ? ` (unknown: ${expanded.missing.join(', ')})` : ''),
          'EMPTY_CHAIN',
        )
        return
      }
      if (expanded.missing.length > 0) {
        // Worth a line: the user's chain is shorter than they wrote, and the
        // usual cause is a retired or renamed model.
        this.logger?.debug?.(
          `freellmapi-native: chain "${chainName}" skipped unknown step(s): ${expanded.missing.join(', ')}`,
        )
      }
      resolved = expanded.routes
    } else {
      resolved = this.resolve(requested)
    }

    if (resolved.length === 0) {
      // "No key for this platform" and "there is no such model" are different
      // problems, and the filtered resolve collapses them into one empty array.
      // Asking the unfiltered catalog separates them: a model the catalog knows
      // but no configured platform serves is a setup problem, and telling the
      // user the name is unknown would send them looking for a typo.
      const knownAnywhere = catalog.resolve(requested, { includeUnconfigured: true })
      if (knownAnywhere.length > 0) {
        const platforms = [...new Set(knownAnywhere.map(route => route.platform))]
        yield failure(
          `"${requested}" is offered by ${platforms.join(', ')}, but no key is configured for `
          + `${platforms.length === 1 ? 'that platform' : 'any of them'}. `
          + 'Add one in the FreeLLMAPI settings panel.',
          'NO_ROUTE',
        )
        return
      }
      yield failure(`unknown model "${requested}"`, 'UNKNOWN_MODEL')
      return
    }

    // A request that carries tools needs a model that can actually emit
    // structured tool calls; the router demotes, but never drops, candidates
    // the catalog does not flag for it.
    const requireTools = Array.isArray(options.tools) && options.tools.length > 0
    // Two reasons a route is not even offered. Neither benches the key: a
    // region block is about the network, and a retirement is about the model, so
    // the credential stays usable for everything else it can serve.
    const usable = resolved.filter((model) => {
      const key = `${model.platform}|${model.id}`
      if (this.regionBlocked.has(key)) return false
      return !this.retirement.isRetired(model.platform, model.id)
    })
    const { attempts, skipped, reasons } = this.router.candidates(usable, { requireTools })
    if (attempts.length === 0) {
      const parts = []
      if (skipped.noKey > 0) parts.push(`${skipped.noKey} model route(s) have no key configured`)
      if (skipped.cooling > 0) parts.push(`${skipped.cooling} key(s) cooling down`)
      if (skipped.quota > 0) parts.push(`${skipped.quota} at quota limit`)
      const blocked = resolved.length - usable.length
      if (blocked > 0) parts.push(`${blocked} unavailable from this network or retired`)
      const detail = reasons.length > 0 ? ` — ${reasons.join('; ')}` : ''
      yield failure(
        `no usable route for "${requested}": ${parts.join(', ') || 'pool empty'}${detail}`
        + '. Add a platform key in the FreeLLMAPI settings panel.',
        'NO_ROUTE',
      )
      return
    }

    const body = buildChatBody(options)
    /** @type {string[]} */
    const errors = []
    // Identity for this call, so one request failing over across a model's
    // sibling keys counts as one observation rather than several.
    const requestToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const requestedEffort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)

    for (const attempt of attempts) {
      if (options.signal?.aborted) {
        yield failure('request aborted', 'ABORTED')
        return
      }

      const endpoint = this.platforms()[attempt.platform]?.baseURL
      if (!endpoint) {
        errors.push(`${attempt.platform}: no endpoint`)
        continue
      }
      const apiKey = this.store.secretOf(attempt.platform, attempt.keyId)
      if (apiKey === null) {
        // The seal no longer opens: the master key changed under us. Bench it
        // hard so the pool stops offering a credential it cannot read.
        this.store.patchKey(attempt.platform, attempt.keyId, {
          status: 'invalid',
          cooldownUntil: Date.now() + 86_400_000,
          lastError: 'stored key could not be decrypted',
        })
        errors.push(`${attempt.platform}: stored key unreadable`)
        continue
      }

      // Translate the effort per platform: forwarding DSH's id verbatim draws a
      // 400 from providers whose enum is narrower, and dropping it silently
      // ignores a control the user explicitly set.
      const attemptBody = { ...body, model: attempt.model }
      const effortResult = this.reasoning.apply(attempt.platform, attemptBody, requestedEffort)
      if (requestedEffort !== undefined && effortResult.sent !== null && effortResult.sent !== requestedEffort) {
        this.logger?.debug?.(
          `freellmapi-native: reasoning effort ${requestedEffort} -> ${effortResult.sent} for ${attempt.platform}`,
        )
      }

      const outcome = await executeOnce({
        endpoint,
        platform: attempt.platform,
        apiKey,
        body: attemptBody,
        signal: options.signal,
        timeoutMs: this.timeoutMs,
      })

      if (!outcome.ok) {
        const status = outcome.status
        const classification = classifyFailure({ status, message: outcome.message })
        const badRequest = status === 400 || status === 422

        // Region and permission verdicts are not the credential's fault: the
        // same key works from another network. Excluding the route (rather than
        // benching the key) keeps a working credential in the pool for every
        // other model it can serve, and makes the reason reportable.
        if (classification.region) {
          this.regionBlocked.add(`${attempt.platform}|${attempt.model}`)
          errors.push(`${attempt.platform}/${attempt.model}: ${classification.reason}`)
          this.logger?.debug?.(
            `freellmapi-native: ${attempt.platform}/${attempt.model} reported unavailable from this location;`
            + ' excluding the route (the key stays usable for other models)',
          )
          continue
        }

        // A definitive "this model is gone" verdict retires the route so the
        // next request does not pay the same round trip forever. The registry
        // corroborates probable signals, so one flaky 404 cannot kill a healthy
        // model — see retirement.js.
        if (this.retirement.note(attempt.platform, attempt.model, {
          status,
          message: outcome.message,
        }, requestToken)) {
          errors.push(`${attempt.platform}/${attempt.model}: retired (upstream reports it gone)`)
          this.logger?.debug?.(`freellmapi-native: ${attempt.platform}/${attempt.model} retired`)
          continue
        }

        // A tool-carrying request rejected as a bad request may mean this model
        // cannot emit structured tool calls, which is a property of the model —
        // not of the request. Record it and fail over, so a mis-declared model
        // in the catalog costs one attempt rather than the whole call. (This is
        // also what the upstream project does; a genuinely malformed tool schema
        // 400s everywhere, deferring every model equally and changing nothing.)
        const toolRejected = badRequest && requireTools
        if (toolRejected) {
          const deferred = this.router.noteToolFailure(attempt.platform, attempt.model, status)
          if (deferred) {
            this.logger?.debug?.(
              `freellmapi-native: ${attempt.platform}/${attempt.model} keeps rejecting tool requests;`
              + ' trying it last for the next 6h',
            )
          }
        }

        // Only bench the key when the failure actually implicates the credential.
        const benchMs = classification.outcome === 'transient' || classification.outcome === 'invalid'
          ? this.router.bench(attempt.platform, attempt.keyId, outcome)
          : 0
        errors.push(
          `${attempt.platform}/${attempt.model}: ${status === 0 ? '' : `HTTP ${status} `}${outcome.message.slice(0, 160)}`
          + (benchMs > 0 ? ` (${classification.reason}, benched ${Math.round(benchMs / 1000)}s)` : ''),
        )
        this.logger?.debug?.(`freellmapi-native: attempt failed: ${errors[errors.length - 1]}`)

        // Without tools on the request, a bad request is the caller's problem:
        // every other platform would reject it identically, so stop here rather
        // than burning the rest of the pool.
        if (badRequest && !toolRejected) {
          yield failure(
            `upstream rejected the request: ${outcome.message.slice(0, 300)}`,
            'BAD_REQUEST',
            status,
          )
          return
        }
        continue
      }

      // Headers arrived; from here on a transport failure cannot simply move to
      // the next candidate, because the caller may already hold partial output.
      // But a stream that broke *before producing anything* is recoverable, and
      // a normal stop with no answer text is recoverable for the same reason:
      // the user has nothing either way.
      const started = Date.now()
      const attemptState = { sawText: false, sawToolCall: false, reasoningText: '', usage: null }
      let produced = ''
      // The raw upstream finish reason. `stop` means the model chose to end;
      // `length` / `max_tokens` means the budget ran out. Both can leave the
      // user with nothing, and both are worth re-asking — a truncated-at-budget
      // turn that spent everything on hidden reasoning is the most common shape
      // of "the model said nothing" seen in practice.
      let finishToken = ''

      try {
        for await (const chunk of streamChatCompletion(outcome.stream, options.signal)) {
          if (chunk.type === 'usage') attemptState.usage = chunk.usage
          else if (chunk.type === 'text-delta') {
            produced += chunk.text
            if (chunk.text.trim() !== '') attemptState.sawText = true
          } else if (chunk.type === 'reasoning-delta') {
            attemptState.reasoningText += chunk.text
          } else if (chunk.type === 'finish') {
            finishToken = chunk.reason?.kind ?? ''
          } else if (chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call') {
            attemptState.sawToolCall = true
          }
          yield chunk
        }
      } catch (error) {
        // A broken stream is only worth re-asking when the caller has nothing;
        // otherwise the honest report is that generation was cut off.
        if (canRecover(attemptState, this.recovery, Date.now() - started)) {
          yield* this.recover({
            options,
            attempt,
            endpoint,
            apiKey,
            attemptBody,
            state: attemptState,
            started,
            errors,
            reason: 'stream broke before producing output',
          })
          return
        }
        yield failure(
          `stream from ${attempt.platform}/${attempt.model} broke: ${error?.message ?? error}`,
          'STREAM_BROKEN',
        )
        return
      }

      // A finished turn with no answer text at all. That covers both the clean
      // `stop` with nothing to show and the `length` cut where the whole output
      // budget went to hidden reasoning — the latter is the more common case and
      // produces exactly the same empty turn for the caller.
      const endedWithNothing = (finishToken === 'stop' || finishToken === 'max-tokens')
        && canRecover(attemptState, this.recovery, Date.now() - started)
      if (endedWithNothing) {
        yield* this.recover({
          options,
          attempt,
          endpoint,
          apiKey,
          attemptBody,
          state: attemptState,
          started,
          errors,
          reason: attemptState.reasoningText.trim() === ''
            ? `finished (${finishToken}) with no output and no reasoning frames`
            : `finished (${finishToken}) with reasoning but no answer`,
        })
        return
      }

      const usage = attemptState.usage
      const tokens = usage?.totalTokens
        ?? (usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : estimateTokens(produced))
      this.router.record(attempt.platform, attempt.keyId, attempt.model, tokens)
      this.router.clear(attempt.platform, attempt.keyId)
      // A tool-carrying request that got this far proves the catalog's flag was
      // wrong in the pessimistic direction; forget any accumulated suspicion.
      if (requireTools) this.router.noteToolSuccess(attempt.platform, attempt.model)
      this.logger?.debug?.(
        `freellmapi-native: served "${requested}" via ${attempt.platform}/${attempt.model} (${tokens} tokens)`,
      )
      return
    }

    yield failure(
      `every route failed for "${requested}": ${errors.slice(0, 4).join(' | ')}`,
      'ALL_FAILED',
    )
  }

  /**
   * Re-ask the same route once, with the reasoning checkpoint and an explicit
   * instruction to answer rather than re-analyse.
   *
   * No failover here on purpose: the same route is the point of the retry (the
   * thinking budget was the problem, not the route), and a second dead end
   * should surface as the empty turn it is rather than silently walking the
   * pool for another model that will think itself empty too.
   */
  async *recover({ options, attempt, endpoint, apiKey, attemptBody, state, started, errors, reason }) {
    this.logger?.debug?.(
      `freellmapi-native: ${attempt.platform}/${attempt.model} ${reason}; asking once more`,
    )
    const messages = recoveryMessages(options.messages ?? [], state.reasoningText)
    const retryBody = {
      ...attemptBody,
      messages: buildChatBody({ ...options, messages }).messages,
      max_tokens: Math.max(256, this.recovery.maxOutputTokens),
    }

    const outcome = await executeOnce({
      endpoint,
      platform: attempt.platform,
      apiKey,
      body: retryBody,
      signal: options.signal,
      timeoutMs: this.timeoutMs,
    })

    if (!outcome.ok) {
      errors.push(`${attempt.platform}/${attempt.model} (recovery): ${outcome.message.slice(0, 120)}`)
      yield failure(
        `${reason}; the retry also failed: ${outcome.message.slice(0, 200)}`,
        'RECOVERY_FAILED',
        outcome.status,
      )
      return
    }

    let text = ''
    let usage = null
    try {
      for await (const chunk of streamChatCompletion(outcome.stream, options.signal)) {
        if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'text-delta') text += chunk.text
        yield chunk
      }
    } catch (error) {
      yield failure(
        `recovery stream from ${attempt.platform}/${attempt.model} broke: ${error?.message ?? error}`,
        'RECOVERY_BROKEN',
      )
      return
    }

    const tokens = usage?.totalTokens
      ?? (usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : estimateTokens(text))
    this.router.record(attempt.platform, attempt.keyId, attempt.model, tokens)

    if (text.trim() === '') {
      // Neither attempt produced anything. Reporting this as an error is more
      // honest than returning an empty success the user cannot act on.
      yield failure(
        `${attempt.platform}/${attempt.model} returned no answer twice (${reason});`
        + ' the model may be sharing its whole output budget with hidden reasoning.',
        'EMPTY_AFTER_RECOVERY',
      )
      return
    }

    this.router.clear(attempt.platform, attempt.keyId)
    this.logger?.debug?.(
      `freellmapi-native: recovered via ${attempt.platform}/${attempt.model} after ${Date.now() - started}ms`,
    )
  }
}
