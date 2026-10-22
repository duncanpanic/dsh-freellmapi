# 供应商免费额度调研

> 核实日：2026-10-22。目标：为限流路由插件提供可直接编码的事实——免费额度怎么算、限制卡在哪、不同模型是否限制不同。
>
> 已覆盖 **11 / 18** 家，7 家待补（见文末「待补清单」）。
>
> 置信度：`high` = 官方文档明文；`medium` = 官方口径模糊或多源冲突；`low` = 仅第三方说法。

## 总表

| # | 供应商 | 机制类型 | 免费额度 | 关键硬限 | 要卡 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **NVIDIA NIM** | 永久 trial rate limit（credits 制已于 2025-09-10 废止） | 官方不公布数值 | 账号页显示 `Up to 40 RPM`，**无 RPD/TPD**；429 冷却 1h–24h | 手机验证 | medium |
| 2 | **OpenRouter** | 永久 rate limit 层（`:free` 模型 pricing 恒 0） | 50 请求/天；买过 ≥10 credits → 1000/天 | **20 RPM** 账户级；日额度全 `:free` 共享 | 否 | high |
| 3 | **Groq** | 永久 rate limit 层 | 文本模型统一 | **30 RPM / 1000 RPD / 8K TPM / 200K TPD**（按组织） | 否 | high |
| 4 | **Google AI Studio** | 永久 rate limit 层 | 按模型：Flash 20 RPD、Flash-Lite 500 RPD | 免费层 ≈5 RPM；Pro/图像/视频免费层为 **0** | 否 | medium |
| 5 | **Cloudflare Workers AI** | 永久计量配额（neurons） | **10,000 neurons/账号/日** ≈ $0.11 | 账号级共享池；RPM 按任务类型（文本 300） | 否 | high |
| 6 | **智谱 GLM** | 永久免费模型（不用余额） | 指定 Flash 模型四项全 0 元 | **只有并发数**，数值不公开；无 RPM/TPM/TPD | 否 | medium |
| 7 | **Mistral AI** | 最低 rate limit 层 + 月度 included usage | **官方完全不公布数字** | 只能运行时读 `x-ratelimit-*` 响应头 | 否 | medium |
| 8 | **Cerebras** | $5 一次性 trial credit（2026-07-16 起） | **$5，30 天过期** | 5 RPM / 30K uncached TPM / 1M TPD | **需要信用卡** | high |
| 9 | **SambaNova** | Free Tier（未绑卡自动落入） | 每模型 **20 RPD / 200K TPD** | 20 RPM；无 TPM | 否（但实测 402） | medium |
| 10 | **GitHub Models** | ❌ **2026-07-30 已全面退役** | 0 | — | — | high |
| 11 | **Hugging Face** | ❌ **2026-10-07 起免费额度归零** | 0（Free 表 = `None`） | 需充 credits 或 PRO $9/月 才有 $2/月 | **需要信用卡** | high |
| 12 | 阿里云百炼 DashScope | ? | ? | ? | ? | **待补** |
| 13 | 火山方舟 Doubao | ? | ? | ? | ? | **待补** |
| 14 | 硅基流动 SiliconFlow | ? | ? | ? | ? | **待补** |
| 15 | ModelScope 魔搭 | ? | ? | ? | ? | **待补** |
| 16 | Cohere | ? | ? | ? | ? | **待补** |
| 17 | Together AI | ? | ? | ? | ? | **待补** |
| 18 | Nebius AI Studio | ? | ? | ? | ? | **待补** |

### 三条通用结论

1. **credits 制基本死光了**。NVIDIA、GitHub Models 都走过 credits→rate limit 或直接退役；Cerebras 反向从永久免费层退回一次性 $5 credit；Hugging Face 干脆把免费额度归零。现行主流是「rate limit 层」或「模型级免费」。
2. **逐模型数值几乎没人公开**。18 家里只有 Groq、Google、Cloudflare、Cerebras 给了可编码的逐模型/逐档位数字；OpenRouter 官方明文「不同模型限制不同，但我们不给数字」；NVIDIA、智谱、Mistral 全部是「自己去控制台看」。
3. **响应头是唯一可靠来源**。除智谱（无 `X-RateLimit-*`）外，各家都回 `x-ratelimit-limit/remaining/reset`，插件必须运行时读取并据此自适应，**任何硬编码的 RPM/RPD 都会在下一次政策夜失效**。

---

## 逐家详情

### NVIDIA NIM（build.nvidia.com）

**免费机制**：永久 trial 层。注册并通过**手机验证**后取得 key 即可调用；没有 credits 额度池，额度不扣减也不会用完。限制为**按模型区分的动态 rate limit**，随全局并发流量浮动，官方不公布数值。

**额度**：官方不发布具体数值。唯一可观测上限是账号页右上角显示的 **`Up to 40 RPM`**（账号级）。**无每日/每月请求总量上限**。

**限流维度**：`RPM（按模型不同）`、`全局并发/同池流量`、`429 冷却期（1h–24h）`。官方未公布 TPM、TPD、RPD、并发数。

**门槛**：需要手机验证（无信用卡要求）。

**Base URL**：`https://integrate.api.nvidia.com/v1`　**OpenAI 兼容**：是

**有效期**：永久。官方明文「The trial period is not limited by a time period」，但数值可随时调整。

**逐模型限制**：

| 模型 | 限制 | 备注 |
| --- | --- | --- |
| （未公开逐模型数值） | 官方口径：RPM 随模型不同、随整体流量浮动；账号级 `Up to 40 RPM` | **编码建议：默认按 40 RPM 预算 + 滑动窗口 + 429 指数退避（带抖动）+ 按 `Retry-After` 修正 + 多 key/多模型降级** |
| `deepseek-ai/deepseek-v4.1-flash` 及 deepseek 系 | 未公开；用户报告 429 最频繁，冷却可达数小时至整天 | 用户观测，非官方 |
| Kimi K3 | 未公开；2026-09 起转稳，此前有全池 429 潮，冷却 1 小时 | 论坛观测 |
| GLM-5.2 | 未公开；曾出现全池随机限流 | 论坛观测 |
| `nvidia/nemotron-3-ultra-550b-a55b`、`nemotron-3.5-super-vl-120b-a12b`、`nemotron-3.5-lightning-30b-a3b` | 未公开 | 未见集中 429 报告，**但不能据此认为更宽松** |

**政策变更史**：2024-09 起是 credits（注册 1000，补企业邮箱并激活 90 天 AI Enterprise 再加 4000，上限 5000，**30 天后过期**）→ **2025-09-10 废止**改 rate limit → 2026-04/05 官方置顶帖确认「限制随 model/用例/全局流量浮动且不公开」。现行 = rate limit。**旧 credits 数字不可用于新实现。**

**稳定性/风控**：无封号证据，风险集中在三处——
1. **429 冷却 1h–24h**：有用户即使把请求压到 40 RPM 以下仍 429，怀疑共享后端容量；
2. **手机验证被锁**：OTP 链路返回 `TOO_MANY_REQUESTS` / `local_rate_limited`，UI 文案「This phone number has exceeded limits」，官方兜底邮箱 `help@build.nvidia.com`；
3. **独立于限流的第二道门槛**：新账号 key 状态 ACTIVE、`GET /v1/models` 正常，但 `POST /v1/chat/completions` 返回 `403 {"status":403,"title":"Forbidden","detail":"Authorization failed"}`（Public API Endpoints 权限未开通，重试无效）。

官方明确：**提额请求一律不批**。

**坑（必须读）**：
- 论坛上大量「Credit & Rate-Limit Increase Request (1,000 → 5,000 credits, 40 → 200 RPM)」是**用户自复制模板**，`1,000 credits` 是 credits 时代遗留，不是现行额度。
- 有用户明确反驳「所有模型统一 40 RPM」：*"each model has its own rate limits... You'll just have to test it yourself"*。
- 官方文档页 `docs.api.nvidia.com/nim/docs/faq` **未更新**，Q6/Q7 至今仍写 "sign up for free credits"（还把 trial 拼成 trail），**不要按它实现**。
- `40 RPM` 不是固定规则：管理员同时强调随负载浮动、不发布；有用户实测压到 40 以下仍 429，还有整日 429 与 24 小时锁的个例。建议实现为「默认 40 RPM + 滑窗 + 退避」，不要写严格分钟桶。
- **地区限制是真实风险**：手机验证国家下拉缺失巴基斯坦 +92、孟加拉 +880、俄罗斯 +7、白俄罗斯 +375、哈萨克斯坦 +7、乌兹别克斯坦 +998、阿尔及利亚 +213、泰国 +66（部分时段）；**中国 +86 时有时无且常收不到国际短信**。
- `403 Authorization failed` 与限流无关，属权限/机构开通问题，**不应作为可重试的限流错误**。

**置信度**：`medium`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317 （官方 FAQ，rate limit 机制定义，post 1451471）
- https://forums.developer.nvidia.com/t/368420 （Administrator 置顶：限制依赖 model/use-case/整体流量，不批提额）
- https://forums.developer.nvidia.com/t/344567 （credits 废止声明，post 1679151，2025-09-10）
- https://forums.developer.nvidia.com/t/306633 （旧制：1000 credits + 4000 = 上限 5000，post 1486534，2024-09-16）
- https://forums.developer.nvidia.com/t/318141 （旧 credits 30 天过期，post 1548384，2025-01-03）
- https://docs.api.nvidia.com/nim/docs/faq （仍残留 credits 文案，Q6/Q7）
- https://forums.developer.nvidia.com/t/382835 （429 实测帖）、https://forums.developer.nvidia.com/t/363923 （手机验证故障）

</details>

### OpenRouter（:free 模型免费额度）

**免费机制**：永久免费 rate limit 层（不是 credits 消耗制）：所有 ID 以 :free 结尾的模型 pricing 恒为 0，靠账户级 RPM/RPD 限流；累计购买过 ≥10 credits（≈$10，1 credit = $1）的账户，免费模型日额度从 50 提到 1000，RPM 不变。

**额度**：未付费账户：20 请求/分钟 + 50 请求/天；累计购买 ≥10 credits：20 请求/分钟 + 1000 请求/天（UTC 日）。日额度为账户内所有 :free 模型共享，不是每模型独立。

**限流维度**：`RPM（账户级，20）`、`RPD（账户级，UTC 自然日，50 或 1000）`、`无 TPM/TPD 明文限制`、`无逐模型独立额度（18 个 :free 共享同一池）`、`可另设 Key 级 credits cap 与 in-flight spending budget（通用功能，非免费专属）`

**门槛**：否（Google/GitHub/MetaMask 登录即可用 50 次/天，不绑卡、无手机验证；想拿 1000 次/天只需累计充值满 10 credits，可用信用卡/支付宝/USDC，一次性充值后长期有效）
**Base URL**：`https://openrouter.ai/api/v1`
**OpenAI 兼容**：是（OpenAI SDK drop-in：改 base_url 即可，模型名用 org/model 或 org/model:free）
**有效期**：永久（随账户存在，无到期日、无“试用期”概念；credits 也不因免费额度而过期，官方仅保留“购买满一年未使用可回收”的权利）。但免费“层”本身不承诺永久：2025-04 曾一次性从 200 砍到 50，条目也会下架。
**稳定性/风控**：有风控，但不是靠封号控额度：官方明文“Making additional accounts or API keys will not affect your rate limits, as we govern capacity globally” → 多开小号/多建 key 刷额度无效（capacity 全局治理），再加 Cloudflare DDoS 层对异常 burst 直接 429。封号/限制主要来自上游合规与滥用判定：r/openrouter 2026-09-05 有用户报告仅 $0.02 正常用量一天后账号被 restrict（页面显示 "Your account has been restricted and cannot make API…"）。另有 2025-07-28 帖称两个都充过 $10 的账号免费额度表现不一致 → 存在账户个体差异，不能假设 1000/天对所有 ≥$10 账户都稳定兑现。

