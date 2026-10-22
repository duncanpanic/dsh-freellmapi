/**
 * Decide whether this plugin should mount the account-channel pack.
 *
 * The pack is a shared, MIT-licensed vendor bundle (upstream:
 * `gitee.com/iJetLi/deepseek-harness-codearts`) that backs thirteen signed-in
 * channels — CodeArts, CodeBuddy, WorkBuddy (both editions), LobsterAI, Qoder
 * (both editions), TRAE, Cline, Loomy, Raccoon, MiniMax Code, ZCode and Gemini
 * Code Assist — plus an account pool, a credits collector and a local
 * OpenAI-compatible gateway.
 *
 * Two plugins in one profile cannot both mount it. The collision is not a
 * graceful one that can be caught and abandoned:
 *
 *   1. `apply()` constructs `new CodeArtsAuth(ctx)` before it does anything
 *      else, and the Cordis `Service` base class registers itself **in its
 *      constructor**. A second mount throws
 *      `service "codeartsAuth" has been registered at <other plugin>`
 *      on the first line, before any handler could decide to stand down.
 *   2. Later it registers the exact Fetch route `/api/channel-pack`, and the
 *      host's connection service throws on a duplicate with no way to ask
 *      "is that route already mine?".
 *
 * So the decision has to be made *before* mounting, and the only reliable
 * question is whether the service those collisions centre on already exists.
 * `ctx.get()` answers it: it returns another plugin's registration or
 * `undefined`, and it costs nothing.
 *
 * The product requirement this serves: the plugin must work on its own on a
 * machine that has never seen a channel pack, and must degrade honestly — not
 * crash, not double-register — on a machine that already runs one.
 *
 * @module src/native/channel-host.js
 */

// @ts-check

/**
 * Services the pack provides. Presence of any one means another plugin already
 * mounted a copy, so this plugin must not.
 *
 * `accountPool` is registered last (via `ctx.provide`), `codeartsAuth` first
 * (via the Service constructor). Checking both covers the window where one
 * plugin is mid-mount: whichever it has reached, we see it.
 */
export const PACK_SERVICES = ['codeartsAuth', 'accountPool']

/** Routes the pack claims, reported so a conflict names what it is about. */
export const PACK_ROUTES = [
  '/api/channel-pack',
  '/api/channel-pack/captcha-carrier',
]

/**
 * Work out whether another plugin already owns the channel pack.
 *
 * @param {{ get: (name: string) => unknown }} ctx
 * @returns {{ owned: boolean, by: string | null, service: string | null }}
 */
export function detectPackOwner(ctx) {
  for (const service of PACK_SERVICES) {
    let existing
    try {
      existing = ctx.get(service)
    } catch {
      // A throwing `get` means the name is not a resolvable service in this
      // composition; that is the same answer as "absent" for our purpose.
      existing = undefined
    }
    if (existing !== undefined && existing !== null) {
      return { owned: true, by: service, service }
    }
  }
  return { owned: false, by: null, service: null }
}

/**
 * The decision, with the reason a surface can show.
 *
 * States, because "someone else owns it" and "this host cannot run it" call for
 * different words in front of a user:
 *
 *   `ready`        mount it
 *   `owned`        another plugin mounted it; stand down and point there
 *   `disabled`     the user turned it off in config
 *   `unavailable`  the vendored files are missing from the package
 *   `failed`       the mount threw, and the reason is kept
 *
 * @typedef {'ready' | 'owned' | 'disabled' | 'unavailable' | 'failed'} ChannelHostState
 */

/**
 * Build the state record shared between the mount attempt and the HTTP surface.
 *
 * Returned as a small mutable holder so the panel can ask "what happened?"
 * later, and so a failure that occurs during `apply` is still reportable rather
 * than only logged.
 */
export function createChannelStatus() {
  /** @type {{ state: ChannelHostState, reason: string, owner: string | null, channels: number, mountedAt: number }} */
  const status = {
    state: 'unavailable',
    reason: 'not attempted yet',
    owner: null,
    channels: 0,
    mountedAt: 0,
  }
  return {
    status,
    /** @param {Partial<typeof status>} patch */
    set(patch) {
      Object.assign(status, patch)
      return status
    },
    snapshot() {
      return { ...status }
    },
  }
}
