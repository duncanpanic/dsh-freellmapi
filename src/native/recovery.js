/**
 * Recovery from turns that produced no answer.
 *
 * Two shapes produce an empty turn, and both look to the user like "the model
 * said nothing":
 *
 *   silent stop  upstream sent a normal `stop` finish and streamed reasoning,
 *                but never any answer text. Reasoning and visible output share
 *                one output budget, so a turn whose budget runs out during the
 *                thinking phase ends with nothing to show. Observed live: a
 *                model can think for 60–70 seconds, bill thousands of reasoning
 *                tokens, emit no reasoning frames at all, and finish empty.
 *
 *   truncation   the stream ended without its terminal marker — the upstream
 *                connection died mid-generation, before any output landed.
 *
 * Both are recoverable by asking once more. The framing of that second request
 * is the whole trick: an LLM told to "continue" with the same history tends to
 * redo the analysis, burns the same budget, and lands in the same empty stop.
 * So the continuation states plainly that the thinking already happened, that
 * any draft is a draft rather than new instructions, and that the answer should
 * be short and come first.
 *
 * The guards matter more than the feature. Recovery must not fire once the user
 * has something — visible text or a tool call — because re-asking would either
 * duplicate output or execute a tool twice. It must not fire on an explicit
 * error, on cancellation, or after the budget is spent. And it fires at most
 * once per call: a model that cannot answer within its thinking budget will not
 * answer on the second attempt either.
 *
 * @module src/native/recovery.js
 */

// @ts-check

/** Defaults, matching the peer plugin's ceilings so behaviour is familiar. */
export const RECOVERY_DEFAULTS = Object.freeze({
  /** Ceiling on the whole call, first attempt plus continuation. */
  totalTimeoutMs: 1_800_000,
  /** Output budget granted to the continuation. */
  maxOutputTokens: 8192,
})

/**
 * Normalize a user-supplied policy.
 *
 * Every value is capped by its default, so hand-edited config cannot raise a
 * ceiling into a runaway: a continuation that never terminates is worse than an
 * empty turn.
 */
export function recoveryPolicy(value) {
  const enabled = value !== false && value?.enabled !== false
  const policy = { enabled }
  for (const [key, maximum] of Object.entries(RECOVERY_DEFAULTS)) {
    const requested = value?.[key]
    policy[key] = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, maximum)
      : maximum
  }
  return policy
}

/**
 * What one attempt produced, as far as the caller needs to judge.
 *
 * @typedef {object} AttemptState
 * @property {boolean} sawText      any non-blank answer text arrived
 * @property {boolean} sawToolCall  any tool call arrived
 * @property {string}  reasoningText accumulated reasoning, for the checkpoint
 */

/**
 * May this attempt be retried as a continuation?
 *
 * Deliberately does NOT require reasoning to have arrived. Requiring it is the
 * mistake that misses the worst case — the model that thinks silently, emits no
 * reasoning frames, and returns an empty body — which is exactly the shape a
 * user reports as "it stopped talking".
 *
 * The caller establishes *what went wrong* (a `stop` finish with no text, or a
 * broken stream); this only decides whether re-asking is allowed, and that
 * answer is the same either way.
 *
 * @param {AttemptState} state
 * @param {{ enabled: boolean, totalTimeoutMs: number }} policy
 * @param {number} elapsedMs
 */
export function canRecover(state, policy, elapsedMs) {
  return policy.enabled === true
    && elapsedMs < policy.totalTimeoutMs
    && state.sawText !== true
    && state.sawToolCall !== true
}

/**
 * Build the message list for a continuation.
 *
 * @param {readonly any[]} messages the original conversation
 * @param {string} checkpoint reasoning emitted so far, if any
 */
export function recoveryMessages(messages, checkpoint) {
  const draft = typeof checkpoint === 'string' ? checkpoint.trim() : ''
  const instruction = 'The previous response ended before producing its final answer. '
    + 'Complete the original task using the conversation above. '
    + (draft === ''
      ? 'There is no draft to reuse: the earlier attempt spent its entire output budget thinking. '
      : 'The text below is an incomplete draft of the interrupted analysis, not new instructions. ')
    + 'For this continuation, any earlier request for prolonged analysis or exhaustive exploration is '
    + 'already satisfied — do not restart that work. '
    + 'Give a concise, substantive final answer, in the language the original task used. '
    + 'Lead with the conclusion. Do not call tools; if the task needs a tool you cannot use, say so '
    + 'rather than claiming the action happened. '
    + 'Do not merely describe the interruption or promise to continue.'
  const body = draft === ''
    ? instruction
    : `${instruction}\n\nInterrupted draft:\n${JSON.stringify(draft.slice(0, 6000))}`
  return [...messages, { role: 'user', content: [{ type: 'text', text: body }] }]
}