**逐模型限制**：

| 模型 | 限制 | 上下文 | 备注 |
| --- | --- | --- | --- |
| （未公开逐模型数值） | 官方 docs/api_reference/limits 的 TIP 明文："We do however have different rate limits for different models, so you can share the load that way" —— 即按模型确有差异，但官方从不给数字；models API 的 per_request_limits 字段在全部 468 个模型（含 18 个 :free）上均为 null，无法代码读取逐模型额度。编码结论：只能按账户级 20 RPM / 50-or-1000 RPD 建模，剩余额度从 GET /api/v1/key 的 free_model_daily_requests{used,limit,remaining} 读，RPM 该接口不返回，需自己在路由层做令牌桶。 | — | — |
| openrouter/free（免费路由器） | 随机挑一个免费模型转发，按能力过滤；官方仅写 "may have lower rate limits than paid models"，无数字；仍消耗同一账户池，不额外加成。 | — | — |
| :free 变体 vs 同名 paid 变体（如 deepseek/deepseek-v4.1-flash:free / deepseek-v4.1-flash-1017:free vs 付费 slug） | 付费变体无平台级请求数上限（仅透传 provider 限制，pricing 页："Passthrough from the provider(s)"），:free 变体受账户池限制；两者在 models API 中是独立条目、各自有 pricing/context/endpoints → 路由插件在 :free 收到 429 时切同名付费 slug 是官方推荐做法（docs 原文："switch to the paid variant of the model, which has no platform-level request cap"）。 | — | — |
| 带 expiration_date 的 :free（dots-studio/dots-3-note-preview:free 2026-12-31；poolside/laguna-s-2.1:free、poolside/laguna-xs-2.1:free 2026-10-31） | 额度同账户池，但条目会按日期下架 → 路由表需容忍模型消失（下线后该 slug 直接不可用，不是降额）。 | — | — |

**坑（必须读）**：1) 现行口径以官方 docs/api_reference/limits + FAQ 为准（2026-10-22 亲验原文），旧资料里的“200 请求/天”是 2025-04 上旬前的废止口径，不要采用；中文博客至今大量沿用 200 或写“50 RPM”。2) 文档有 bug：说明句中写着 “the higher daily ceiling is granted starting one credit below the table's threshold (currently {FREE_MODEL_CREDITS_THRESHOLD - 1} credits)”——模板占位符未渲染，具体数字缺失，但语义明确为“表格阈值 -1 credit”，即实际约 9 credits 也能拿到 1000/天；编码时别硬编码 10 作为唯一判据，优先读 GET /api/v1/key 的 is_free_tier 与 free_model_daily_requests.limit。3) 日额度按 UTC 日重置，中国时区相当于每天 08:00 重置。4) TPM/TPD 未文档化，下游做路由不要假设存在 token 级免费额度；失败/回退请求是否计数未明文，实测口径未验证。5) 免费模型只有 18 个（pricing 页营销写“25+ free models”，与实际 CATALOG 不一致），且 3 个带 expiration_date 随时下架，路由表必须能容忍 404/模型消失。6) “不需要信用卡”是针对 50/天档；1000/天档必须真实充值过 money（≥~$10），只领免费 credits 不算。7) 国内网络需代理，openrouter.ai 与 api 端点直连不稳；支付宝支持有限。8) 官方未承诺政策稳定性，历史上 24 小时内直接从 200 砍到 50，插件应把限流参数做成可配置而非写死。9) rpm 20 为账户全局，且 accounts/endpoints “exempt from free-model limits” 的少量白名单存在（文档提到 exempt 账户不受该计数约束），故不能仅凭 free_model_daily_requests.remaining 判断 429 一定会来。10) zendesk 官方 KB 原文 403 未能打开核对，其数字与其他官方页一致但不作为第一依据。

**置信度**：`high`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://openrouter.ai/docs/api_reference/limits（主依据：Free usage limits 表格 20 RPM/50 RPD、≥10 credits 1000 RPD；free_model_daily_requests；按模型有差异的 TIP；429 头与 paid variant 建议）
- https://openrouter.ai/docs/faq（“50 requests per day total”“at least 10 credits → 1000 requests per day”）
- https://openrouter.ai/pricing（Free 档 Rate limits: 50 requests/day；付费档 Passthrough from the provider(s)）
- https://openrouter.ai/docs/guides/routing/model-variants/free（:free 是独立 catalog 条目、限制可能与付费版不同）
- https://openrouter.ai/docs/guides/routing/routers/free-router（openrouter/free 随机选免费模型，官方承认限制更低）
- https://openrouter.ai/api/v1/models（2026-10-22 实测：468 模型 / 18 个 :free，pricing 全 0，per_request_limits 全 null）
- https://github.com/OpenRouterTeam/docs/commits（api_reference/limits.mdx 提交史：2026-07-14 起口径未变；2026-09-16 29901db85f 才新增 free_model_daily_requests）
- https://www.reddit.com/r/SillyTavernAI/comments/1jtyibt/new_openrouter_limits/（2025-04-07：200 → 50 的现场记录）
- https://news.aibase.com/en/news/16952（2025-04-09 政策变更报道）
- https://github.com/BerriAI/litellm/issues/9035（2025-03-06 引旧文档 200/day，可作旧口径锚点）
- https://www.reddit.com/r/RooCode/comments/1jwwufu/about_openrouter_free_models/（2025-04-11 u/OpenRouter-Toven 确认 50/1000 分档）
- https://openrouter.zendesk.com/hc/en-us/articles/39501163636379-OpenRouter-Rate-Limits-What-You-Need-to-Know（官方客服 KB，TL;DR 50/day + 20/min、>$10 → 1000/day；原文 403 未打开，仅搜索引擎摘要）
- https://www.reddit.com/r/openrouter/comments/1w7vzx7/what_are_the_reasons_an_account_can_get/（2026-09-05 账号被 restrict 案例）
- https://www.reddit.com/r/openrouter/comments/1mbdq0x/openrouter_treats_accounts_differently/（2025-07-28 两账号额度不一致）

</details>

### Groq 免费层（Free Plan）

**免费机制**：永久免费 rate limit 层（按**组织**计数，从来不是 credits 制）：注册即得 gsk_ key，无赠金、无试用期；只有当你绑卡升级 Developer 才解锁更高限速，而那是按 token 后付费、不含任何免费余额。

**额度**：文本模型统一 30 请求/分钟 + 1,000 请求/天 + 8,000 tokens/分钟 + 200,000 tokens/天（每组织，非每 key）；whisper 20 请求/分钟 + 2,000 请求/天 + 音频 7,200 音频秒/小时 / 28,800 音频秒/天；Orpheus TTS 10 请求/分钟 + 100 请求/天 + 1,200 TPM + 3,600 TPD；prompt-guard 30 请求/分钟 + 14,400 请求/天 + 15,000 TPM + 500,000 TPD。金额额度 = 0（没有 credits 这一维度）。

**限流维度**：`RPM`、`RPD`、`TPM`、`TPD`、`ASH（音频秒/小时）`、`ASD（音频秒/天）`、`ITPM/OTPM（仅部分组织额外配置）`

**门槛**：否
**Base URL**：`https://api.groq.com/openai/v1`
**OpenAI 兼容**：是。完全 OpenAI 兼容：OpenAI SDK 只改 base_url 与 api_key 即可；速率信息走 x-ratelimit-* 响应头与 429 + retry-after。
**有效期**：永久层，无到期日、无「用完即停用」的一次性额度，可随时从 Developer 降级回 Free（降级需先结清尾款）。但两件事不是永久的：①每个模型的配额可被官方调整；②模型 ID 本身会被退役（约提前 60 天发邮件公告，随后直接 4xx），2026 年已连续发生 5 轮。另有 hackathon 类偶发促销 credits，属例外而非常设额度。
**稳定性/风控**：中等偏稳，但风险点很具体：①ToU 明文写着「若你的 IP 被封禁，你同意不得以隐藏 IP 或使用代理 IP 的方式绕过」——用代理/VPN 池刷免费额度是写进条款的违约；②服务协议保留 suspend/terminate 权，且额度按组织计，多开 key 无用、多开账号属规避（社区与文档口径一致：rate limits apply at the organization level）；③真正发生过的大规模「额度被收回」不是封号而是**模型退市**（llama 全系、compound、qwen3.6 都已被删）；④没有 credits 可被追回，因此不存在「赠金被清零」类风控；⑤本次未检索到成规模的「随机封号」公开案例（官方 developer community 论坛今日已重定向到 groq.com 首页，检索不到历史帖），所以封号严重性只能按条款判断，不宜当成既成事实。

**逐模型限制**：

| 模型 | 限制 | 上下文 | 备注 |
| --- | --- | --- | --- |
| openai/gpt-oss-120b | 30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD | 131,072 | 当前免费层的主力文本模型，也是 llama-3.3-70b 被下线后的官方指定替代。真实 429 样本：'on tokens per minute (TPM): Limit 8000, Used 7600, Requested 950'（免费组织实测）。按 1 轮≈400 tokens 估算 ≈500 轮/天。 |
| openai/gpt-oss-20b | 30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD | 131,072 | 官方指定替代 llama-3.1-8b-instant。注意：它并不继承 8B 当年的 14,400 RPD，日请求数掉到 1,000。 |
| openai/gpt-oss-safeguard-20b | 3 RPM / 1,000 RPD / 2,000 TPM / 200,000 TPD | — | 内容审核专用，RPM 只有 3，最容易撞墙，插件应默认把它排除在并发池外。 |
| qwen/qwen3.8-27b | 30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD | 131,072 | 27B 多模态，思考/指令双模式、可调 reasoning effort。2026-09-14 起取代 qwen3.6-27b。 |
| whisper-large-v3 | 20 RPM / 2,000 RPD / 无 TPM / 无 TPD / 7,200 ASH / 28,800 ASD | — | 语音转写按音频秒计，不占文本 TPM 池（不同模型各自独立计数）。 |
| whisper-large-v3-turbo | 20 RPM / 2,000 RPD / 无 TPM / 无 TPD / 7,200 ASH / 28,800 ASD | — | 与 large-v3 同额度。 |
| canopylabs/orpheus-v1-english | 10 RPM / 100 RPD / 1,200 TPM / 3,600 TPD | — | TTS，日请求只有 100，做批量语音必须单独限流。 |
| canopylabs/orpheus-arabic-saudi | 10 RPM / 100 RPD / 1,200 TPM / 3,600 TPD | — | 阿拉伯语 TTS，额度同上。 |
| meta-llama/llama-prompt-guard-2-22m | 30 RPM / 14,400 RPD / 15,000 TPM / 500,000 TPD | — | 8B 小模型，是当前免费表里唯一还保留 14,400 RPD 的模型，适合做分类/守卫类高频任务。 |
| meta-llama/llama-prompt-guard-2-86m | 30 RPM / 14,400 RPD / 15,000 TPM / 500,000 TPD | — | 同上。 |
| llama-3.3-70b-versatile / llama-3.1-8b-instant / llama-4-scout-17b / qwen3-32b / kimi-k2-instruct / groq/compound(-mini)（均已下线） | 已关停，硬编码即 404：llama-3.1-8b-instant 与 llama-3.3-70b-versatile 于 2026-08-16 关停；qwen3-32b、llama-4-scout 于 2026-07-17 关停；qwen3.6-27b 于 2026-09-14 关停；groq/compound 与 compound-mini 于 2026-09-21 关停（8-24 公告）。下线前的免费档历史值仅供对照：70B = 30 RPM / 1,000 RPD / 12,000 TPM / 100,000 TPD；8B = 30 RPM / 14,400 RPD / 6,000 TPM / 500,000 TPD；compound = 30 RPM / 250 RPD / 70,000 TPM。 | — | 这是本次核查最关键的结论：网上仍在流传的『30 RPM / 14,400 RPD』大配额、以及『免费可用 llama-3.3-70b』，指向的模型 2026-08-16 已被删号；插件里若保留这些 model id 会直接报错，而不是降速。 |

