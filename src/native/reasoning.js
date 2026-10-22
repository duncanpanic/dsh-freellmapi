/**
 * Reasoning-effort translation.
 *
 * DSH sends one `reasoningEffort` id; upstream providers disagree on how to
 * express it, and several reject an unlisted value with a 400 rather than
 * clamping. So the knob cannot simply be forwarded — it has to be translated,
 * clamped, or deliberately dropped per platform.
 *
 * The policies below mirror what the upstream FreeLLMAPI project learned
 * provider by provider; each cites the failure that motivated it. The rule of
 * thumb it arrived at:
 *
 *   * forward when the provider documents the field;
 *   * clamp when it accepts only a subset (a clamp still honours intent, while
 *     a dropped knob silently ignores the user);
 *   * drop only when the provider has no request-side control at all.
 *
 * @module src/native/reasoning.js
 */

// @ts-check

/** The full scale, weakest to strongest. */
export const EFFORT_SCALE = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Display metadata for the DSH model picker. */
export const EFFORT_LABELS = {
  off: { name: 'Off', description: 'No reasoning' },
  minimal: { name: 'Minimal', description: 'Least thinking' },
  low: { name: 'Low', description: 'Light thinking' },
  medium: { name: 'Medium', description: 'Balanced' },
  high: { name: 'High', description: 'Deep thinking' },
  xhigh: { name: 'Very high', description: 'Very deep thinking' },
  max: { name: 'Max', description: 'Maximum thinking' },
}

/** Numeric position of an effort on the scale, or -1 when unknown. */
function positionOf(effort) {
  return EFFORT_SCALE.indexOf(String(effort))
}

/** Clamp an effort to the nearest accepted value. */
function clampTo(effort, accepted) {
  const target = positionOf(effort)
  if (target === -1) return undefined
  let best = accepted[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of accepted) {
    const distance = Math.abs(positionOf(candidate) - target)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Per-platform policy.
 *
 * `accepts` clamps to the nearest member instead of forwarding an unsupported
 * value. `drop` means the platform has no request-side reasoning control.
 *
 * A policy for a platform the shipped catalog cannot currently reach is dead
 * code, so `test/region-reasoning.mjs` asserts every key here resolves against
 * the catalog. Cloudflare is the one exception kept on purpose: it needs an
 * account id, so the catalog leaves it unresolved, but if that is ever wired up
 * its policy is already correct (Workers AI parses a known subset only).
 */
const POLICY = {
  // Groq's enum is the plain low/medium/high scale: 'none' and 'minimal' are
  // rejected with 400 "must be one of low, medium, or high" (observed on
  // openai/gpt-oss-120b). Clamped rather than dropped so the knob still lands.
  groq: { accepts: ['low', 'medium', 'high'] },
  // Mistral's API is strict (422 on unknown keys) and Magistral's reasoning has
  // no request-side knob at all.
  mistral: { drop: true },
  // Cohere's OpenAI-compat endpoint has no reasoning_effort; its own control is
  // a non-OpenAI `thinking` object.
  cohere: { drop: true },
  // Workers AI's compat endpoint parses a known subset only. Not currently
  // reachable (see the note above).
  cloudflare: { drop: true, unreachable: true },
  // Gemini's generationConfig has no reasoning_effort; the adapter maps it to
  // thinkingConfig.thinkingBudget in tokens instead — see `thinkingBudget`.
  google: { thinkingBudget: true },
  // ACLIDE uses the nested `reasoning: { effort }` wrapper rather than a flat
  // field.
  aclide: { nested: true },
}

/** Default thinking budgets per effort, in tokens (Gemini's unit). */
const THINKING_BUDGET = {
  off: 0,
  minimal: 512,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
}

export class ReasoningTranslator {
  /**
   * @param {{ logger?: any }} [options]
   */
  constructor(options = {}) {
    this.logger = options.logger
  }

  /** The policy for one platform. */
  policyFor(platform) {
    return POLICY[platform] ?? {}
  }

  /**
   * Does this platform accept a reasoning control at all?
   *
   * Used to decide what the picker advertises: offering an effort menu for a
   * model whose endpoint ignores it would be a lie about what the user gets.
   */
  supports(platform) {
    const policy = this.policyFor(platform)
    return policy.drop !== true
  }

  /**
   * The efforts a platform can act on, strongest-last.
   *
   * A partial scale is reported as-is so the picker only offers what works.
   */
  effortsFor(platform) {
    const policy = this.policyFor(platform)
    if (policy.drop === true) return []
    if (Array.isArray(policy.accepts)) {
      const accepted = policy.accepts.filter(effort => EFFORT_SCALE.includes(effort))
      return accepted.sort((a, b) => positionOf(a) - positionOf(b))
    }
    return [...EFFORT_SCALE]
  }

  /**
   * Apply the effort to an outgoing request body, in place.
   *
   * Returns what was actually sent, so the router can log the difference
   * between what the user asked for and what the platform accepted.
   *
   * @param {string} platform
   * @param {Record<string, unknown>} body
   * @param {string | undefined} requested
   * @returns {{ sent: string | null, note: string }}
   */
  apply(platform, body, requested) {
    if (requested === undefined || requested === null || requested === '') {
      return { sent: null, note: 'none requested' }
    }
    const policy = this.policyFor(platform)

    if (policy.drop === true) {
      return { sent: null, note: `${platform} has no request-side reasoning control; dropped` }
    }

    // Normalize before clamping so an alias like 'none' behaves like 'off'.
    const normalized = String(requested) === 'none' ? 'off' : String(requested)
    if (positionOf(normalized) === -1) {
      return { sent: null, note: `unknown effort "${requested}"; not sent` }
    }

    if (policy.thinkingBudget === true) {
      const budget = THINKING_BUDGET[normalized]
      // The adapter for this platform reads `thinkingBudget`; the wire shape is
      // built there so this module stays free of provider-specific JSON.
      body.thinkingBudget = budget
      return { sent: normalized, note: `translated to a ${budget}-token thinking budget` }
    }

    if (policy.boolean === true) {
      const on = normalized !== 'off'
      body.reasoning = on
      return { sent: normalized, note: `mapped to reasoning=${on}` }
    }

    let sent = normalized
    if (Array.isArray(policy.accepts)) {
      const clamped = clampTo(normalized, policy.accepts)
      if (clamped === undefined) {
        return { sent: null, note: `no accepted effort near "${requested}"; not sent` }
      }
      sent = clamped
    }

    if (policy.nested === true) {
      body.reasoning = { effort: sent }
      return {
        sent,
        note: sent === normalized ? 'sent as reasoning.effort' : `clamped ${normalized} -> ${sent}`,
      }
    }

    body.reasoning_effort = sent
    return {
      sent,
      note: sent === normalized ? 'sent as reasoning_effort' : `clamped ${normalized} -> ${sent}`,
    }
  }

  /** Describe the reasoning capability of one model route, for DSH's picker. */
  describeFor(platform) {
    const efforts = this.effortsFor(platform)
    if (efforts.length === 0) return undefined
    return {
      efforts: efforts.map(id => ({ id, ...EFFORT_LABELS[id] })),
      defaultEffort: efforts.includes('medium') ? 'medium' : efforts[efforts.length - 1],
    }
  }
}
