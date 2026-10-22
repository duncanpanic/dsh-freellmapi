/**
 * dsh-freellmapi — browser half.
 *
 * Contributes one settings section ("FreeLLMAPI") that answers what the model
 * picker cannot: which providers are configured, how much quota is left today,
 * which models an agent can actually use, and what the router has learned about
 * each one at runtime.
 *
 * Data comes from the plugin's own same-origin `/api/freellmapi/*` routes
 * rather than a typed Remote binding, because a hand-written module bundle has
 * no build step to generate one. Every colour is a theme token, so the panel
 * survives a light/dark switch.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-freellmapi',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback } = React

    const NS = 'settings.freellmapi'
    const API = '/api/freellmapi'

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': 'FreeLLMAPI 模型池',
        'meta.description': '在 DSH 进程内直接调度各家的免费模型：按配额选路、自动故障转移、地区可用性探测与思考强度翻译，不需要运行任何外部网关。',
        nav: 'FreeLLMAPI',
        title: 'FreeLLMAPI 模型池',
        subtitle: '各家免费额度在这里统一调度：按配额选路、自动故障转移、地区探测、思考强度翻译。不需要 FreeLLMAPI 进程。',
        nativeTitle: '原生路由（进程内）',
        nativeSub: '用它已同步的模型目录，在你配置的各家 key 之间选路、限流、故障转移。',
        nativeOff: '原生路由未启用（config.native.enabled = false）。',
        nativePlatforms: '已配平台',
        nativeModels: '可用模型',
        nativeCalls: '今日请求',
        nativeAdd: '添加密钥',
        nativeSelect: '选择平台',
        nativePlaceholder: '粘贴该平台的 API Key',
        nativeSubmit: '保存',
        nativeAdded: '已保存',
        nativeFailed: '保存失败',
        nativeRemove: '移除',
        nativeKeyless: '免密钥',
        nativeNoKeys: '还没有配置任何平台。选一个平台填 key 即可；标注「免密钥」的平台可以直接加。',
        nativeToday: '今日',
        nativeCooling: '冷却中',
        nativeHealthy: '正常',
        nativeUnknownState: '未验证',
        nativeInvalid: '失效',
        toolTitle: '工具调用能力',
        toolSub: '目录里的「支持工具」是按模型名推断的声明，两边都可能出错。这里记录真实观察到的拒绝：连续 3 次后把该模型在工具请求中排到最后 6 小时，一次成功即清零。',
        toolObserved: '观察中',
        toolDeferred: '已延期',
        toolNone: '尚无观察记录——所有模型都在正常参与工具请求。',
        toolRejects: '次拒绝',
        toolUntil: '至',
        toolHint: '带工具请求时，未标记支持的模型只是排在后面，仍会被尝试；不带工具的请求完全不受影响。',
        availTitle: '可用模型',
        availSub: '来自已配置平台的全部模型，按能力排序。「工具」标签表示支持函数调用，agent 需要它。',
        availSearch: '筛选模型…',
        availNone: '还没有配置任何平台，因此没有可用模型。',
        availToolsOnly: '只看支持工具的',
        availCount: '{n} 个模型',
        availMore: '还有 {n} 个',
        tabOverview: '概览',
        tabModels: '模型',
        tabKeys: '密钥',
        tabTools: '工具能力',
        tabChains: '降级链',
        tabHealth: '诊断',
        healthUsable: '可用模型',
        healthOf: '共 {n}',
        healthAllGood: '全部正常，无需处理',
        healthAttention: '{n} 项需要留意',
        healthBarHint: '可用比例',
        legendOk: '正常',
        legendSlow: '响应慢',
        legendBad: '不可用',
        legendUnconfigured: '未配置',
        attnCooling: '冷却',
        attnRetired: '已退役',
        attnRegion: '地区受限',
        attnTools: '工具降权',
        budgetTitle: '今日额度',
        budgetUsed: '已用 {used} / {total}',
        budgetUnlimited: '未公布额度',
        budgetRemaining: '剩余 {n}',
        diagTitle: '诊断',
        diagSub: '这里是可以采取行动的项；修补后会自动从列表消失。',
        diagNone: '没有需要注意的项目。',
        tagTools: '工具',
        tagVision: '视觉',
        statPlatforms: '平台',
        statModels: '模型',
        statCalls: '今日请求',
        statTokens: '今日 tokens',
        navBadgeNone: '',
        regionTitle: '地区可用性',
        regionSub: '上游按出口地区放行。下面这些模型已确认从本机不可达，路由会跳过它们——key 本身仍然有效，换网络后会重新探测。',
        regionNone: '没有被地区限制的模型。',
        regionCount: '{n} 个模型',
        reasonTitle: '思考强度',
        reasonSub: 'DSH 的档位按平台差异翻译：支持的直传，枚举更窄的就近取值，没有控制项的明确告知而非静默丢弃。',
        reasonEfforts: '支持档位',
        reasonNone: '没有平台支持思考强度控制。',
        reasonUnsupported: '不支持',
        retiredTitle: '已退役模型',
        retiredSub: '上游明确表示这些模型已下线。它们被持久排除，不再消耗往返和故障转移名额——但判定可撤销，上游恢复了就点「恢复」。',
        retiredNone: '没有被退役的模型。',
        retiredReason: '原因',
        retiredLift: '恢复',
        retiredLiftAll: '全部恢复',
        recoveryTitle: '空响应恢复',
        recoverySub: '模型把输出额度全花在思考上、正文为空时，自动追问一次要正文。最多一次，已输出正文或工具调用时不触发。',
        recoveryOn: '已启用',
        recoveryOff: '已关闭',
        recoveryBudget: '续写额度',
        probeTitle: '地区探测',
        probeSub: '主动向每个已配置平台发一个最小请求，提前知道哪些从本机不可达——不用等真实请求撞上去。只记录地区判定，不消耗额度、不冷却密钥。',
        probeRun: '开始探测',
        probeRunning: '探测中…',
        probeClear: '清除判定',
        probeResult: '可达 {ok} · 太慢 {slow} · 地区受限 {region} · 失败 {failed}',
        probeSlowHint: '「太慢」指探测超时——匿名队列优先级最低，可能需要 1 分钟以上，不代表平台坏了。',
        forecastTitle: '额度预判',
        forecastSub: '统计各平台今日已用与消耗速度，估算还能撑多久。数据来自本插件的记账——若你在别处用过同一把 key，这里会偏低。',
        forecastNone: '还没有用量记录。',
        forecastRemaining: '剩余',
        forecastBurn: '速度',
        forecastRunway: '可撑',
        forecastLow: '余额偏低',
        forecastUnknown: '未知',
        forecastUnlimited: '无限',
        forecastPerMin: '/分',
        forecastMin: '分钟',
        chainTitle: '降级链',
        chainSub: '把模型串成命名链，以 combo:<名字> 出现在模型选择器里。fallback 总是从第一步开始；round-robin 轮换起点，让流量分摊而不是先把第一个的额度用光。',
        chainNone: '还没有配置降级链。在 cordis.patch.yml 里加 chains 即可。',
        chainSteps: '步骤',
        chainRoutes: '路由',
        chainMissing: '缺失',
        chainStrategyFallback: 'fallback · 固定起点',
        chainStrategyRound: 'round-robin · 轮换',
        chainSticky: '粘滞 {n} 轮',
        chainCursor: '当前起点 #{n}',
        chainRejected: '被拒绝的链',
        chainRejectedHint: '下面这些链配置有问题，已跳过（不影响其他链）。',
        chainProblem: '问题',
        channelTitle: '账号渠道',
        channelSub: '由内嵌的渠道包提供的登录型渠道（CodeBuddy、LobsterAI、TRAE 等 13 家）。需要单独登录各平台获取凭据，与模型池路由无关。',
        channelReady: '已挂载',
        channelOwned: '由其它插件提供',
        channelDisabled: '已在配置中关闭',
        channelUnavailable: '渠道包文件缺失',
        channelFailed: '挂载失败',
        channelNone: '渠道未就绪',
        channelRisk: '⚠ 使用账号渠道存在 IP/账号封禁风险，上游策略随时可能变更，不建议用于关键任务。',
        channelCount: '渠道数',
        channelMountedAt: '挂载时间',
        channelOwner: '提供方',
        channelReason: '原因',
        channelNote: '渠道包内嵌于本插件，与模型池路由独立。由 dsh-xdpool 或 dsh-our-free-model 提供时会自动让位。',
      },
      en: {
        'meta.title': 'FreeLLMAPI model pool',
        'meta.description': 'Drives free-tier models from many providers inside the DSH process: quota-aware routing, automatic failover, region probing and reasoning-effort translation — with no external gateway to run.',
        nav: 'FreeLLMAPI',
        title: 'FreeLLMAPI model pool',
        subtitle: 'Free tiers from every provider you configure, routed in-process: quota-aware selection, automatic failover, region probing, reasoning translation. No FreeLLMAPI process required.',
        nativeTitle: 'Native router (in-process)',
        nativeSub: 'No FreeLLMAPI process: routes, rate-limits and fails over across your own keys, using the catalog it already synced.',
        nativeOff: 'The native router is disabled (config.native.enabled = false).',
        nativePlatforms: 'Platforms',
        nativeModels: 'Usable models',
        nativeCalls: 'Requests today',
        nativeAdd: 'Add key',
        nativeSelect: 'Choose platform',
        nativePlaceholder: 'Paste that platform\'s API key',
        nativeSubmit: 'Save',
        nativeAdded: 'Saved',
        nativeFailed: 'Save failed',
        nativeRemove: 'Remove',
        nativeKeyless: 'keyless',
        nativeNoKeys: 'No platform configured yet. Pick one and paste a key; platforms marked "keyless" can be added directly.',
        nativeToday: 'today',
        nativeCooling: 'cooling',
        nativeHealthy: 'ok',
        nativeUnknownState: 'unverified',
        nativeInvalid: 'invalid',
        toolTitle: 'Tool-calling capability',
        toolSub: 'The catalog\'s "supports tools" flag is inferred from model names and can be wrong either way. This records observed rejections: after 3 in an hour a model is tried last for tool requests for 6 hours, and one success clears it.',
        toolObserved: 'observed',
        toolDeferred: 'deferred',
        toolNone: 'Nothing observed yet — every model is competing normally for tool requests.',
        toolRejects: 'rejections',
        toolUntil: 'until',
        toolHint: 'For a tool-carrying request an unflagged model is only moved later, never skipped; requests without tools are unaffected.',
        availTitle: 'Available models',
        availSub: 'Every model behind a configured platform, ordered by capability. The "tools" tag means function calling works — an agent needs it.',
        availSearch: 'Filter models…',
        availNone: 'No platform is configured yet, so there are no usable models.',
        availToolsOnly: 'Tools only',
        availCount: '{n} models',
        availMore: '{n} more',
        tabOverview: 'Overview',
        tabModels: 'Models',
        tabKeys: 'Keys',
        tabTools: 'Tool support',
        tabChains: 'Chains',
        tabHealth: 'Diagnostics',
        healthUsable: 'usable models',
        healthOf: 'of {n}',
        healthAllGood: 'Everything is healthy',
        healthAttention: '{n} need attention',
        healthBarHint: 'share usable',
        legendOk: 'ok',
        legendSlow: 'slow',
        legendBad: 'broken',
        legendUnconfigured: 'not wired',
        attnCooling: 'cooling',
        attnRetired: 'retired',
        attnRegion: 'region',
        attnTools: 'demoted',
        budgetTitle: 'Today\'s budget',
        budgetUsed: '{used} of {total} used',
        budgetUnlimited: 'no published limit',
        budgetRemaining: '{n} left',
        diagTitle: 'Diagnostics',
        diagSub: 'Only things you can act on. Each disappears once it is fixed.',
        diagNone: 'Nothing needs attention.',
        tagTools: 'tools',
        tagVision: 'vision',
        statPlatforms: 'Platforms',
        statModels: 'Models',
        statCalls: 'Requests today',
        statTokens: 'Tokens today',
        navBadgeNone: '',
        regionTitle: 'Regional availability',
        regionSub: 'Upstream providers gate by egress region. These models were confirmed unreachable from this machine and the router skips them — the key itself is fine, and a different network re-probes.',
        regionNone: 'No model is region-restricted.',
        regionCount: '{n} models',
        reasonTitle: 'Reasoning effort',
        reasonSub: 'DSH\'s effort level is translated per platform: forwarded where documented, clamped to the nearest accepted value where the enum is narrower, and reported rather than silently dropped where there is no control.',
        reasonEfforts: 'Accepted efforts',
        reasonNone: 'No configured platform supports reasoning-effort control.',
        reasonUnsupported: 'not supported',
        retiredTitle: 'Retired models',
        retiredSub: 'Upstream reports these models permanently gone. They are excluded from routing so they stop costing round trips and fallback slots — but the verdict is reversible, so restore one if upstream brings it back.',
        retiredNone: 'No model is retired.',
        retiredReason: 'reason',
        retiredLift: 'Restore',
        retiredLiftAll: 'Restore all',
        recoveryTitle: 'Empty-answer recovery',
        recoverySub: 'When a model spends its whole output budget thinking and returns no text, the router asks once more for the answer. At most one retry, and never once text or a tool call has landed.',
        recoveryOn: 'enabled',
        recoveryOff: 'disabled',
        recoveryBudget: 'continuation budget',
        probeTitle: 'Region probe',
        probeSub: 'Asks every configured platform directly with one minimal request, so an unreachable provider is known before a real request pays for the discovery. Records only the region verdict — no quota spent, no key cooled.',
        probeRun: 'Probe now',
        probeRunning: 'Probing…',
        probeClear: 'Clear verdicts',
        probeResult: '{ok} reachable · {slow} slow · {region} region-blocked · {failed} failed',
        probeSlowHint: '"Slow" means the probe timed out — the anonymous tier queues last and can take over a minute. It does not mean the provider is broken.',
        forecastTitle: 'Quota forecast',
        forecastSub: 'Today\'s usage and spend rate per platform, and how long that lasts. Figures come from this plugin\'s own accounting — using the same key elsewhere makes them understate.',
        forecastNone: 'No usage recorded yet.',
        forecastRemaining: 'left',
        forecastBurn: 'rate',
        forecastRunway: 'runway',
        forecastLow: 'low balance',
        forecastUnknown: 'unknown',
        forecastUnlimited: 'unlimited',
        forecastPerMin: '/min',
        forecastMin: 'min',
        chainTitle: 'Fallback chains',
        chainSub: 'Chain models under a name, selectable as combo:<name>. `fallback` always starts at step 1; `round-robin` rotates the start so traffic spreads instead of draining the first member\'s free tier before touching the rest.',
        chainNone: 'No chains configured. Add a `chains` list to cordis.patch.yml.',
        chainSteps: 'steps',
        chainRoutes: 'routes',
        chainMissing: 'missing',
        chainStrategyFallback: 'fallback · fixed start',
        chainStrategyRound: 'round-robin · rotating',
        chainSticky: 'sticky {n} calls',
        chainCursor: 'starts at step #{n}',
        chainRejected: 'Rejected chains',
        chainRejectedHint: 'These chain definitions are malformed and were skipped. The others still work.',
        chainProblem: 'problem',
        channelTitle: 'Account channels',
        channelSub: 'Signed-in channels provided by the embedded channel pack (CodeBuddy, LobsterAI, TRAE and 12 more). Each requires its own login and is independent of the model-pool router.',
        channelReady: 'mounted',
        channelOwned: 'served by another plugin',
        channelDisabled: 'disabled in config',
        channelUnavailable: 'channel pack files missing',
        channelFailed: 'mount failed',
        channelNone: 'channels not ready',
        channelRisk: '⚠ Account channels carry a real risk of IP / account bans — upstream policy can change at any time. Do not rely on them for critical work.',
        channelCount: 'channels',
        channelMountedAt: 'mounted at',
        channelOwner: 'served by',
        channelReason: 'reason',
        channelNote: 'The pack is embedded in this plugin and is independent of the model-pool router. It stands down automatically when another plugin (dsh-xdpool, dsh-our-free-model) already provides it.',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    const CSS = `
.dsh-flm { display: flex; flex-direction: column; gap: 16px; }
.dsh-flm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dsh-flm-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-flm-sub { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsh-flm-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 14px 16px; }
.dsh-flm-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.dsh-flm-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-flm-btn[disabled] { opacity: 0.55; cursor: default; }
.dsh-flm-note { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsh-flm-note.warn { border-color: var(--dsw-alias-state-warn-primary); }
.dsh-flm-note.err { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-flm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dsh-flm-more { margin-top: 6px; }
.dsh-flm-select, .dsh-flm-input { height: 28px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; padding: 0 8px; }
.dsh-flm-input { flex: 1 1 160px; min-width: 120px; }
.dsh-flm-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.dsh-flm-keyrow { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); margin-top: 5px; font-size: 11px; }
.dsh-flm-keyname { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary); }
.dsh-flm-keymeta { color: var(--dsw-alias-label-secondary); margin-left: auto; }
.dsh-flm-pill { padding: 1px 7px; border-radius: 999px; font-size: 10px; background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-primary); }
.dsh-flm-pill.ok { background: var(--dsw-alias-state-success-primary); color: #04140a; }
.dsh-flm-pill.cool { background: var(--dsw-alias-state-warn-primary); color: #1a1200; }
.dsh-flm-pill.bad { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsh-flm-link { background: none; border: none; color: var(--dsw-alias-state-error-primary); font-size: 11px; cursor: pointer; padding: 0 2px; }
.dsh-flm-subhead { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-flm-subnote { margin-top: 6px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }

/* tabs */
.dsh-flm-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-flm-tab { appearance: none; border: none; background: none; padding: 7px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; border-radius: 6px 6px 0 0; }
.dsh-flm-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-flm-tab.on { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dsh-flm-panel { padding-top: 14px; }

/* stat strip */
.dsh-flm-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.dsh-flm-stat { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 9px 11px; }
.dsh-flm-stat-label { font-size: 10px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dsh-flm-stat-value { margin-top: 3px; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; line-height: 1.2; }

/* model rows */
.dsh-flm-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.dsh-flm-chip { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; height: 24px; padding: 0 10px; border-radius: 999px; cursor: pointer; }
.dsh-flm-chip.on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-on-accent, #fff); }
.dsh-flm-count { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-left: auto; font-variant-numeric: tabular-nums; }
.dsh-flm-list { display: flex; flex-direction: column; gap: 3px; max-height: 380px; overflow: auto; }
.dsh-flm-mrow { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.dsh-flm-mrow:hover { background: var(--dsh-flm-hover, var(--dsw-alias-bg-layer-1)); outline: 1px solid var(--dsw-alias-border-l1); }
.dsh-flm-mid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-flm-mmeta { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.dsh-flm-tag { font-size: 9px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-flm-tag.tools { background: var(--dsw-alias-state-success-primary); color: #04140a; }
.dsh-flm-tag.vision { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-on-accent, #fff); }
.dsh-flm-ctx { font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-flm-plat { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dsh-flm-empty { padding: 22px 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }

/* ── overview: health bar and quota meters ──────────────────────────────── */
.dsh-flm-health { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dsh-flm-health-main { display: flex; align-items: baseline; gap: 8px; }
.dsh-flm-health-num { font-size: 26px; font-weight: 700; line-height: 1; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-flm-health-unit { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-flm-health-note { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: right; line-height: 1.5; }

/* a stacked availability bar: the whole pool as one ribbon */
.dsh-flm-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-state-idle-primary); margin-top: 10px; }
.dsh-flm-bar-seg { height: 100%; }
.dsh-flm-bar-seg.ok { background: var(--dsw-alias-state-success-primary); }
.dsh-flm-bar-seg.slow { background: var(--dsw-alias-state-warn-primary); }
.dsh-flm-bar-seg.bad { background: var(--dsw-alias-state-error-primary); }
.dsh-flm-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-flm-legend-item { display: flex; align-items: center; gap: 5px; }
.dsh-flm-swatch { width: 8px; height: 8px; border-radius: 2px; }
.dsh-flm-swatch.ok { background: var(--dsw-alias-state-success-primary); }
.dsh-flm-swatch.slow { background: var(--dsw-alias-state-warn-primary); }
.dsh-flm-swatch.bad { background: var(--dsw-alias-state-error-primary); }
.dsh-flm-swatch.idle { background: var(--dsw-alias-state-idle-primary); }

/* per-platform meters */
.dsh-flm-meter { display: flex; flex-direction: column; gap: 5px; padding: 9px 11px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); margin-top: 6px; }
.dsh-flm-meter-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-flm-meter-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-primary); }
.dsh-flm-meter-val { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-flm-track { height: 5px; border-radius: 999px; background: var(--dsw-alias-state-idle-primary); overflow: hidden; }
.dsh-flm-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-success-primary); }
.dsh-flm-fill.warn { background: var(--dsw-alias-state-warn-primary); }
.dsh-flm-fill.bad { background: var(--dsw-alias-state-error-primary); }
.dsh-flm-fill.unknown { background: var(--dsw-alias-label-secondary); opacity: 0.35; }

/* compact attention list: only what needs acting on */
.dsh-flm-attn { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); margin-top: 5px; font-size: 11px; }
.dsh-flm-attn-kind { font-size: 10px; padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
.dsh-flm-attn-kind.warn { background: var(--dsw-alias-state-warn-primary); color: #1a1200; }
.dsh-flm-attn-kind.bad { background: var(--dsw-alias-state-error-primary); color: #fff; }
.dsh-flm-attn-kind.info { background: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-label-primary); }
.dsh-flm-attn-what { color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-flm-attn-why { margin-left: auto; color: var(--dsw-alias-label-secondary); text-align: right; }
`

    // ── data ──────────────────────────────────────────────────────────────────
    async function callApi(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    // ── settings section ───────────────────────────────────────────────────────
    /**
     * The settings section body.
     *
     * All of the substance lives in `NativePanel`; this wrapper only provides
     * the page-level heading and the vertical rhythm, so the section has an
     * identity even before the router has reported anything.
     */
    function StatusPanel({ ctx }) {
      const t = ctx.locale.bind(NS)
      return h('div', { className: 'dsh-flm' },
        h('div', { className: 'dsh-flm-head' },
          h('div', null,
            h('div', { className: 'dsh-flm-title' }, t('title')),
            h('div', { className: 'dsh-flm-sub' }, t('subtitle')),
          ),
        ),
        h(NativePanel, { ctx }),
      )
    }

    // ── native router panel ───────────────────────────────────────────────────
    /**
     * The key pool behind the in-process route: what is configured, what each
     * platform has burnt today, and the one form that adds a credential.
     *
     * Removal is deliberate rather than confirm-dialogued: a key is cheap to
     * re-paste, and a modal for a reversible local action is friction. The row
     * shows the platform and state, never the secret.
     */
    function NativePanel({ ctx }) {
      const t = ctx.locale.bind(NS)
      const [data, setData] = useState(null)
      const [platform, setPlatform] = useState('')
      const [secret, setSecret] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [tab, setTab] = useState('overview')
      const [query, setQuery] = useState('')
      const [toolsOnly, setToolsOnly] = useState(false)
      const [showAll, setShowAll] = useState(false)
      const [probeResult, setProbeResult] = useState(null)
      const [probing, setProbing] = useState(false)
      const [channelData, setChannelData] = useState(null)

      const load = useCallback(async () => {
        try {
          setData(await callApi('/native/status'))
        } catch (failure) {
          setData({ enabled: false, error: failure?.message ?? String(failure) })
        }
      }, [])

      const loadChannels = useCallback(async () => {
        try {
          setChannelData(await callApi('/channels'))
        } catch (failure) {
          setChannelData({ state: 'failed', reason: failure?.message ?? String(failure) })
        }
      }, [])

      useEffect(() => { void load() }, [load])
      useEffect(() => { void loadChannels() }, [loadChannels])

      if (data === null) return null
      if (data.enabled === false) {
        return h('div', { className: 'dsh-flm-card' },
          h('div', { className: 'dsh-flm-title' }, t('nativeTitle')),
          h('div', { className: 'dsh-flm-sub' }, t('nativeOff')),
        )
      }

      const groups = Array.isArray(data.keys) ? data.keys : []
      const platforms = Array.isArray(data.availablePlatforms) ? data.availablePlatforms : []
      const models = Array.isArray(data.models) ? data.models : []
      const usage = data.usage ?? {}
      const totalCalls = Object.values(usage).reduce((sum, row) => sum + (row?.requests ?? 0), 0)
      const totalTokens = Object.values(usage).reduce((sum, row) => sum + (row?.tokens ?? 0), 0)
      const toolCount = models.filter(model => model.tools).length

      const TABS = [
        ['overview', t('tabOverview')],
        ['models', t('tabModels')],
        ['keys', t('tabKeys')],
        ['chains', t('tabChains')],
        ['tools', t('tabTools')],
        ['health', t('tabHealth')],
        ['channels', t('channelTitle')],
      ]

      const submit = async () => {
        const chosen = platform || (platforms[0]?.id ?? '')
        if (busy || chosen === '' || secret.trim() === '') return
        setBusy(true)
        setNote('')
        try {
          await callApi('/native/keys', {
            method: 'POST',
            body: JSON.stringify({ platform: chosen, secret: secret.trim() }),
          })
          setSecret('')
          setNote(t('nativeAdded'))
          await load()
        } catch (failure) {
          setNote(`${t('nativeFailed')}: ${failure?.message ?? failure}`)
        } finally {
          setBusy(false)
        }
      }

      const remove = async (name, id) => {
        setBusy(true)
        setNote('')
        try {
          await callApi(
            `/native/keys?platform=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`,
            { method: 'DELETE' },
          )
          await load()
        } catch (failure) {
          setNote(`${t('nativeFailed')}: ${failure?.message ?? failure}`)
        } finally {
          setBusy(false)
        }
      }

      /**
       * Undo a retirement. Passing null for both restores everything.
       *
       * Calls `lift` rather than writing state directly: the registry owns the
       * persistence, and the panel only reflects what it holds.
       */
      const lift = async (name, model) => {
        setBusy(true)
        setNote('')
        try {
          await callApi('/native/retired/lift', {
            method: 'POST',
            body: JSON.stringify(name === null ? { all: true } : { platform: name, model }),
          })
          await load()
        } catch (failure) {
          setNote(`${t('nativeFailed')}: ${failure?.message ?? failure}`)
        } finally {
          setBusy(false)
        }
      }

      /**
       * A proactive region sweep. Slow enough to warrant its own spinner, and it
       * finishes by reloading the panel so the blocked list reflects the sweep
       * without the user having to refresh.
       */
      const runProbe = async () => {
        setProbing(true)
        setNote('')
        try {
          const result = await callApi('/native/probe-region', { method: 'POST' })
          setProbeResult({
            reachable: result.reachable ?? 0,
            slow: result.slow ?? 0,
            regionCount: Array.isArray(result.regionBlocked) ? result.regionBlocked.length : 0,
            failed: result.failed ?? 0,
          })
          await load()
        } catch (failure) {
          setNote(`${t('nativeFailed')}: ${failure?.message ?? failure}`)
        } finally {
          setProbing(false)
        }
      }

      /** Drop every region verdict, so a network change can be re-learned. */
      const clearProbe = async () => {
        setProbing(true)
        setNote('')
        try {
          await callApi('/native/probe-region/clear', { method: 'POST' })
          setProbeResult(null)
          await load()
        } catch (failure) {
          setNote(`${t('nativeFailed')}: ${failure?.message ?? failure}`)
        } finally {
          setProbing(false)
        }
      }

      // ── derived views ───────────────────────────────────────────────────────
      const filtered = (() => {
        const needle = query.trim().toLowerCase()
        let rows = models
        if (toolsOnly) rows = rows.filter(model => model.tools)
        if (needle !== '') {
          rows = rows.filter(model =>
            model.id.toLowerCase().includes(needle)
            || (model.name ?? '').toLowerCase().includes(needle)
            || model.platforms.some(p => p.includes(needle)))
        }
        return rows
      })()
      const VISIBLE_LIMIT = 60
      const visible = showAll ? filtered : filtered.slice(0, VISIBLE_LIMIT)

      const keyRow = (group, entry) => {
        const cooled = Number(entry.cooldownUntil ?? 0) > Date.now()
        const state = entry.status === 'invalid' ? 'bad' : cooled ? 'cool' : entry.status === 'healthy' ? 'ok' : ''
        const label = entry.status === 'invalid'
          ? t('nativeInvalid')
          : cooled
            ? t('nativeCooling')
            : entry.status === 'healthy' ? t('nativeHealthy') : t('nativeUnknownState')
        const stat = usage[group.platform]
        return h('div', { className: 'dsh-flm-keyrow', key: entry.id },
          h('span', { className: 'dsh-flm-keyname' }, group.platform),
          h('span', { className: `dsh-flm-pill ${state}` }, label),
          h('span', { className: 'dsh-flm-keymeta' },
            stat ? `${t('nativeToday')} ${stat.requests} req · ${stat.tokens} tok` : ''),
          h('button', {
            type: 'button',
            className: 'dsh-flm-link',
            disabled: busy,
            onClick: () => void remove(group.platform, entry.id),
          }, t('nativeRemove')),
        )
      }

      const addForm = h('div', { className: 'dsh-flm-row' },
        h('select', {
          className: 'dsh-flm-select',
          value: platform || (platforms[0]?.id ?? ''),
          onChange: event => setPlatform(event.target.value),
        }, platforms.map(row => h('option', { key: row.id, value: row.id }, `${row.id} (${row.models})`))),
        h('input', {
          className: 'dsh-flm-input',
          type: 'password',
          spellCheck: false,
          autoComplete: 'off',
          placeholder: t('nativePlaceholder'),
          value: secret,
          onChange: event => setSecret(event.target.value),
          onKeyDown: event => { if (event.key === 'Enter') void submit() },
        }),
        h('button', {
          type: 'button',
          className: 'dsh-flm-btn',
          disabled: busy,
          onClick: () => void submit(),
        }, t('nativeSubmit')),
      )

      const stats = h('div', { className: 'dsh-flm-stats' },
        h('div', { className: 'dsh-flm-stat' },
          h('div', { className: 'dsh-flm-stat-label' }, t('statPlatforms')),
          h('div', { className: 'dsh-flm-stat-value' }, String(data.configuredPlatforms ?? 0)),
        ),
        h('div', { className: 'dsh-flm-stat' },
          h('div', { className: 'dsh-flm-stat-label' }, t('statModels')),
          h('div', { className: 'dsh-flm-stat-value' }, String(models.length)),
        ),
        h('div', { className: 'dsh-flm-stat' },
          h('div', { className: 'dsh-flm-stat-label' }, t('statCalls')),
          h('div', { className: 'dsh-flm-stat-value' }, String(totalCalls)),
        ),
        h('div', { className: 'dsh-flm-stat' },
          h('div', { className: 'dsh-flm-stat-label' }, t('statTokens')),
          h('div', { className: 'dsh-flm-stat-value' }, totalTokens >= 1000
            ? `${Math.round(totalTokens / 1000)}k`
            : String(totalTokens)),
        ),
      )

      const modelsTab = models.length === 0
        ? h('div', { className: 'dsh-flm-empty' }, t('availNone'))
        : h(Fragment, null,
            h('div', { className: 'dsh-flm-toolbar' },
              h('input', {
                className: 'dsh-flm-input',
                style: { flex: '1 1 200px' },
                type: 'search',
                placeholder: t('availSearch'),
                value: query,
                onChange: event => setQuery(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: `dsh-flm-chip${toolsOnly ? ' on' : ''}`,
                onClick: () => setToolsOnly(value => !value),
              }, t('availToolsOnly')),
              h('span', { className: 'dsh-flm-count' }, `${filtered.length} / ${models.length}`),
            ),
            filtered.length === 0
              ? h('div', { className: 'dsh-flm-empty' }, t('availNone'))
              : h('div', { className: 'dsh-flm-list' },
                  visible.map(model => h('div', { className: 'dsh-flm-mrow', key: model.id },
                    h('span', { className: 'dsh-flm-mid', title: model.id }, model.id),
                    h('span', { className: 'dsh-flm-mmeta' },
                      model.contextWindow
                        ? h('span', { className: 'dsh-flm-ctx' }, `${Math.round(model.contextWindow / 1024)}k`)
                        : null,
                      model.platforms.length > 1
                        ? h('span', { className: 'dsh-flm-plat' }, `${model.platforms.length}×`)
                        : h('span', { className: 'dsh-flm-plat' }, model.platforms[0]),
                      model.vision ? h('span', { className: 'dsh-flm-tag vision' }, t('tagVision')) : null,
                      model.tools ? h('span', { className: 'dsh-flm-tag tools' }, t('tagTools')) : null,
                    ),
                  )),
                ),
            !showAll && filtered.length > VISIBLE_LIMIT
              ? h('div', { className: 'dsh-flm-more' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-flm-btn',
                    onClick: () => setShowAll(true),
                  }, t('availMore').replace('{n}', String(filtered.length - VISIBLE_LIMIT))),
                )
              : null,
          )

      const keysTab = h(Fragment, null,
        groups.length === 0
          ? h('div', { className: 'dsh-flm-empty' }, t('nativeNoKeys'))
          : groups.map(group => h(Fragment, { key: group.platform }, (group.entries ?? []).map(entry => keyRow(group, entry)))),
        addForm,
      )

      // ── overview: health first, details behind tabs ────────────────────────
      //
      // The overview used to hold every feature block, which made it a nine-
      // section wall where the one question a person opens this page with —
      // "is it working?" — was buried under configuration detail. It now answers
      // that question only: one availability bar, one budget meter per platform,
      // and a short list of things that need action. Everything else moved to a
      // tab of its own.
      const retired = Array.isArray(data.retired) ? data.retired : []
      const regionBlocked = Array.isArray(data.regionBlocked) ? data.regionBlocked : []
      const toolCap = data.toolCapability ?? {}
      const deferredTools = Array.isArray(toolCap.deferred) ? toolCap.deferred : []
      const forecastPlatforms = data.forecast?.platforms ?? {}

      const cooled = groups.reduce((sum, group) => {
        const stat = usage[group.platform]
        return sum + (stat?.cooled ?? 0)
      }, 0)
      const usableCount = models.length === 0 ? 0 : Math.max(0,
        models.length
        - models.filter(model => model.platforms.every(platform => regionBlocked.some(r => r.platform === platform && r.model === model.id))).length
        - retired.length)

      const segments = [
        { kind: 'ok', count: Math.max(0, models.length - cooled - retired.length - regionBlocked.length) },
        { kind: 'slow', count: cooled },
        { kind: 'bad', count: retired.length + regionBlocked.length },
      ].filter(seg => seg.count > 0)
      const segTotal = segments.reduce((sum, seg) => sum + seg.count, 0) || 1

      const healthBar = models.length === 0 ? null : h(Fragment, null,
        h('div', { className: 'dsh-flm-bar', role: 'img', title: t('healthBarHint') },
          segments.map(seg => h('div', {
            key: seg.kind,
            className: `dsh-flm-bar-seg ${seg.kind}`,
            style: { width: `${(seg.count / segTotal) * 100}%` },
          })),
        ),
        h('div', { className: 'dsh-flm-legend' },
          h('span', { className: 'dsh-flm-legend-item' },
            h('span', { className: 'dsh-flm-swatch ok' }), `${t('legendOk')} ${segments.find(s => s.kind === 'ok')?.count ?? 0}`),
          cooled > 0
            ? h('span', { className: 'dsh-flm-legend-item' },
                h('span', { className: 'dsh-flm-swatch slow' }), `${t('legendSlow')} ${cooled}`)
            : null,
          retired.length + regionBlocked.length > 0
            ? h('span', { className: 'dsh-flm-legend-item' },
                h('span', { className: 'dsh-flm-swatch bad' }), `${t('legendBad')} ${retired.length + regionBlocked.length}`)
            : null,
        ),
      )

      // One meter per configured platform: how much of today's budget is gone.
      // A platform that never published a limit gets a dashed track instead of a
      // number, because "unknown" and "plenty" must not look the same.
      const budgetMeters = groups.map((group) => {
        const fp = forecastPlatforms[group.platform]
        const total = Number.isFinite(fp?.dailyRequestBudget) ? fp.dailyRequestBudget : null
        const remaining = Number.isFinite(fp?.remainingRequests) ? fp.remainingRequests : null
        const used = Number.isFinite(fp?.requestsToday) ? fp.requestsToday : 0
        const low = fp?.lowBalance === true
        const ratio = total !== null && total > 0 ? Math.min(1, used / total) : null
        const fillClass = ratio === null ? 'unknown' : low ? 'bad' : ratio > 0.8 ? 'warn' : ''
        return h('div', { className: 'dsh-flm-meter', key: group.platform },
          h('div', { className: 'dsh-flm-meter-head' },
            h('span', { className: 'dsh-flm-keyname' }, group.platform),
            low ? h('span', { className: 'dsh-flm-pill cool' }, t('forecastLow')) : null,
            h('span', { className: 'dsh-flm-meter-val' },
              total === null
                ? t('budgetUnlimited')
                : t('budgetUsed').replace('{used}', String(used)).replace('{total}', String(total))),
          ),
          h('div', { className: 'dsh-flm-track' },
            h('div', { className: `dsh-flm-fill ${fillClass}`, style: { width: `${(ratio ?? 0.12) * 100}%` } }),
          ),
        )
      })

      // Only actionable items. A healthy install shows one calm line, which is
      // the point: the list is empty when there is nothing to do.
      const attention = []
      if (cooled > 0) attention.push({ kind: 'warn', what: t('attnCooling'), why: `${cooled} key(s)` })
      if (retired.length > 0) attention.push({ kind: 'bad', what: t('attnRetired'), why: retired.map(r => r.model).slice(0, 2).join(', ') })
      if (regionBlocked.length > 0) attention.push({ kind: 'warn', what: t('attnRegion'), why: `${regionBlocked.length} route(s)` })
      if (deferredTools.length > 0) attention.push({ kind: 'info', what: t('attnTools'), why: deferredTools.map(r => r.key).slice(0, 2).join(', ') })

      const overviewTab = h(Fragment, null,
        groups.length === 0
          ? h('div', { className: 'dsh-flm-empty' }, t('nativeNoKeys'))
          : h(Fragment, null,
              h('div', { className: 'dsh-flm-health' },
                h('div', { className: 'dsh-flm-health-main' },
                  h('span', { className: 'dsh-flm-health-num' }, String(usableCount)),
                  h('span', { className: 'dsh-flm-health-unit' }, `${t('healthUsable')} · ${t('healthOf').replace('{n}', String(models.length))}`),
                ),
                h('div', { className: 'dsh-flm-health-note' },
                  attention.length === 0
                    ? t('healthAllGood')
                    : t('healthAttention').replace('{n}', String(attention.length))),
              ),
              healthBar,
              attention.length === 0
                ? null
                : h('div', { style: { marginTop: '12px' } },
                    attention.map((row, index) => h('div', { className: 'dsh-flm-attn', key: `a-${index}` },
                      h('span', { className: `dsh-flm-attn-kind ${row.kind}` }, row.what),
                      h('span', { className: 'dsh-flm-attn-why' }, row.why),
                    )),
                  ),
              h('div', { className: 'dsh-flm-subhead' }, t('budgetTitle')),
              budgetMeters,
            ),
      )

      return h('div', { className: 'dsh-flm-card' },
        h('div', { className: 'dsh-flm-title' }, t('nativeTitle')),
        h('div', { className: 'dsh-flm-sub' }, t('nativeSub')),

        // The stat strip duplicates the health card's headline number, so it is
        // shown only on the other tabs — there it is the one piece of context
        // that persists as the reader goes looking for a specific detail.
        tab === 'overview' ? null : h('div', { style: { marginTop: '14px' } }, stats),

        h('div', { className: 'dsh-flm-tabs', style: { marginTop: '16px' } },
          TABS.map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            className: `dsh-flm-tab${tab === id ? ' on' : ''}`,
            onClick: () => setTab(id),
          }, label)),
        ),

        h('div', { className: 'dsh-flm-panel' },
          tab === 'overview' ? overviewTab : null,
          tab === 'models' ? modelsTab : null,
          tab === 'keys' ? keysTab : null,
          tab === 'chains' ? h(ChainBlock, { t, data }) : null,
          tab === 'tools' ? h(ToolCapability, { t, data }) : null,
          // Diagnostics gathers everything that reports rather than acts: region
          // verdicts, the probe control, the retirement list, the recovery switch
          // and the per-platform reasoning policy. They belong together because
          // they share a reader — someone working out *why* a provider behaves as
          // it does — and keeping them off the overview is what makes that page
          // readable at a glance.
          tab === 'health' ? h(Fragment, null,
            h('div', { className: 'dsh-flm-subhead' }, t('diagTitle')),
            h('div', { className: 'dsh-flm-subnote' }, t('diagSub')),
            h(ForecastBlock, { t, data }),
            h(RegionBlock, { t, data }),
            h(RegionProbeBlock, { t, onProbe: runProbe, onClear: clearProbe, result: probeResult, running: probing }),
            h(RetiredBlock, { t, data, onLift: lift }),
            h(RecoveryBlock, { t, data }),
            h(ReasoningPolicy, { t, data }),
          ) : null,
          tab === 'channels' ? h(ChannelsBlock, { t, data: channelData }) : null,
        ),

        note === ''
          ? null
          : h('div', {
              className: 'dsh-flm-mono',
              style: { marginTop: '8px', color: 'var(--dsw-alias-label-secondary)' },
            }, note),
      )
    }

    // ── region availability ───────────────────────────────────────────────────
    /**
     * Models this network cannot reach.
     *
     * Rendered separately from the key list on purpose: a region block is not a
     * credential problem, the key keeps working for every other model, and
     * showing it as a key failure would send the user hunting for a key that is
     * perfectly fine.
     */
    function RegionBlock({ t, data }) {
      const blocked = Array.isArray(data?.regionBlocked) ? data.regionBlocked : []
      if (blocked.length === 0) {
        return h(Fragment, null,
          h('div', { className: 'dsh-flm-subhead' }, t('regionTitle')),
          h('div', { className: 'dsh-flm-note', style: { marginTop: '10px' } }, t('regionNone')),
        )
      }
      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('regionTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('regionSub')),
        h('div', { style: { marginTop: '10px' } },
          blocked.map((row, index) => h('div', { className: 'dsh-flm-keyrow', key: `${row.platform}|${row.model}|${index}` },
            h('span', { className: 'dsh-flm-pill cool' }, t('regionTitle')),
            h('span', { className: 'dsh-flm-keyname' }, row.model),
            h('span', { className: 'dsh-flm-keymeta' }, row.platform),
          )),
        ),
      )
    }

    // ── retired models ────────────────────────────────────────────────────────
    /**
     * Models upstream says are permanently gone.
     *
     * Shown with a restore action rather than as a dead list: the verdict is a
     * heuristic over failure wording, and the user is the final authority on
     * whether a model is really gone.
     */
    function RetiredBlock({ t, data, onLift }) {
      const rows = Array.isArray(data?.retired) ? data.retired : []
      if (rows.length === 0) {
        return h(Fragment, null,
          h('div', { className: 'dsh-flm-subhead' }, t('retiredTitle')),
          h('div', { className: 'dsh-flm-note', style: { marginTop: '10px' } }, t('retiredNone')),
        )
      }
      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('retiredTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('retiredSub')),
        h('div', { style: { marginTop: '10px' } },
          rows.map(row => h('div', { className: 'dsh-flm-keyrow', key: `${row.platform}|${row.model}` },
            h('span', { className: 'dsh-flm-pill bad' }, t('retiredTitle')),
            h('span', { className: 'dsh-flm-keyname' }, row.model),
            h('span', { className: 'dsh-flm-keymeta', title: row.reason }, row.platform),
            h('button', {
              type: 'button',
              className: 'dsh-flm-link',
              onClick: () => onLift?.(row.platform, row.model),
            }, t('retiredLift')),
          )),
        ),
        rows.length > 1
          ? h('div', { className: 'dsh-flm-more' },
              h('button', {
                type: 'button',
                className: 'dsh-flm-btn',
                onClick: () => onLift?.(null, null),
              }, t('retiredLiftAll')),
            )
          : null,
      )
    }

    // ── recovery policy ───────────────────────────────────────────────────────
    /**
     * Whether empty-answer recovery is on, and the budget it may spend.
     *
     * Read-only: the numbers come from the config row, and showing them is the
     * point — a user who sees an extra request in the log should be able to find
     * out why.
     */
    function RecoveryBlock({ t, data }) {
      const policy = data?.recovery
      if (!policy || typeof policy !== 'object') return null
      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('recoveryTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('recoverySub')),
        h('div', { className: 'dsh-flm-keyrow', style: { marginTop: '10px' } },
          h('span', { className: `dsh-flm-pill ${policy.enabled ? 'ok' : ''}` },
            policy.enabled ? t('recoveryOn') : t('recoveryOff')),
          h('span', { className: 'dsh-flm-plat' }, t('recoveryBudget')),
          h('span', { className: 'dsh-flm-keymeta' }, `${policy.maxOutputTokens ?? 0} tok`),
        ),
      )
    }

    // ── region probe ──────────────────────────────────────────────────────────
    /**
     * The control for a proactive region sweep.
     *
     * Owns its own request state rather than sharing the panel's `busy` flag: a
     * sweep takes seconds, and locking the whole page during it would make the
     * key list unusable for no reason.
     */
    function RegionProbeBlock({ t, onProbe, onClear, result, running }) {
      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('probeTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('probeSub')),
        h('div', { className: 'dsh-flm-row' },
          h('button', {
            type: 'button',
            className: 'dsh-flm-btn',
            disabled: running,
            onClick: () => onProbe?.(),
          }, running ? t('probeRunning') : t('probeRun')),
          h('button', {
            type: 'button',
            className: 'dsh-flm-btn',
            disabled: running,
            onClick: () => onClear?.(),
          }, t('probeClear')),
        ),
        result
          ? h(Fragment, null,
              h('div', { className: 'dsh-flm-mono', style: { marginTop: '8px', color: 'var(--dsw-alias-label-secondary)' } },
                t('probeResult')
                  .replace('{ok}', String(result.reachable ?? 0))
                  .replace('{slow}', String(result.slow ?? 0))
                  .replace('{region}', String(result.regionCount ?? 0))
                  .replace('{failed}', String(result.failed ?? 0)),
              ),
              // Only explain "slow" when it happened: the sentence is noise on a
              // sweep where every platform answered promptly.
              (result.slow ?? 0) > 0
                ? h('div', { className: 'dsh-flm-subnote', style: { marginTop: '6px' } }, t('probeSlowHint'))
                : null,
            )
          : null,
      )
    }

    // ── quota forecast ────────────────────────────────────────────────────────
    /**
     * Per-platform balance and burn rate.
     *
     * "Unknown" and "unlimited" are rendered as distinct states on purpose: a
     * platform that never published a daily cap is not a platform with one left,
     * and showing a number where there is none would be a lie the user acts on.
     */
    function ForecastBlock({ t, data }) {
      const forecast = data?.forecast
      const rows = forecast?.platforms && typeof forecast.platforms === 'object'
        ? Object.entries(forecast.platforms)
        : []
      if (rows.length === 0) {
        return h(Fragment, null,
          h('div', { className: 'dsh-flm-subhead' }, t('forecastTitle')),
          h('div', { className: 'dsh-flm-note', style: { marginTop: '10px' } }, t('forecastNone')),
        )
      }
      const minutes = forecast?.window?.minutes ?? 10
      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('forecastTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('forecastSub')),
        h('div', { style: { marginTop: '10px' } },
          rows.map(([platform, row]) => {
            const capped = Number.isFinite(row?.remainingRequests)
            const unlimited = row?.dailyRequestBudget === null
            const remaining = capped
              ? String(row.remainingRequests)
              : unlimited ? t('forecastUnlimited') : t('forecastUnknown')
            const runway = Number.isFinite(row?.runwayMinutes)
              ? `${Math.round(row.runwayMinutes)} ${t('forecastMin')}`
              : '—'
            const burn = Number.isFinite(row?.burnRatePerMinute) && row.burnRatePerMinute > 0
              ? `${row.burnRatePerMinute.toFixed(1)}${t('forecastPerMin')}`
              : '0'
            return h('div', { className: 'dsh-flm-keyrow', key: platform },
              h('span', { className: 'dsh-flm-keyname' }, platform),
              row?.lowBalance ? h('span', { className: 'dsh-flm-pill cool' }, t('forecastLow')) : null,
              h('span', { className: 'dsh-flm-plat' }, `${t('forecastRemaining')} ${remaining}`),
              h('span', { className: 'dsh-flm-plat' }, `${t('forecastBurn')} ${burn}`),
              h('span', { className: 'dsh-flm-keymeta', title: row?.reason }, `${t('forecastRunway')} ${runway}`),
            )
          }),
        ),
        h('div', { className: 'dsh-flm-subnote', style: { marginTop: '8px' } },
          `${minutes} ${t('forecastMin')}`),
      )
    }

    // ── fallback chains ───────────────────────────────────────────────────────
    /**
     * The configured chains, and what each currently resolves to.
     *
     * `routes` and `missing` are shown together on purpose: a chain that names a
     * model the catalog has dropped still works, just with fewer steps than the
     * user wrote, and that is invisible until a call fails on it unless the
     * panel says so.
     */
    
    // ── channels ─────────────────────────────────────────────────────────────
    /**
     * The status of the channel pack.
     *
     * Shows whether the pack is mounted, who owns it, and how many channels are
     * available. Also warns about the IP/账号封禁风险.
     */
    function ChannelsBlock({ t, data }) {
      const state = data?.state
      const reason = data?.reason
      const liveOwner = data?.liveOwner
      const channels = data?.channels
      const mountedAt = data?.mountedAt
      
      const statusMap = {
        ready: () => h('span', { className: 'dsh-flm-pill ok' }, t('channelReady')),
        owned: () => h('span', { className: 'dsh-flm-pill warn' }, t('channelOwned')),
        disabled: () => h('span', { className: 'dsh-flm-pill warn' }, t('channelDisabled')),
        unavailable: () => h('span', { className: 'dsh-flm-pill bad' }, t('channelUnavailable')),
        failed: () => h('span', { className: 'dsh-flm-pill bad' }, t('channelFailed')),
      }
      
      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('channelTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('channelSub')),
        h('div', { className: 'dsh-flm-row', style: { marginTop: '10px' } },
          statusMap[state ?? '']()
        ),
        state === 'ready'
          ? h(Fragment, null,
              h('div', { className: 'dsh-flm-keyrow', style: { marginTop: '10px' } },
                h('span', { className: 'dsh-flm-keyname' }, t('channelCount')),
                h('span', { className: 'dsh-flm-keymeta' }, channels),
              ),
              h('div', { className: 'dsh-flm-keyrow', style: { marginTop: '6px' } },
                h('span', { className: 'dsh-flm-keyname' }, t('channelMountedAt')),
                h('span', { className: 'dsh-flm-keymeta' }, new Date(mountedAt).toLocaleString()),
              )
            )
          : null,
        state === 'owned'
          ? h('div', { className: 'dsh-flm-keyrow', style: { marginTop: '10px' } },
              h('span', { className: 'dsh-flm-keyname' }, t('channelOwner')),
              h('span', { className: 'dsh-flm-keymeta' }, liveOwner),
            )
          : null,
        state === 'failed' || state === 'unavailable'
          ? h('div', { className: 'dsh-flm-keyrow', style: { marginTop: '10px' } },
              h('span', { className: 'dsh-flm-keyname' }, t('channelReason')),
              h('span', { className: 'dsh-flm-keymeta' }, reason),
            )
          : null,
        h('div', { className: 'dsh-flm-subnote', style: { marginTop: '10px', color: 'var(--dsw-alias-label-secondary)' } },
          t('channelRisk')),
        h('div', { className: 'dsh-flm-subnote', style: { marginTop: '6px', fontSize: '12px' } },
          t('channelNote')),
        )
    }
    function ChainBlock({ t, data }) {
      const chains = Array.isArray(data?.chains) ? data.chains : []
      const rejected = Array.isArray(data?.rejectedChains) ? data.rejectedChains : []

      if (chains.length === 0 && rejected.length === 0) {
        return h(Fragment, null,
          h('div', { className: 'dsh-flm-subhead' }, t('chainTitle')),
          h('div', { className: 'dsh-flm-note', style: { marginTop: '10px' } }, t('chainNone')),
        )
      }

      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('chainTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('chainSub')),

        chains.map(chain => h('div', { className: 'dsh-flm-keyrow', key: chain.name, style: { flexWrap: 'wrap' } },
          h('span', { className: 'dsh-flm-keyname' }, chain.id ?? `combo:${chain.name}`),
          h('span', { className: 'dsh-flm-pill' },
            chain.strategy === 'round-robin' ? t('chainStrategyRound') : t('chainStrategyFallback')),
          chain.strategy === 'round-robin' && (chain.stickyRounds ?? 1) > 1
            ? h('span', { className: 'dsh-flm-plat' }, t('chainSticky').replace('{n}', String(chain.stickyRounds)))
            : null,
          chain.strategy === 'round-robin' && (chain.routeCount ?? 0) > 1
            ? h('span', { className: 'dsh-flm-plat' }, t('chainCursor').replace('{n}', String((chain.cursor ?? 0) + 1)))
            : null,
          h('span', { className: 'dsh-flm-keymeta' },
            // Both numbers, because they mean different things: the definition
            // says how long the chain is, the reachable count says how much of it
            // can actually serve today. Showing only the first reads as "342
            // usable routes" when most platforms have no key.
            `${chain.reachableRoutes ?? chain.routeCount ?? 0} / ${chain.routeCount ?? 0} ${t('chainRoutes')}`),
          (chain.missing ?? []).length > 0
            ? h('span', { className: 'dsh-flm-pill cool', title: chain.missing.join(', ') },
                `${t('chainMissing')} ${chain.missing.length}`)
            : null,
        )),

        rejected.length > 0
          ? h(Fragment, null,
              h('div', { className: 'dsh-flm-subhead' }, t('chainRejected')),
              h('div', { className: 'dsh-flm-subnote' }, t('chainRejectedHint')),
              rejected.map((row, index) => h('div', { className: 'dsh-flm-keyrow', key: `r-${index}` },
                h('span', { className: 'dsh-flm-pill bad' }, t('chainRejected')),
                h('span', { className: 'dsh-flm-keyname' }, row.name ?? '(unnamed)'),
                h('span', { className: 'dsh-flm-keymeta' }, (row.problems ?? []).join(', ')),
              )),
            )
          : null,
      )
    }

    // ── reasoning policy ──────────────────────────────────────────────────────
    /**
     * What effort control each configured platform actually honours.
     *
     * This is the honest version of "thinking levels work": a platform whose API
     * has no request-side control is listed as unsupported rather than shown a
     * menu that does nothing, and a platform with a narrow enum shows only the
     * values it will accept.
     */
    function ReasoningPolicy({ t, data }) {
      const policies = data?.reasoningPolicies
      const rows = policies && typeof policies === 'object'
        ? Object.entries(policies).filter(([, policy]) => Array.isArray(policy?.efforts) && policy.efforts.length > 0)
        : []
      if (rows.length === 0) {
        return h(Fragment, null,
          h('div', { className: 'dsh-flm-subhead' }, t('reasonTitle')),
          h('div', { className: 'dsh-flm-note', style: { marginTop: '10px' } }, t('reasonNone')),
        )
      }
      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('reasonTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('reasonSub')),
        h('div', { style: { marginTop: '10px' } },
          rows.map(([platform, policy]) => h('div', { className: 'dsh-flm-keyrow', key: platform },
            h('span', { className: 'dsh-flm-keyname' }, platform),
            h('span', { className: 'dsh-flm-plat' }, t('reasonEfforts')),
            h('span', { className: 'dsh-flm-keymeta' }, policy.efforts.join(' · ')),
          )),
        ),
      )
    }

    // ── tool-capability block ─────────────────────────────────────────────────
    /**
     * What the router has actually observed, next to what the catalog merely
     * claims. Two lists, because they mean different things:
     *
     *   * observed — accumulations that have not yet crossed the threshold, so
     *     the model still competes normally;
     *   * deferred — crossed the threshold, and now tried last for tool requests
     *     until the timer runs out.
     *
     * Deferred entries are sorted by expiry so the next one to return sits on
     * top. Nothing here is persisted: restarting DSH forgets it all, which is
     * the intended lifetime.
     */
    function ToolCapability({ t, data }) {
      const cap = data?.toolCapability ?? {}
      const tracked = Array.isArray(cap.tracked) ? cap.tracked : []
      const deferred = Array.isArray(cap.deferred) ? cap.deferred : []

      const clock = ms => {
        const date = new Date(ms)
        const pad = n => String(n).padStart(2, '0')
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`
      }

      return h(Fragment, null,
        h('div', { className: 'dsh-flm-subhead' }, t('toolTitle')),
        h('div', { className: 'dsh-flm-subnote' }, t('toolSub')),

        tracked.length === 0 && deferred.length === 0
          ? h('div', { className: 'dsh-flm-note', style: { marginTop: '10px' } }, t('toolNone'))
          : h(Fragment, null,
              deferred
                .slice()
                .sort((a, b) => (a.until ?? 0) - (b.until ?? 0))
                .map(row => h('div', { className: 'dsh-flm-keyrow', key: `d-${row.key}` },
                  h('span', { className: `dsh-flm-pill cool` }, t('toolDeferred')),
                  h('span', { className: 'dsh-flm-keyname' }, row.key),
                  h('span', { className: 'dsh-flm-keymeta' },
                    `${t('toolUntil')} ${clock(row.until ?? 0)}`),
                )),
              tracked.map(row => h('div', { className: 'dsh-flm-keyrow', key: `t-${row.key}` },
                h('span', { className: 'dsh-flm-pill' }, t('toolObserved')),
                h('span', { className: 'dsh-flm-keyname' }, row.key),
                h('span', { className: 'dsh-flm-keymeta' },
                  `${row.rejections} ${t('toolRejects')}`),
              )),
            ),

        h('div', { className: 'dsh-flm-subnote', style: { marginTop: '10px' } }, t('toolHint')),
      )
    }

    // ── registration ──────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'freellmapi: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-freellmapi')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'freellmapi: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'freellmapi',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(StatusPanel, { ...props, ctx })))
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.name = 'freellmapi'
    // Seams for the headless render test, which drives each data-driven block
    // directly. The settings shell mounts these through `apply`; nothing here is
    // part of the public surface.
    exports.__test = {
      StatusPanel, NativePanel, ToolCapability, RegionBlock, ReasoningPolicy,
      RetiredBlock, RecoveryBlock, RegionProbeBlock, ForecastBlock, ChainBlock, DICT, CSS,
    }
    return module.exports
  },
})