**坑（必须读）**：1) 数字口径：官方 rate-limits 页有「Free Plan Limits / Developer Plan Limits」两个 tab，且页面自带免责声明「这是高层级摘要，可能有例外；你组织的精确值见 /settings/limits」。本次抓到的是 Free 档（30/1K/8K/200K），与 2026-10 三个独立第三方（10-10 实测 429 报错 Limit 8000、10-16 tracker、10-09 复核）完全一致；但 Developer tab 的数字（如 250K TPM / 1K RPM）长得像「免费额度」，抓页面时极易抓错 tab。2) 政策变更史（必须按这个顺序理解）：2024-02 上线即 rate-limit 制、从无 credits → 2024-10 提高免费配额 → 2025 引入 Developer 付费层（free 仍在）→ 2026-07/08 连删 qwen3-32b、llama-4-scout、llama-3.1-8b、llama-3.3-70b → 2026-09 删 qwen3.6-27b、groq/compound → 2026-10 免费表只剩 10 行。所以「14,400 RPD 随便用」是 2026-08 之前的世界，现行说法是 1,000 RPD。3) 老博客不可信：klymentiev（10-04）与 ampm（转述 08-09 的页面）仍在列 llama 行和分「small/large 两档」，前者还把 70B 写成 8K TPM/200K TPD（与官方及另两源冲突），应以官方表为准。4) 「绑卡后仍有 10 倍免费额度、超额才收费」是第三方说法，官方 billing FAQ 的口径是升级即按 token 后付费、月结或阶梯阈值（$1/$10/$100/$500/$1000）扣款，插件不要据此设计「绑卡=免费提额」。5) 日额重置时刻官方未公布（第三方称 UTC 零点），只提供 x-ratelimit-reset-* 与 retry-after，别硬编码重置时间。6) 代码要点：x-ratelimit-limit-requests 恒为 RPD、x-ratelimit-limit-tokens 恒为 TPM；cached tokens 不计入限流；限制是「模型 × 组织」二维，跨模型互不占用，同组织多 key 共享同一池。7) 地区：中国大陆 IP 直连 console.groq.com 今日多次 403（Cloudflare），官方文档也是靠 CORS 代理才取到，且 ToU 禁止用代理绕 IP 封禁——路由插件若部署在受限地区需自行评估合规。8) 今日多次重取官方页均失败（console.groq.com 直连 403、allorigins/codetabs 522/超时），本表来自当日成功取得的一次官方渲染文本，未能在同一时段二次复核；数值若与你的 /settings/limits 不符，以控制台为准。

**置信度**：`high`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/deprecations
- https://console.groq.com/docs/billing-faqs
- https://console.groq.com/docs/models
- https://groq.com/terms-of-use
- https://www.grizzlypeaksoftware.com/articles/p/groq-api-free-tier-limits-in-2026-what-you-actually-get-uwysd6mb
- https://klymentiev.com/blog/groq-api-free-tier
- https://ampm-aiops.com/en/guides/groq-faq-2026/
- https://inferenceapis.com/reference/errors/groq-429-rate-limit-exceeded
- https://freetiertracker.com/s/groq/
- https://shahriarlabs.com/products/freelm/errors/groq-rate-limit-reached/
- https://localaimaster.com/blog/groq-api-free-guide
- https://www.eesel.ai/blog/groq-pricing

</details>

### Google AI Studio / Gemini API（Gemini Developer API）

**免费机制**：永久免费 rate limit 层（免费层项目按「项目×模型」硬限流 RPD/RPM/TPM/IPM），额度撞墙即返回 429、按太平洋时间午夜重置；不是 credits 制，不需要绑卡或先充值解锁

**额度**：无 credits；按模型给日请求数：gemini-3.8-flash 20 请求/天、Flash-Lite 系 500 请求/天、免费层普遍约 5 RPM；Pro / 图像 / 视频 / 音乐 / TTS 免费层为 0（不可用）。图片/视频生成与 Gemini 3 Pro 不在免费层内

**限流维度**：`RPM（每分钟请求）`、`RPD（每天请求，按项目×模型独立计数）`、`TPM（每分钟 token）`、`IPM（每分钟图像，图像模型）`、`Live API 并发会话数（免费层 3 个会话）`、`配额挂在项目+模型上，不是挂在 API key 上`

**门槛**：否
**Base URL**：`https://generativelanguage.googleapis.com`
**OpenAI 兼容**：部分兼容：官方提供 OpenAI 兼容层 https://generativelanguage.googleapis.com/v1beta/openai/（以 chat/completions 为主，tool/参数非完全等价），原生端点 /v1beta/models/{model}:generateContent
**有效期**：名义上长期存在，官方明确不保证：Google 员工原话 look at the free tier, if there is one, as something we provide best effort but it is highly unstable and not likely to persist；已发生不经预告的一次性大幅回收（2025-12-07，Flash 250→20 RPD）
**稳定性/风控**：风险等级高，有确证先例：2025-12-06/07 全部模型免费层被未预告下调（Flash 250 RPD→20 RPD，-92%），官方论坛 26 帖抗议，Google 员工 Logan Kilpatrick 承认是为给 Gemini 3 Pro / Nano Banana Pro 腾算力；免费层 prompt/response 会被用于改进产品且可能人工审阅；绑定 GCP 计费后仍卡 free-tier 配额的 bug 报告（api-examples#98，2026-03-04，至今 open）；Workspace/企业账号频繁报 403 / Status: Restricted / Billing Tier: Unavailable；未见「刷免费额度被直接封号」的确证案例，但 429 与 402（余额 0 不自动降级）很常见。任何写死 250/1500 RPD 的实现都会在下一次政策夜失效

**逐模型限制**：

| 模型 | 限制 | 上下文 | 备注 |
| --- | --- | --- | --- |
| gemini-3.8-flash（2026-09-02 GA，当前主力 Flash） | 免费层 20 RPD（请求/天，按项目×模型）；免费层 RPM 约 5；TPM 未公开。20 RPD 来自 2026-09-03 与 2026-10-16 两次独立开发者实测/论坛反馈，非官方明文 | — | 绑定计费账号（Tier 1）即解除 20 RPD；免费层输入/输出/缓存均免费，但内容会被用于改进产品 |
| gemini-3.8-flash-lite / gemini-3.5-flash-lite（Flash-Lite 档） | 免费层 500 RPD（同一 2026-09-03 帖中与 3.8 Flash 的 20 RPD 对比给出）；RPM/TPM 未公开 | — | 免费层内最宽松的文字模型档，适合做 fallback 兜底 |
| gemini-3.6-flash | 未单独公开；2026-08-31 起 3.5 Flash 请求被路由到 3.6 Flash，按 Flash 档经验值 ≈20 RPD，需实测确认 | — | 官方未给逐模型数值，只能按档位推断 |
| gemini-3.1-flash-lite | 免费层列表内含此模型；具体 RPD/RPM 未公开，按 Flash-Lite 档量级（数百 RPD）推断 | — | 同家族 3.1-flash-lite-preview 已下线 |
| gemini-3-flash-preview（legacy 预览） | 20 请求/天/模型/项目（2026-03-04 GitHub issue 的 429 原文：quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 20） | — | 唯一带完整配额指标名的硬证据；预览模型可能比 GA 模型更严 |
| gemini-3.1-pro-preview / gemini-3-pro | 免费层：无。官方模型清单明确标为 paid-only（含 customtools 变体） | — | 路由遇到 Pro 必须直接走付费或降级，不要重试免费层 |
| gemini-2.5-pro | 2025-12 前免费层：5 RPM / 250,000 TPM / 25 RPD（另有 2025-09 的 limit: 50 报错案例，说明当时口径不统一）；2025-12-07 起移出/大幅限缩免费层，2026-09-18 起仅对历史存量用户开放 | — | 新项目基本拿不到 2.5 Pro 免费额度 |
| gemini-2.5-flash | 2025-12 前免费层：10 RPM / 250,000 TPM / 250 RPD；2025-12-07 未预告砍到 20 RPD（-92%）；现仅历史存量用户可用 | — | 本次政策变更的主角模型 |
| gemini-2.5-flash-lite | 免费层存在（历史用户）；免费层 RPD 未公开；Tier 1 曾出现 5,000 RPD 上限的 bug 报告（2026-02-18） | — | 付费档也出现过 RPD 错配，限额并非只卡免费层 |
| gemini-2.0-flash / 2.0-flash-lite | 已下线（shut down）；历史免费层 15 RPM / 1,000,000 TPM / 1,500 RPD | — | 仅作历史对照，路由不应再指向 |
| gemini-1.5-flash / 1.5-flash-8b / 1.5-pro | 已下线；历史免费层 1.5 Flash 15 RPM / 1,000,000 TPM / 1,500 RPD，1.5 Flash-8B 30 RPM / 1,000 RPD，1.5 Pro 2 RPM / 32,000 TPM / 50 RPD | — | 第三方文章仍在引用这些数字（如「1500 RPD」），属过期信息，切勿编码进去 |
| 图像/视频/音乐/TTS（nano-banana-2.1、3.1-flash-image、3-pro-image、Veo 3.1、gemini-omni-1.1-flash、Lyria 3.5、2.5-pro-preview-tts） | 免费层：无。2025-12-07 起图像生成免费额度取消；TTS 一度残留 10 RPD 后也被移除 | — | 生成类模型一律按「无免费额度」处理 |
| gemini-embedding-2 / live audio / transcribe / tts 档 | 免费层列表中存在，但数值未公开；历史 Embedding 表为 5 RPM / 100 RPD | — | embeddings 免费额度通常宽松，但无现行明文 |
| gemma-4 系列（gemma-4-31b-it 等） | 仅在免费层提供（付费档标 Not available）；具体 RPD 未公开，历史 Gemma 3 为 30 RPM / 14,400 RPD | — | 免费层的「无限量」错觉来源，实际仍受 RPD 限制 |
| （未公开逐模型数值） | 2025-12 起官方不再公布逐模型表：现行 rate-limits 页只列维度（RPM/RPD/TPM/IPM）并写明限制 depend on a variety of factors (such as your usage tier) and can be viewed in Google AI Studio，且 specified rate limits are not guaranteed and actual capacity may vary。可编码规律：旗舰 Flash 20 RPD、Flash-Lite 500 RPD、Pro 无免费层、图像/视频/音乐无免费层、免费层 RPM ≈5、配额按项目×模型独立 | — | 插件实现建议：配置里放可覆盖的 per-model 默认值 + 429 自适应退避，把 limit=0 视为「无免费额度」 |

**坑（必须读）**：1) 官方站 ai.google.dev 在本环境 web_fetch 全部失败（rate-limits、pricing、r.jina.ai 代理、generativelanguage 模型列表均超时），现行官方表未直接读到，数字来自「官方文档镜像存档 + 官方论坛员工表态 + 开发者实测 + 第三方 2026-10 综述」四方交叉。2) 2025-12 起官方取消逐模型表，明确说数值随 usage tier/项目动态变化，必须在 AI Studio 项目页核对；插件应按 429 自适应而非写死。3) 20 RPD / 5 RPM 是实测与论坛口径，非官方明文；同批 2025-12 快照存在 25 vs 50 RPD 冲突。4) 免费层可用性强依赖账号类型与地区（EEA/UK/CH 条款要求对外分发即付费；Workspace/绑卡账号常无免费层）。5) 第三方文章仍大量引用 1500 RPD 等 2.0/1.5 时代数字，属过期。6) 这套数字历史上多次变更，任何人引用都必须标注日期。

**置信度**：`medium`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/pricing
- https://gemini-api.apidog.io/doc-965865
- https://github.com/google-gemini/api-examples/issues/98
- https://discuss.ai.google.dev/t/do-they-really-think-we-wouldnt-notice-a-92-free-tier-quota/111262
- https://discuss.ai.google.dev/t/gemini-3-8-flash-free-tier-20-rpd-is-too-limited-for-practical-evaluation/180609
- https://discuss.ai.google.dev/t/free-tier-5-rpm-prevents-me-from-running-a-full-turn-of-an-llm-agent/113180
- https://discuss.ai.google.dev/t/quota-exceeded-for-metric-generativelanguage-googleapis-com-generate-content-free-tier-requests-limit-50/105796
- https://www.aifreeapi.com/en/posts/google-gemini-api-rate-limits-per-tier
- https://www.aifreeapi.com/en/posts/google-gemini-api-free-tier

</details>

### Cloudflare Workers AI

**免费机制**：永久免费的**计量配额**层——按神经元（neuron）计量，**10,000 neurons / 账号 / 日**，超出当天直接报错停用；同时叠加一套按任务类型定义的 RPM 限流。**两个限制维度彼此独立**。

**额度**：10,000 neurons/账号/日 ≈ **$0.11/日**（单价 $0.011/1,000 neurons）。换算举例：
- `@cf/meta/llama-3.2-1b-instruct` → 输入 **4.07M tokens** 或输出 548k tokens
- `@cf/meta/llama-4-scout-17b-16e-instruct` → 输入 ≈407k
- `@cf/baai/bge-m3` embedding → ≈9.3M tokens

同一个 10k 额度在这些模型间**共享消耗**，不是各自 10k。

**限流维度**：`neurons/日（账号级总量）`、`RPM（按任务类型）`、`RPM（按模型，仅"需付费模型"）`。**没有** TPM/TPD/RPD/并发的文档化限制。

**门槛**：否（Workers Free 默认开通、注册不需绑卡——推断，无明文）。要突破 10k 则需 Workers Paid $5/月 或 AI Gateway 预付 credits。

**Base URL**：`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`　**OpenAI 兼容**：是

**有效期**：永久，每日重置，无到期日。

**逐模型限制**：

| 模型 | 限制 | 备注 |
| --- | --- | --- |
| （未公开逐模型 neurons 配额） | 官方 pricing/limits 页**没有**任何逐模型 neurons/日 字段。10,000 是**账号级共享池**，所有模型（含 embeddings/图像/语音）从同一池扣 | **不要为 73 个模型编造各自每日上限** |
| Text Generation 类（绝大多数文本模型） | **300 RPM**（per account），除非属下方付费类 | 例外：`@cf/baai/bge-large-en-v1.5` 属 embedding 且为 1500 |
| Text Embeddings | **3000 RPM**（`bge-large-en-v1.5` = **1500 RPM**） | |
| Text-to-Image | **720 RPM**（`stable-diffusion-v1-5-img2img` = **1500 RPM**） | |
| ASR / Image-to-Text / Translation | **720 RPM** | |
| Summarization | **1500 RPM** | |
| Text Classification | **2000 RPM** | |
| Image Classification / Object Detection | **3000 RPM** | |
| `@cf/moonshotai/kimi-k2.6`、`kimi-k2.7-code`、`@cf/zai-org/glm-5.2`、`glm-5.3`、`glm-5.3-flash`、`@cf/deepseek-ai/deepseek-v4-flash-0731`、`deepseek-v4.1-flash-1017`、`deepseek-v4-pro-0813` | **20 RPM**（预付 AI Gateway credits 时 50 RPM） | **这 8 个模型 Workers Free 计划完全不可用**（调用返回 `5035 / HTTP 403`），路由应在选模型阶段就排除，而不是靠限流兜底 |

**消耗速率（决定 10k 何时烧完，per M tokens）**：`llama-3.2-1b` 2457入/18252出 · `llama-3.2-3b` 4625/30475 · `llama-3.1-8b-instruct-fp8-fast` 4119/34868 · `llama-4-scout-17b` 24545/77273 · `llama-3.3-70b-instruct-fp8-fast` 26668/204805 · `gpt-oss-120b` 31818/68182 · `gemma-4-26b-a4b-it` 9091/27273 · `bge-m3` 1075/M · `flux-1-schnell` 4.80/tile + 9.60/step · `whisper` 41.14/音频分钟。

**稳定性/风控**：未找到封号或额度被收回案例，但有四类**实际验证过**的行为问题：
1. **错误码文档与现网不一致**：官方写 `3036`（429 "Account limited"），实际免费额度耗尽返回 **`4006`**。→ **用 `4006` 做主判据，`3036` 兜底**。
2. **「00:00 UTC 重置」不成立**：官方文档明写，但 GitHub issue [cloudflare-docs#34137](https://github.com/cloudflare/cloudflare-docs/issues/34137) 两个免费账号实测——封锁持续到**距最后一次用量约 24 小时**（23:32 用完 → 次日 23:51 才成功，24h15m）。→ **按 rolling 24h 退避，不要按 UTC 日切重置计数器**。
3. **dashboard 与 API 不一致**：封锁期间控制台显示 `0 / 10,000`（看着已重置），API 仍 4006；**Playground 在额度耗尽时依然能正常回答**。两者都不能判断可用性。
4. **没有余额查询 API**（官方原文 "Workers AI has no 'remaining budget' API"）。只能自建计数器，或事后用 GraphQL Analytics `aiInferenceAdaptiveGroups` 对账。

**坑（必须读）**：
- 2024-09-26 官方 changelog 曾说「No more neurons, moving towards unit-based pricing」，**现行已部分回退**：前台展示 per-model 单价，但原文明确仍按 neurons 后台计费，免费额度仍以 `10,000 Neurons per day` 表述。任何「免费额度已改为按 token/请求数计算」的说法都不成立。
- 模型下线频繁：2026-05-30 一次性下线 18 个模型；`kimi-k2.5 → kimi-k2.6` 会自动别名**并涨价**。路由表要能远程下发。
- `wrangler dev` 远程推理**也计入**该账号 10k 额度。
- 10,000 neurons 是**全账号共享池**，同时服务多个 Worker/租户时配额是同一个池。

**置信度**：`high`（配额/RPM/付费模型 全部官方页面原文）；重置时间 `medium`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://developers.cloudflare.com/workers-ai/platform/pricing/ （Last updated Oct 20, 2026）
- https://developers.cloudflare.com/workers-ai/platform/limits/ （Last updated Sep 17, 2026）
- https://developers.cloudflare.com/workers-ai/platform/errors/ （Last updated Sep 17, 2026）
- https://developers.cloudflare.com/workers/platform/pricing/ （Last updated Oct 2, 2026）
- https://developers.cloudflare.com/workers-ai/models/
- https://developers.cloudflare.com/workers-ai/changelog/ （Last updated Apr 21, 2026）
- https://github.com/cloudflare/cloudflare-docs/issues/34137 （重置时间 bug 实测）
- https://blog.koorevaar.com/articles/workers-ai-free-plan-rag-lessons （2026-10-13 实测计量）

</details>

### 智谱 AI 开放平台 GLM（bigmodel.cn）

**免费机制**：永久免费模型层：指定的 Flash 模型输入/输出/缓存四项全按 0 元计价、完全不消耗余额，不是"注册赠 credits 用完停用"；平台不赠注册 credits、也无新用户 token 包，限制只加在**并发数**上，且逐模型数值不公开（需登录控制台查看），超限即 429

**额度**：无 tokens / 请求数配额（免费模型不计费，官方未设 RPD/TPM/TPD 上限）；唯一硬约束是并发数——每模型独立、数值不公开、由用户权益等级 V0–V3 决定（积分门槛 2000 / 10000 / 50000）；无新用户 token 包或赠金额度领取入口（已核对官方文档全量索引 llms.txt，无任何"新用户赠送/免费额度领取"页面）

**限流维度**：`并发数（官方定义＝同一时刻正在处理中的请求数，不是 RPM）`、`并发按模型族独立（通用 / 图像视频生成 / 向量 / 实时音视频各自一套）`、`并发按用户权益等级 V0–V3 分档（积分：<2000 / 2000–10000 / 10000–50000 / ≥50000）`、`平台级高峰期动态限流与过载保护（与单账户无关）`、`Coding Plan 独立配额体系（5 小时 / 7 天 / 周 / 月，错误码 1308–1321）`、`RPM / TPM / TPD（官方未设、未公开，不要假设）`

**门槛**：否　**Base URL**：`https://open.bigmodel.cn/api/paas/v4`　**OpenAI 兼容**：是

**逐模型限制**（免费模型四项 0 元；差异在上下文/输出与实测可用性）：

| 模型 | 限制 | 上下文 / 输出 | 备注 |
| --- | --- | --- | --- |
| （未公开逐模型数值） | 官方只写「不同模型设有独立的并发限制」，**不发布任何 per-model 并发数字** | — | 查询入口 `https://bigmodel.cn/usercenter/proj-mgmt/rate-limits`（需登录）。提额走 `https://bigmodel.cn/rate-limits/form`，10 个工作日审核，GLM Coding Plan 用户不支持申请 |
| `glm-4-flash-250414`（别名 `glm-4-flash`） | 免费；并发上限不公开 | 128K / 16K | **实测最稳**：2026-08-10 两秒间隔 6 并发全过（6/6），延迟 0.7–1.7s；2026-09-03 复测四轮 788–960ms 全正常。**兜底主力首选**，写带日期的编码更安全 |
| `glm-4.7-flash` | 免费；并发上限不公开但**实测极其紧张** | 200K / 128K | 官方主推（2026-01-19），但**可用性最差**：10 次连发成功 4 次、失败 6 次且全为 `1305`，成功时平均 8.9 秒；2026-09-03 复测四轮全败。思考型：`max_tokens` 是「思考+回答」总预算，给 <1500 会返回空 content + `finish_reason=length` |
| `glm-4.5-flash` | 免费（页面原文「完全免费开放使用」） | 128K / 96K | ⚠️ 模型页 NOTE 明文「将于 2026-01-30 下线……请求将自动路由至 GLM-4.7-Flash」，但页面仍在、2026-08-10 实测仍可调通（很慢，18–42 秒）。**编码不要依赖** |
| `glm-4.6v-flash` | 免费；视觉推理（图片+视频） | 128K / 32K | 2026-09-03 实测 4 次成功 1 次（与 4.7-Flash 同档拥挤） |
| `glm-4.1v-thinking-flash` | 免费；视觉推理 | 64K / 16K | 2026-08-10 实测 1.9 秒正常返回，可用性明显好于 4.6V-Flash |
| `glm-4v-flash` | 免费；官方 FAQ 明确**只支持单张图像** | 16K / 1K | 2026-08-10 实测 1.1 秒，最稳的免费视觉入口 |
| `cogview-3-flash` | 免费图像生成；属「图像视频生成」独立限流族，并发极紧 | — | 关键实测（同账号同一时刻并发 6 个）：`glm-4-flash` 6/6 全过，`cogview-3-flash` **只过 1/6**（8.3s）→ 证明限流按模型计算 |
| `cogvideox-flash` | 免费视频生成；图像视频族独立限流 | — | 官方定价与模型概览均标免费，逐模型数值未取得 |

**坑（必须读）**：
- **响应头无任何 `X-RateLimit-*` 字段**，无法预知余量，只能撞 429 后用本地并发信号量自适应。既然拿不到配额数字、也读不到剩余量，**不能写死任何 RPM 值**。
- 错误码 `1305` 是**模型侧公共资源不足**，降频无效，只能退避重试。
- 报错文案「您的账户已达到速率限制」**会误导**——实际限流是按模型的，不要据此停掉整条链路。
- 上下文数字两处不一致：`glm-4v-flash` 模型概览写 16K、定价页写 4K；按 16K 用但别硬依赖。

**置信度**：`medium`（机制有官方文档，但并发数值官方不公开）　**核实日**：2026-10-22

### Mistral AI (La Plateforme / Mistral Studio — Free mode)

**免费机制**：注册即得 Free mode（无信用卡即可建 key，不赠送一次性 credits）：本质是"最低 rate limit 层 + 每月 included usage"，官方现在完全不公布数字，实际数值只在 Admin Panel › API › Limits 里按模型逐行显示；月度额度用尽即停止服务（默认不自动转按量扣费），只有开启 pay-as-you-go 才升到 Tier 1。

**额度**：官方不公布任何数值（无 RPM、无 TPM、无月度 token 数）。官方只规定三层：每模型 RPS/RPM、每模型 TPM（输入+输出）、组织每月 token 总额。历史口径仅供参照、均已废弃：2024–2026年中的 Experiment plan 为 ~1 请求/秒、500,000 tokens/分钟、1,000,000,000 tokens/月；2026-09-01 至 2026-10-07 14:48 UTC 定价页写 "$10/mo in API credits"，2026-10-07 22:04 UTC 起该行被删除，现行页面无数字。

**限流维度**：`RPM`、`RPS`、`TPM（输入+输出）`、`每月 token 总额`、`并发数（文档并入 RPS 维度）`、`音频秒/分钟（仅 Voxtral 转写）`、`TTS 输入字符/分钟`

**门槛**：否
**Base URL**：`https://api.mistral.ai/v1`
**OpenAI 兼容**：是（OpenAI 兼容）：base_url 设为 https://api.mistral.ai/v1 后可直接用 OpenAI SDK，标准 POST /v1/chat/completions 与 /v1/models。另有非 OpenAI 端点：/v1/embeddings、/v1/moderations、/v1/ocr、/v1/audio/transcriptions、/v1/audio/speech、/v1/audio/voices，实时转写走独立 realtime 协议。
**有效期**：长期存在但政策高度不稳定，不属于"一次性试用"：Free mode 自 2024-09-17 起持续存在、无到期日，但具体额度与"哪些模型免费"在过去 12 个月被反复改动且从不公告 —— 2026-08-02 与 2026-10-07 两次静默修改定价页、旧 Experiment 文档与帮助页全部 404。结论：通道永久，额度不保证。
**稳定性/风控**：不稳定，有可查证的额度收回与能力收回案例（但无公开封号证据）：①r/MistralAI 2026-09-22 用户称 mistral-large-latest 在免费层正常用了 9 个月后突然返回"not supported by my plan"；②2026-10-07 开发者加 $10 credit 后调 mistral-large-4 仍得 403 subscription tier，证明充值不解锁；③GitHub 有 issue 标题直指 "free plan no longer activates API keys"（用户报告，源自 2026-10-10 讨论）；④独立监测站 14 天 1029 次真实调用仅 313 次成功（30%），失败中 502 次是 429；⑤2026-07-30 到 2026-09-10 之间 mistral-small/medium 由 50 RPM 降为 0 RPM、mistral-large 由 4 RPM 变 403。风险形态是"静默降级/归零"而非封号，对路由插件意味着必须做可用性熔断与模型降级链。

**逐模型限制**：

| 模型 | 限制 | 上下文 | 备注 |
| --- | --- | --- | --- |
| Ministral 3B (ministral-3b-latest / ministral-3b-2512) | 750 RPM / 1,300,000 TPM（2026-09-10 从 x-ratelimit-limit-req-minute、x-ratelimit-limit-tokens-minute 实测）；2026-10-22 复测仍 200 可用。免费层最宽的一档，路由应优先压这里。 | — | 另一独立探测（2026-07-30）读到的 rpm 同为 750，两源一致。 |
| Ministral 8B (ministral-8b-latest / ministral-8b-2512) | 188 RPM / 625,000 TPM（2026-09-10 实测头）；2026-10-22 仍 200。 | — | 两套独立探测均为 188 RPM。 |
| Ministral 14B (ministral-14b-latest / ministral-14b-2512) | 30 RPM / 937,500 TPM（2026-09-10 实测头）；2026-10-22 仍 200。 | — | 注意 RPM 比 8B 低很多但 TPM 更高，按 RPM 还是按 TPM 挑模型会得出不同结论。 |
| Codestral 2508 / mistral-code (codestral-latest, mistral-code-latest, mistral-code-fim-latest) | 125 RPM / 625,000 TPM（2026-09-10 实测头）；2026-10-22 全部 200 可用，是免费层仅剩的两个可用家族之一。 | — | 两源一致 125 RPM。OmniRoute 讨论里用户也说 free plan 只剩 Ministral 和 Codestral 能用。 |
| Voxtral Small chat (voxtral-small-latest / voxtral-small-2507) | 60 RPM / 50,000 TPM（2026-09-10 实测头）；2026-10-22 仍 200。 | — | TPM 只有 5 万，是可用模型里最容易撞日额度的。 |
| labs-leanstral-1-5 / labs-leanstral-1-5-1 | 38 RPM / 5,000,000 TPM（启用 Labs 后实测）；未启用时返回 403，报错原文『Model labs-leanstral-1-5 is a Labs model. To use Labs models, an admin must enable them in…』。 | — | 5M TPM 是实测里所有 chat 模型最高值。开关位置在 Admin Panel › API › Privacy（不是 Vibe › Privacy），插件可据此自动提示用户。 |
| Mistral Medium 3.5 全系别名（mistral-medium-latest / mistral-medium / -3 / -3.5 / -3-5 / -2505 / -2508 / -2604 / mistral-vibe-cli-latest / mistral-vibe-cli-with-tools / magistral-medium-latest） | 0 RPM —— 响应头直接返回 x-ratelimit-limit-req-minute: 0，任何调用立刻 429，报错体『{"message":"Rate limit exceeded","type":"rate_limited","code":"1300"}』。2026-10-22 复测仍全部 429。 | — | 关键坑：429 并不代表“临时限流可以重试”，这里是配额被设成 0，重试永远无效。插件必须把 0-RPM 与可用模型的偶发 429 区分开。另外 2026-07-30 时它还有 50 RPM，两个月内被清零 —— 数字绝不能写死。 |
| Mistral Small 4 全系别名（mistral-small-latest / mistral-small-2603 / mistral-vibe-cli-fast / magistral-small-latest） | 0 RPM（429 rate_limited）；2026-10-22 仍 429。 | — | 同上，属“被清零”而非“被临时限流”。2026-07-30 曾是 50 RPM。 |
| Mistral Large 3 / mistral-large-latest / mistral-large-2512 | 无 RPM 可言 —— 直接 403，报错原文『This model is not available in your subscription tier』，响应不带任何 rate-limit 头（请求没走到配额判定）。 | — | 2026-07-30 还有 4 RPM（可调），2026-09 起变 403。用户报告免费层用了 9 个月的 large-latest 突然被掐。充值 $10 也不解锁。插件应把它当作硬不可用并永久拉黑该模型。 |
| Mistral Large 4 (mistral-large-4 / mistral-large-4-0) | 403 tier_not_allowed，code 1910，报错『This model is not available in your subscription tier』；无 rate-limit 头。 | — | 官方 2026-10-06 发布推文写『Available to all via API today』但未说哪个套餐，与实测冲突；开发者加 $10 credit 后仍 403。保持当作不可用。 |
| zai-glm-5-2 / glm-5-2（GLM 5.2） | 403 tier_not_allowed，报错同上；无 rate-limit 头。 | — | 在 /v1/models 目录里能查到，但免费层无权调用 —— 目录可见 ≠ 有权调用。 |
| Devstral 系列（devstral-2512 / devstral-latest / devstral-medium-latest / mistral-code-agent-latest） | 429 rate_limited（无 0-RPM 头记录，实测直接 429）；且这几个 ID 在模型中目录已 51–56 天未再出现。 | — | 疑似已退役/下线，插件不要依赖。 |
| Embeddings（mistral-embed / mistral-embed-2312 / codestral-embed / codestral-embed-2505） | 60 RPM（四个 ID 全部 200）。 | — | 走 /v1/embeddings，不要拿 chat 端点探测，否则得到 400 invalid_model 的假阴性。 |
| Moderation（mistral-moderation-2603） | 100 RPM（/v1/moderations 返回 200）。 | — | Mistral Moderation 2 是定价页唯一标注 outright Free 的模型。 |
| OCR 系列（mistral-ocr-2512 / -3 / -3-0 / -4 / -4-0 / -4-1 / -latest） | 全部 200 可用，但未观察到 RPM/TPM 响应头 —— 官方未给该能力配 rate-limit 头，配额未知（不编数字）。 | — | 走 /v1/ocr。 |
| Voxtral 离线转写（voxtral-mini-2602 / voxtral-mini-latest） | 60 RPM + x-ratelimit-limit-audio-seconds-minute: 3600，即每分钟 3600 音频秒。 | — | 独立配额维度，不能用 token 维度换算。 |
| Voxtral TTS（voxtral-mini-tts-2603 / voxtral-mini-tts-latest） | 12,000 输入字符/分钟。 | — | 按字符而非 token 计，插件需单独建一条计数通道。 |
| Voxtral 实时转写（voxtral-mini-transcribe-realtime-2602 / voxtral-mini-realtime-2602 / -latest） | 流式会话可成功建立并完成（非 REST，走 realtime 客户端协议）；未观察到明确的 RPM 头数值。 | — | 不能用 REST 探测，否则得到 400 假阴性。 |
| （官方未公开逐模型数值） | 这是本次调研最重要的编码事实：Mistral 官方拒绝公布免费层任何数字。官方只说三层维度（RPS、TPM、每月 token 总额）且『按模型分别设置』，具体值只在 Admin Panel › API › Limits 逐模型显示，接口响应头 x-ratelimit-limit-req-minute / x-ratelimit-limit-tokens-minute 会实时回传。因此插件必须：①每次调用后读响应头并缓存，②遇 429 先看 limit 是否为 0（0 = 永久不可用，不该重试），③遇 403 tier_not_allowed 直接拉黑模型，④绝不硬编码任何数值。 | — | 上表所有具体数字均来自第三方实测响应头，非官方发布，会随时间变化（已有 2 个月内 50 RPM→0 RPM、4 RPM→403 的实例）。 |

**坑（必须读）**：1) 官方域名 docs.mistral.ai / help.mistral.ai / web.archive.org 在本机网络全部连接超时（curl exit 28、web_fetch 30s timeout），我未能直接打开官方原文；官方措辞来自 Exa 索引的逐句片段，并靠两份独立追踪站（BenchLM 读取于 2026-10-16、aifreeapi 2026-10-09）+ 两套独立实测站三重互证。这是 confidence 为 medium 而非 high 的首要原因。2) 上表所有具体 RPM/TPM 数字均为第三方用真实免费 key 从响应头读出，Mistral 从未官方发布过任何一个免费层数字，且已知 2 个月内发生过 50 RPM→0 RPM、4 RPM→403 的变动，数字必然过期，插件只能运行时读头。3) "免费额度是否已被砍"目前公开信息无法定论：2026-10-07 定价页删掉 $10/mo 那行后，官方文档仍描述 included monthly usage，两种解读（额度还在只是不印 / 额度已砍）都成立。4) 手机验证：官方明说无需信用卡，实测用 Google 登录注册（2026-08-04）全程未要求手机号，但有第三方报告称邮箱注册可能被要求短信验证 —— 属风控变量，非普遍强制。5) 商用：官方仅说 Free mode "intended for evaluation and prototyping"，未找到明确禁止商用，也未找到明确允许，不要当定论；且免费层默认会用你的输入输出训练模型（需在 Admin Panel › Privacy 手动关闭），客户数据不要走这里。6) 地区：以上实测样本含 EU 组织与美国服务器地址，不同地区/组织可能给出不同配额。7) Mistral Large 4 标 "Public Preview"，按其 Commercial ToS 4.2/4.3 属 Labs/Preview 模型，可能被用于训练且 opt-out 含零数据保留均不适用。8) 别把 429 一律当限流：免费层存在 limit 被设为 0 的模型，这类 429 重试永远不会成功，必须读响应头 limit 值区分。

**置信度**：`medium`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://docs.mistral.ai/admin/billing-usage/usage-limits
- https://docs.mistral.ai/admin/billing-usage/subscriptions
- https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key
- https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them
- https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models
- https://legal.mistral.ai/terms/commercial-terms-of-service
- https://mistral.ai/pricing/
- https://web.archive.org/web/20260802054807/https://mistral.ai/pricing/
- https://web.archive.org/web/20261007144814/https://mistral.ai/pricing/
- https://web.archive.org/web/20261007220416/https://mistral.ai/pricing/
- https://nachtigall.dev/en/writing/mistral-vibe-devex-audit
- https://stillworks.supercapybara.com/llm/mistral
- https://www.aifreeapi.com/en/posts/mistral-api-free-tier
- https://benchlm.ai/free-tier/mistral
- https://github.com/cheaper-inference/OmniRoute/discussions/16252
- https://github.com/cheaper-inference/OmniRoute/issues/16279
- https://github.com/Calmer26/FreeTier_Radar/issues/10
- https://www.reddit.com/r/MistralAI/comments/1wul35u/are_we_going_to_ignore_that_mistral_removed_free/
- https://www.reddit.com/r/MistralAI/comments/1w1soss/mistrallargelatest_stopped_working/
- https://skillhub.360.com/skills/orionshaowswmw/free-tier-ai-router-v2

</details>

### Cerebras Inference Cloud

**免费机制**：无永久免费层：注册后必须绑定已验证的支付方式才发放 $5 一次性 trial credits（按 token 计费），同时受 Free Trial 层 rate limit 约束，credit 30 天过期或耗尽即停用

**额度**：$5 一次性 credit（约等于 $0.35/1M 输入 + $0.75/1M 输出的 token 预算）；Free Trial 限流：5 请求/分钟、30K uncached tokens/分钟、90K 总 tokens/分钟、1M tokens/小时、1M tokens/天（逐模型相同）

**限流维度**：`RPM`、`TPM (uncached tokens/min)`、`TPM (total = 3× uncached)`、`TPH`、`TPD`、`信用额度 dollars`、`单请求 max_completion_tokens 预扣`、`图片数/请求`

**门槛**：需要信用卡
**Base URL**：`https://api.cerebras.ai/v1`
**OpenAI 兼容**：是，OpenAI 兼容（/v1/chat/completions、/v1/models；官方提供 openai 与 litellm 两种 SDK 接法，无需私有鉴权头）
**有效期**：一次性且有期限：$5 credit 自发放起 30 天过期或按用量耗尽，官方明确无永久免费层（\"Is there a permanently free tier? No.\"），无自动续期
**稳定性/风控**：条款层面有明确风控：pricing 页脚注写明 $5 credit \"may be withheld or revoked in cases of fraud, abuse, or duplicate accounts\"；coupon-rules 授权 Cerebras 无预警撤销，并禁止多账号、自动生成代码、转售。已证实的实际影响是 2026-08-17 整体关停旧免费层（迁移邮件+社区帖子一致）；未检索到具体封号/收回个例

**逐模型限制**：

| 模型 | 限制 | 上下文 | 备注 |
| --- | --- | --- | --- |
| gpt-oss-120b | Free Trial: 5 RPM / 30K uncached TPM / 90K total TPM / 1M TPH / 1M TPD；上下文 65K（付费 131K），max output 32K（付费 40K）；Developer 层：1K RPM / 1M uncached TPM / 3M total TPM，无小时/日限 | — | 该模型文档页仍残留旧版 "30 RPM / 60K TPM / 1M TPD" 免费层文案，属 2026-07-16 前旧政策，勿用于现行实现 |
| qwen-3.8-27b | Free Trial: 5 RPM / 30K uncached TPM / 90K total TPM / 1M TPH / 1M TPD；上下文 64K（付费 128K），max output 32K（付费 40K），图片 2 张/请求、payload 10 MiB；Developer 层：300 RPM / 150K uncached TPM / 750K total TPM，无日限 | — | 2026-09-22 起 total TPM 临时由 450K 上调至 750K，标准值为 uncached 的 3 倍；替代已下线的 gemma-4-31b（2026-09-03 仅保留 Dedicated） |
| （未公开逐模型数值） | 除上述两个模型外，其余模型（gpt-oss-20b、llama 系、GLM 4.7 等）在公共/Free Trial 端点不可用，只能走 Dedicated/Enterprise（按合同定价与限流）；cerebras.ai/code 的 Free Trial（GLM 4.7）仅标注 "limited tokens and requests"，无公开 RPM/TPM/TPD 数值。已知规律：Free Trial 各模型限值相同（5 RPM 量级），Developer/Dedicated 才按模型显著分化 | — | 不要把 gpt-oss-120b 的 Developer 数字外推到其他模型 |

**坑（必须读）**：1) 政策仍在快速变动：2026-07-16 由永久 rate-limit 免费层改为 $5 credit trial，2026-10-05 又把 Free Trial 与 $10 Developer 合并为单一 Developer 层，但 docs 仍保留 Free Trial 标签页，说明文档与产品未完全同步；数字会变，请以运行时 x-ratelimit-* 响应头为准。2) 存在自相矛盾的官方文本：models/openai-oss.md 仍写 30 RPM/60K TPM/1M TPD，这是旧政策残留，不要照抄；现行以 support/rate-limits 表格 + models/qwen-3.8-27b.md 为据。3) 配额是连续补充的 token 桶而非固定窗口重置，且请求前按 max_completion_tokens 预扣，max_tokens 设过大会提前 429——限流器必须按预估值建模，不能只看实际用量。4) 未文档化并发数上限与地区限制；绑定支付方式需通过卡验证，部分地区/预付费卡可能失败（未获官方确认）。5) \"Free Trial 各模型限值相同\" 只对当前两个公开模型成立，其余模型不可用公共端点，相关数字纯属合同内容、无公开值。

**置信度**：`high`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://inference-docs.cerebras.ai/support/rate-limits
- https://inference-docs.cerebras.ai/support/change-log
- https://www.cerebras.ai/pricing
- https://inference-docs.cerebras.ai/console/account-billing
- https://inference-docs.cerebras.ai/models/qwen-3.8-27b.md
- https://inference-docs.cerebras.ai/models/openai-oss.md
- https://www.cerebras.ai/coupon-rules
- https://www.cerebras.ai/code
- https://news.ycombinator.com/item?id=48941271
- https://github.com/cheaper-inference/OmniRoute/issues/11773
- https://www.usagepricing.com/blueprint/activity/cerebras-2026-07-21-free-tier-credit-trial
- https://www.usagepricing.com/blueprint/cerebras
- https://support.cerebras.net/articles/6781839574-how-do-the-different-rate-limits-interact-with-each-other-hourly-daily-etc

</details>

### SambaNova Cloud

**免费机制**：rate limit 分层，**不用 credits**。账户**未绑定支付方式**时自动落入 Free Tier，按模型各自计 **20 RPM / 20 RPD / 200,000 TPD**；绑定支付后升 Developer Tier（按 token 计费），受**全模型合计 20M TPD** 约束。

**额度**：Free Tier 每模型 **20 RPM + 20 RPD + 200,000 TPD**；Developer Tier 账户级 20,000,000 TPD。

**限流维度**：`RPM`、`RPD`、`TPD`。**没有 TPM 维度**。另有未公开数值的并发上限（错误码 `429 queue_full` = "Too many in-flight requests"）。

响应头可直接消费：`x-ratelimit-limit-requests` / `-remaining-requests` / `-reset-requests`（分钟级）与 `x-ratelimit-limit-requests-day` / `-remaining-requests-day` / `-reset-requests-day`（日级）。官方原文：**"You can hit either limit type (RPM or RPD) depending on which one you reach first"** —— RPM 与 RPD 是**独立两把锁**。

**门槛**：**否**（官方明文 "Free Tier: Applied when there is no payment method linked"）⚠️ 但 2026-08-31 第三方实测免费账户返回 `402 PAYMENT_METHOD_REQUIRED`。→ 按「无需卡」建档，按「可能需要卡」做可用性降级。

**Base URL**：`https://api.sambanova.ai/v1`　**OpenAI 兼容**：是

**有效期**：名义永久（按有无支付方式二元判定，文档无到期日），但**实际极不稳定**——2025-01～02 员工明确说过「free tier is indeed being transferred to the developer tier」「We do not have any current plans to maintain the free tier in any state」，2026 年又出现在文档里。**不要当长期稳定资源。**

**逐模型限制**（Free 层全部相同，差异只在 Developer 层的 RPM/RPD 与各模型 max output/上下文）：

| 模型 | Free / Dev | 上下文 | 备注 |
| --- | --- | --- | --- |
| `DeepSeek-V3.1` | Free 20/20/200k；Dev 60 RPM / 12,000 RPD | 128k（`/v1/models` 报 131,072） | max output 仅 7,168 |
| `Meta-Llama-3.3-70B-Instruct` | Free 20/20/200k；Dev **240 RPM / 48,000 RPD**（全表最高） | 128k | **max output 仅 3,072**——与 131k 上下文严重不对称，长输出任务不要选它 |
| `gpt-oss-120b` | Free 20/20/200k；Dev 60 RPM / 12,000 RPD | 128k | 输出上限与上下文同宽 |
| `DeepSeek-V3.2` | Free 20/20/200k；Dev 60 RPM / 12,000 RPD | **32k** | Preview，可随时下线；上下文只有 V3.1 的 1/4 |
| `gemma-4-31B-it` | Free 20/20/200k；Dev 60 RPM / 12,000 RPD | 文档 128k；`/v1/models` 报 **262,144**（不一致） | Preview，支持文本+图像+视频 |
| `MiniMax-M3` | **（未公开逐模型数值）**——限流文档 Production/Preview 两表均未列入 | 1,048,576 | **不应假定等于 20/20/200000**；纯文本部署，传图像/视频会报错 |
| `MiniMax-M2.7` | **（未公开逐模型数值）** | 196,608 | 第三方 `/v1/models` 2026-09-03 可见，**2026-10-11 已消失**；唯一支持 Prompt Caching |

**稳定性/风控**：有实际案例，但**未见公开封号**：
1. **额度耗尽后 402 且不解封**：用户超过 24 小时仍无法访问，换同账户另一个 key 也无效。
2. **绑卡后仍被锁在 Free Tier**：员工承认计费系统迁移中，Free→Developer 需**人工手动切换**。
3. **Developer Tier 间歇性 `insufficient credits`**：已绑卡仍报错。
4. **免费账户被全面拒绝**：同一 key 的 `/v1/models` 返回 **200 + 全量模型列表**，而 `/chat/completions` 全部 **402**；旧 key 现返 401。

**坑（必须读）**：
- **健康检查陷阱**：**`/v1/models` 200 ≠ 能跑推理**。插件不能用 `/v1/models` 判可用性，必须发一次真实 chat 请求。
- **`402` 官方未收录**（错误码表只到 429/400/410/503）。代码里把 **402 = 账户不可用/需付费**、**429 `insufficient_quota` = 限流**、**429 `queue_full` = 并发满可重试** 三分处理，语义完全不同。
- **RPD = 20 是硬性上限**：20 RPM 看着还行，但一天 20 次就锁死。**这不是可用的免费层，是试用层**，不应作为主力。
- **配额绑定账户，不绑定 API key**：员工原话「These limits are per model and tied to your account (not the API key), which is why switching to a different key on the same account wouldn't change anything.」→ **轮换 key 无法扩容**。
- **日配额按固定日窗口重置，不是滚动 24 小时**：从响应头 `x-ratelimit-reset-requests-day` 读，不要自己算 now+24h。
- 文档表格有排版错误：Free Tier 两张表的表头单元格也印着 "Developer"（第 465、493 行块），实际内容是 Free Tier 数值。
- `cloud.sambanova.ai/plans` 是 JS 渲染，片段提到「Free — Add a payment method and purchase credits to run your first requests」，**暗示现行 Free plan 可能已要求加卡+买 credits**，与文档冲突，未据以改写门槛。

**置信度**：`medium`（逐模型数值是官方明文，但官方文档「免费层存在」与 2026-08-31 实测「402 拒绝」直接冲突）　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://docs.sambanova.ai/docs/en/models/rate-limits （现行 v2.2.6，逐模型数值来源）
- https://docs.sambanova.ai/docs/en/models/sambacloud-models
- https://docs.sambanova.ai/docs/en/api-reference/using-the-api/api-error-codes （429 `insufficient_quota` / `queue_full`；**表中无 402**）
- https://sambanova.ai/blog/sambanova-cloud-developer-tier-is-live （2025-02-08，$5 credits/3 个月，历史过渡）
- https://community.sambanova.ai/t/is-free-tier-going-away/847
- https://community.sambanova.ai/t/the-daily-limit-is-not-resetting-after-24-hours/1704
- https://community.sambanova.ai/t/rate-limits-for-developer-tier-still-only-20-requests-per-minute/1614
- https://community.sambanova.ai/t/developer-tier-free-models-not-working/1717
- https://toolfreebie.com/sambanova-cloud-free-api/ （2026-08-31 实测 402 证据）

</details>

---

## 待补清单（下次继续）

以下 7 家子智能体已派出但**产出未回收**（结果超出工具输出上限被截断，需重跑）：

| # | 供应商 | 状态 | 备注 |
| --- | --- | --- | --- |
| 12 | 阿里云百炼 DashScope (Qwen) | ⬜ 待补 | 重点：每模型新用户 100 万 token 规则与有效期、`dashscope.aliyuncs.com/compatible-mode/v1` |
| 13 | 火山方舟 (豆包 Doubao) | ⬜ 待补 | 重点：每模型 50 万 token 赠送、`ark.cn-beijing.volces.com/api/v3`、实名要求 |
| 14 | 硅基流动 SiliconFlow | ⬜ 待补 | 重点：模型广场标 `free` 的模型、免费模型 RPM/并发、是否实名 |
| 15 | ModelScope 魔搭 API-Inference | ⬜ 待补 | 重点：每日免费调用次数、`api-inference.modelscope.cn/v1`、是否必须绑阿里云 |
| 16 | Cohere | ⬜ 待补 | 重点：trial key 每月上限是否永久、command 系限制 |
| 17 | Together AI | ⬜ 待补 | 重点：是否有真免费模型、按模型 RPM |
| 18 | Nebius AI Studio | ⬜ 待补 | 重点：新用户赠额、免费模型、`api.studio.nebius.ai/v1` |

另外还有两家**已知存在但未纳入本次名单**，可作为下一轮候选：Chutes、MiniMax 开放平台。

> 重跑办法：分批派子智能体（**并发上限 8**，实测一次派 18 个会直接报 `subagent limit reached (active child limit: 8)`），每批 6 个，并把结果**直接落文件**而不是塞进工具返回值，避免再次被 50KB 输出上限截断。

### GitHub Models

**免费机制**：现行：无免费额度（2026-07-30 服务全面退役，playground/模型目录/inference API/BYOK 已对所有客户关闭，含存量活跃客户）。历史：永久免费 rate limit 层——按 Copilot 套餐档位 × 模型档位（Low/High/Embedding 及特定模型组）发放固定 RPM/RPD/单请求 token 上限/并发数，超限返回错误并等待窗口重置；从未使用 credits 制，也不存在 credits→rate limit 的政策切换。

**额度**：现行 0（服务已退役，无任何可用请求额度）。退役前免费层（Copilot Free 与 Pro 同档）：Low 档 15 RPM / 150 RPD；High 档 10 RPM / 50 RPD；Embeddings 15 RPM / 150 RPD；DeepSeek-R1 组 1 RPM / 8 RPD；o1/o3/gpt-5 组 Free 档不可用、Pro 档 1 RPM / 8 RPD；Grok-3 1 RPM / 15 RPD；Grok-3-Mini 2 RPM / 30 RPD。单请求统一 8000 输入 + 4000 输出 token（Low/High 档，Enterprise 部分放宽到 16K/8K）。

**限流维度**：`RPM（每分钟请求数）`、`RPD（每天请求数）`、`单请求输入 token 上限`、`单请求输出 token 上限`、`并发请求数`

**门槛**：否
**Base URL**：`https://models.github.ai/inference`
**OpenAI 兼容**：是（历史）：OpenAI Chat Completions 兼容，端点为 https://models.github.ai/inference，实际调用路径 https://models.github.ai/inference/chat/completions，org 归属变体 https://models.github.ai/orgs/ORG/inference/chat/completions；鉴权用 GitHub PAT（需 models:read 权限）。2026-07-30 退役后该 base URL 已失效（实测 https://models.github.ai 返回 4 字节空响应），任何按 OpenAI 兼容格式的路由配置都必须移除。
**有效期**：历史定性为『永久免费原型层』（permanent free prototyping tier），不是一次性试用、也不是限期赠送；但该永久层以『产品整体退役』方式终止，而非因额度耗尽停用。时间线：2026-06-16 停止新客户开通（免费与付费均停）→ 2026-07-01 宣布退役计划并预告 2026-07-16、2026-07-23 两次计划内 brownout（短暂强制报错）→ 2026-07-30 全量关停。付费选项（pay-as-you-go 走 GitHub 账单、BYOK 自带 OpenAI/Azure key）于 2025-06-24 上线，与免费层同期消失。
**稳定性/风控**：未检索到 GitHub Models 免费层因风控封号或单独收回额度的具体案例；其风险以更彻底的形式落地——整个产品被退役（2026-07-30），所有客户额度归零。可查到的相关风控案例均在 Copilot 侧而非 Models 侧，属不同服务不可类推：r/GithubCopilot 2026-02-27『GitHub Copilot CLI account suspended for non-interactive activity』（非交互式高强度调用被停号）、2026-03-13『Account suspended 1 hour after posting a question about Claude Opus』（无预警无邮件）。另有社区讨论 #137298（2024-08-30）显示用户对『25 个模型是否合计 2000 请求/天』存在误解，官方回复确认额度按模型独立计算、不合并。

**逐模型限制**：

| 模型 | 限制 | 上下文 | 备注 |
| --- | --- | --- | --- |
| Low 档（含 gpt-4o-mini、gpt-4.1-mini、Phi-4、Mistral Small、gemma-2-27b-it、Llama 小参数量等） | Copilot Free 15 RPM / 150 RPD / 8000 in + 4000 out token / 5 并发；Copilot Pro 同 Free（15/150/8000+4000/5）；Copilot Business 15 RPM / 300 RPD / 同一 token 上限 / 5 并发；Copilot Enterprise 20 RPM / 450 RPD / 8000 in + 8000 out / 8 并发 | 不适用（受单请求 8000 in / 4000 out 硬顶约束，与模型标称上下文无关） | Free 与 Pro 完全同档，这是最易误判处；RPD 按模型独立计数，不是跨模型共享池 |
| High 档（含 gpt-4o、gpt-4.1、Llama-3.1-70B-Instruct、Mistral-large、command-r-plus、o3-mini 早期归属） | Copilot Free 10 RPM / 50 RPD / 8000 in + 4000 out / 2 并发；Copilot Pro 同 Free（10/50/8000+4000/2）；Copilot Business 10 RPM / 100 RPD / 同 token 上限 / 2 并发；Copilot Enterprise 15 RPM / 150 RPD / 16000 in + 8000 out / 4 并发 | 不适用（单请求 token 上限同样远小于标称上下文，如 gpt-4.1 标称 1M 仍只接受 8K 输入） | gpt-4o 50 RPD 已由 2024-08-30 社区讨论 #137298 与第三方清单双向印证 |
| Embeddings 档 | Copilot Free 15 RPM / 150 RPD / 64000 tokens / 5 并发；Copilot Pro 同 Free；Copilot Business 15 RPM / 300 RPD / 64000 tokens / 5 并发；Copilot Enterprise 20 RPM / 450 RPD / 64000 tokens / 8 并发 | 单请求 64000 tokens | 唯一 token 上限明显高于对话档的档位 |
| Azure OpenAI o1-preview / o1 / o3 / gpt-5 | Copilot Free 不适用（N/A，不可用）；Copilot Pro 1 RPM / 8 RPD / 4000 in + 4000 out / 1 并发；Copilot Business 2 RPM / 10 RPD / 4000 in + 4000 out / 1 并发；Copilot Enterprise 2 RPM / 12 RPD / 4000 in + 8000 out / 1 并发 | 不适用（单请求 4000 in + 4000 out） | o1-preview、o1、o3、gpt-5 四者在官方表中共用同一行完全相同的数值 |
| o1-mini / o3-mini / o4-mini / gpt-5-mini / gpt-5-nano / gpt-5-chat | Copilot Free 不适用（N/A）；Copilot Pro 2 RPM / 12 RPD / 4000 in + 4000 out / 1 并发；Copilot Business 3 RPM / 15 RPD / 4000 in + 4000 out / 1 并发；Copilot Enterprise 3 RPM / 20 RPD / 4000 in + 4000 out / 1 并发 | 不适用（单请求 4000 in + 4000 out） | 整组共用一行，Enterprise 也不放宽输出上限 |
| DeepSeek-R1 / DeepSeek-R1-0528 / MAI-DS-R1 | Copilot Free 1 RPM / 8 RPD / 4000 in + 4000 out / 1 并发；Copilot Pro 1 RPM / 8 RPD / 同上；Copilot Business 2 RPM / 10 RPD / 同上；Copilot Enterprise 2 RPM / 12 RPD / 同上 | 不适用（单请求 4000 in + 4000 out） | 全表最严的一档，1 RPM/8 RPD 是多数人以为的『GitHub Models 只有 8 次/天』的来源 |
| xAI Grok-3 | Copilot Free 1 RPM / 15 RPD / 4000 in + 4000 out / 1 并发；Copilot Pro 同 Free；Copilot Business 2 RPM / 20 RPD / 4000 in + 8000 out / 1 并发；Copilot Enterprise 2 RPM / 30 RPD / 4000 in + 16000 out / 1 并发 | 不适用（单请求 token 上限见左） | 唯一在 Enterprise 档把输出上限抬到 16000 的模型 |
| xAI Grok-3-Mini | Copilot Free 2 RPM / 30 RPD / 4000 in + 8000 out / 1 并发；Copilot Pro 同 Free；Copilot Business 3 RPM / 40 RPD / 4000 in + 12000 out / 1 并发；Copilot Enterprise 3 RPM / 50 RPD / 4000 in + 12000 out / 1 并发 | 不适用（单请求 token 上限见左） | 全表 RPM 最高（3）且 RPD 最高（50）的档位 |
| （未公开逐模型数值） | 官方只公布『档位』数值，未逐模型公布 RPM/RPD：具体模型归入 Low / High / Embedding 哪一档，需在该模型 GitHub Marketplace 详情页查看『模型类型』字段（官方原文：Low, high, and embedding models have different rate limits. To see which type of model you are using, see the model information in GitHub Marketplace）。同一档内所有模型共享同一组 RPM/RPD/token/并发数值，且各模型 RPD 独立计数、不跨模型合并。 | 官方未逐模型公布，受所在档位单请求 token 上限约束 | 这是本次调研最重要的编码事实：路由插件应按『档位』而非『模型名』建桶；不要把 Low/High 数值硬绑到具体模型名上，因为模型可在改版后换档，而官方声明『这些限制可能会更改，恕不另行通知』 |

**坑（必须读）**：1) 最关键的坑：现行额度是 0，任何把 GitHub Models 当可用免费 provider 写进路由表的插件都会全部请求失败；「退役」本身是官方文档与 changelog 双份明文，属 high 置信。2) perModel 中那套逐档位数值是『历史值』，取自已下线的官方页面，我通过 githubdocs.cn 的官方文档镜像取得完整原表，并用四个独立来源交叉校验了 Free/Pro 的 Low(15/150) 与 High(10/50) 两组核心数字（ModelHubby、prismix、2024-08-30 社区 #137298 的『gpt-4o 50/天、gpt-4o-mini 150/天』、cheahjs/awesome-free-llm-apis 类清单）；但官方英文原页已 404、github/docs 仓库 main 分支该 md 已删除、Wayback 多次超时，因此原表未能从 docs.github.com 直接取回，Business/Enterprise 列建议按『历史参考』对待，不要当作可校验的现行契约。3) 存在第三方口径冲突：prismix.dev 写 High 档『8k tokens/day』与官方『每请求 8000 in / 4000 out』不符，以官方为准；Roy Portas 博客称『很多模型仅 1 RPM / 8 RPD』正确但仅适用于 DeepSeek-R1 组与 o1/o3/gpt-5 组，不可外推到全目录。4) 网上广泛流传的『GitHub 每月送 AI credits』属 GitHub Copilot 的计量机制（2025-11 起），与 GitHub Models 无关，切勿混入 Models 的额度模型。5) 官方原文明确『这些限制可能会更改，恕不另行通知』，且模型会在改版后换档（例如 o3-mini 早期被列 High 档、后期单独成组），任何缓存的历史数字都会过期。6) 无地区限制证据，但服务已全局下线，地域讨论失去意义。7) 若插件需要『GitHub 系』的免费额度，唯一切换方向是 Copilot 的 AI credits（维度完全不同：月配额而非 RPM/RPD），不属于本次调研范围，需另行核实。

**置信度**：`high`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://docs.github.com/en/github-models
- https://github.blog/changelog/2026-07-30-github-models-is-now-retired
- https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/
- https://github.blog/changelog/2026-06-16-github-models-is-no-longer-available-to-new-customers/
- https://github.blog/changelog/2025-06-24-github-models-now-supports-moving-beyond-free-limits/
- https://githubdocs.cn/en/github-models/use-github-models/prototyping-with-ai-models
- https://github.com/orgs/community/discussions/137298
- https://www.modelhubby.com/providers/github-models/
- https://prismix.dev/guides/github-models-guide
- https://docs.github.com/en/enterprise-cloud@latest/github-models/use-github-models/prototyping-with-ai-models

</details>

### Hugging Face Inference Providers

**免费机制**：需付费解锁：免费账户无任何月度免费额度（官方表格 Free Users / Monthly Credits = "None"），必须先充值 credits 或订阅 PRO（$9/月，含 $2.00/月通用 compute credits）才能调用；历史上是"注册赠 $0.10/月 credits"，更早（2025-02 前）才是按请求速率计的免费层。属于"付费前不可用"，不是 rate-limit 型免费层。

**额度**：免费账户 = 0（无月度 credits，无免费请求数）；PRO = $2.00/月；Team/Enterprise = $2.00/席/月。均为美元 credits，非请求数，按 provider 逐模型单价（input/output token、图像、音频秒数）扣减，HF 不加价、原价透传。

**限流维度**：`账户 credits 余额（美元，唯一官方硬闸门）`、`Hub API 请求数 / 5 分钟固定窗口`、`Hub Resolvers 请求数 / 5 分钟固定窗口`、`Hub Pages 请求数 / 5 分钟固定窗口`、`provider 侧 RPS（HF 未公布）`、`provider 侧并发请求数（HF 未公布）`

**门槛**：需要信用卡
**Base URL**：`https://router.huggingface.co/v1`
**OpenAI 兼容**：是。OpenAI 兼容：base_url=https://router.huggingface.co/v1 ，/chat/completions 与 /v1/models 均可用（官方 SDK 示例同址）；鉴权为 Bearer HF token；模型名可带策略后缀 :fastest（默认）/ :cheapest / :preferred / :<provider>，如 openai/gpt-oss-120b:cheapest；GET /v1/models 返回跨 provider 的模型列表含单价/上下文/延迟/吞吐。旧 api-inference.huggingface.co 已无 DNS 记录。
**有效期**：免费额度已不存在（2026-10-07 起永久取消，非一次性赠额、非限时）。历史上 $0.10/月 是"每月重置、可长期持有"的额度但官方标注 "subject to change"。PRO 的 $2.00/月 每月入账、随订阅存续，订阅取消即失去；已购 credits 不受月度重置影响，用完需再购。
**稳定性/风控**：有，且是本次调研最强的一块：①2026-10-07 PR #2865 直接把免费额度归零，社区帖 t/189971（2026-10-08）与 t/190220 抗议，第三方汇总站称有员工在论坛解释为"constant abuse"所致（该员工原帖未取到，只能算线索）；②2025-02 那次同样是从"1000 次/天"请求限额改成 $0.10 credits（r/huggingface 2025-02-07 帖标题即 "reduced the Inference API limit from 1000 calls daily to $0.10"），两年内口径变了两次；③402 报错长期高发：t/144968（2025-03）、t/148414、t/144157（同用量下第 4 天突然 402）、t/152624（有 credits 仍 402）、t/161774（PRO token 仍 402）、t/171827（"supposedly there isnt a limit" 却撞上限）、t/178488（credits 状态自相矛盾）、t/190399（2026-10-12 零用量却显示无余额）；④官方对 Anonymous/Free 的 Hub 限额明写 "subject to change over time depending on platform health"，等于保留随时收紧的权利。无封号实证，但额度被单方面收回/口径静默变更的实例确凿。做插件必须把 402/429 都当作常态路径处理，不能假设余额稳定。

**逐模型限制**：

| 模型 | 限制 | 上下文 | 备注 |
| --- | --- | --- | --- |
| （未公开逐模型数值） | 官方无任何逐模型 RPM/TPD/并发数字，且 docs/inference-providers 全目录没有 rate-limits 页（只有 index/pricing/hub-api/hub-integration/register-as-a-provider/security/tasks/guides/providers），pricing.md、index.md、register-as-a-provider.md 对 rate limit\|429\|quota\|throttl\|concurren\|requests per 全部零命中。已掌握规律：①额度不是按模型分档，而是按 provider 各模型单价扣 credits，所以"能用多少"取决于模型单价——同为 $0.10 折算差异达 45 倍（Llama 3.1 8B @$0.05/1M out ≈ 2,000,000 tokens；gpt-oss-120b @$0.14/1M ≈ 700,000；Kimi K2.5 @$2.25/1M ≈ 44,000）；②真正的速率/并发限制由被路由的下游 provider（Together/Fireworks/Novita/Groq/HF-Inference 等）执行且不公开，按 provider 与模态分档：视频生成最低、embedding 最高，大模型低于小模型，只有定性描述无数字；③同一模型可用 :cheapest / :fastest / :preferred / :<provider> 切换 provider 来换速率与单价；④hf-inference 自 2025-07 起主要跑 CPU（embedding/分类/排序），无 Chat 模型。 | — | — |

**坑（必须读）**：1) 取证路径不在 huggingface.co 页面本身：本机 TCP 到 huggingface.co:443 与 discuss.huggingface.co 全部超时（curl (28)），raw.githubusercontent.com 亦被 reset；因此现行口径取自官方文档仓库 huggingface/hub-docs 的 git 提交 diff 与 main 分支 pricing.md 原文（api.github.com + Accept: application/vnd.github.raw 直取），这是官方一手源但非渲染页，页面文案若额外加注不会体现在 md 里。2) 变更日期 2026-10-07T12:31:20Z 是 PR #2865 的合并时间，它标注的是"文档改动日"，产品侧生效时间可能早/晚几小时，官方未另行公告。3) 官方三个文件（pricing/index/register-as-a-provider）对推理限流零命中，不等于"没有限流"——只等于"没有公开限流"；实际速率由下游 provider 执行且随时可调，"限流路由插件"不能依赖任何 HF 侧 RPM/TPM 数字，只能靠 402（余额）与 429（速率）加 RateLimit 响应头自适应。4) Hub 的 5 分钟窗口限额表官方标注为 "in September '25"，且 Free/Anonymous 行带 * 说明可随平台健康度调整；router 推理请求是否计入该桶官方未说明，不要假设。5) 地区和支付：官方明写不支持印度发行的信用卡（RBI 合规未完成）；cloud marketplace 计费仅限组织，个人免费账户只能绑卡。6) PRO $2.00/月不是"免费额度"，需 $9/月订阅，且是通用 compute credits（可与 Endpoints/Spaces/Jobs 争用），不等于全是推理额度。7) perModel 无任何官方数字，第三方给的 RPM/并发全为定性描述；网上流传的 "30 req/min free"（theneuralbase）与 credits 制矛盾且官方零命中，判为不可信，勿采用。8) $0.10 折算 token 数用的是 2026-09 的价格快照，单价随时变，仅作量级参考。9) 2025-02 前"1000 次/天"只有社区与 Reddit 口径，HF 从未明文公布，属推断而非官方事实。

**置信度**：`high`　**核实日**：2026-10-22

<details><summary>来源</summary>

- https://github.com/huggingface/hub-docs/commit/c708a9e9fd2ba53fefc8fad13ff1a9780a838c42
- https://github.com/huggingface/hub-docs/blob/main/docs/inference-providers/pricing.md
- https://huggingface.co/docs/inference-providers/pricing
- https://huggingface.co/docs/inference-providers/index
- https://huggingface.co/docs/hub/rate-limits
- https://huggingface.co/docs/hub/billing
- https://discuss.huggingface.co/t/did-huggingface-remove-the-credits-given-to-free-users/189971
- https://discuss.huggingface.co/t/do-you-think-removing-the-0-10-monthly-free-inference-credits-is-the-right-decision/190220
- https://discuss.huggingface.co/t/hugging-face-payment-error-402-you-ve-exceeded-monthly-quota/144968
- https://discuss.huggingface.co/t/inference-providers-shows-no-remaining-credits-despite-zero-usage/190399
- https://klymentiev.com/blog/huggingface-inference-api
- https://www.reddit.com/r/huggingface/comments/1ijr6og/hugging_face_reduced_the_inference_api_limit_from/
- https://freellmcredits.com/offers/hugging-face-inference-free-tier
- https://agentdeals.dev/vendor/hugging-face

</details>

---

## 待补清单（下次继续）

以下 7 家子智能体已派出但**产出未回收**（结果超出工具输出上限被截断，需重跑）：

| # | 供应商 | 状态 | 备注 |
| --- | --- | --- | --- |
| 12 | 阿里云百炼 DashScope (Qwen) | ⬜ 待补 | 重点：每模型新用户 100 万 token 规则与有效期、`dashscope.aliyuncs.com/compatible-mode/v1` |
| 13 | 火山方舟 (豆包 Doubao) | ⬜ 待补 | 重点：每模型 50 万 token 赠送、`ark.cn-beijing.volces.com/api/v3`、实名要求 |
| 14 | 硅基流动 SiliconFlow | ⬜ 待补 | 重点：模型广场标 `free` 的模型、免费模型 RPM/并发、是否实名 |
| 15 | ModelScope 魔搭 API-Inference | ⬜ 待补 | 重点：每日免费调用次数、`api-inference.modelscope.cn/v1`、是否必须绑阿里云 |
| 16 | Cohere | ⬜ 待补 | 重点：trial key 每月上限是否永久、command 系限制 |
| 17 | Together AI | ⬜ 待补 | 重点：是否有真免费模型、按模型 RPM |
| 18 | Nebius AI Studio | ⬜ 待补 | 重点：新用户赠额、免费模型、`api.studio.nebius.ai/v1` |

另外还有两家**已知存在但未纳入本次名单**，可作为下一轮候选：Chutes、MiniMax 开放平台。

> 重跑办法：分批派子智能体（**并发上限 8**，实测一次派 18 个会直接报 `subagent limit reached (active child limit: 8)`），每批 6 个，并把结果**直接落文件**而不是塞进工具返回值，避免再次被 50KB 输出上限截断。
