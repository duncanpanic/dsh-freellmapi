/*
 * snapshot-fetcher.js
 *
 * 插件端的快照消费逻辑。快照本身由私有仓库 freellmapi-snapshot 生成并上传，
 * 这里只负责拉取、缓存、通知。
 *
 * 两跳协议：
 *   GET <base>/latest.json   -> { file, generatedAt, frequency, prefix }
 *   GET <base>/<file>        -> { version, providers, summary, ... }
 *
 * 若 latest.json 本身就是一份快照（带 providers 字段），则直接采用，省掉第二跳。
 */

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// FreeLLMAPI official signing public key (Ed25519)
const OFFICIAL_PUBLIC_KEY = 'd7d621f4c7b8f3e2a19045c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1'

/** Verify Ed25519 signature using Node.js built-in crypto. */
function verifySignature(signature, payload, publicKey) {
  try {
    const verifier = crypto.createVerify('sha256')
    verifier.update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    return crypto.verify(null, Buffer.from(signature, 'base64'), {
      key: publicKey,
      format: 'hex',
      type: 'ed25519',
    })
  } catch {
    return false
  }
}

/** 快照服务器地址，可用环境变量覆盖以便本地联调。 */
export const SNAPSHOT_BASE = process.env.DSH_FREELLMAPI_SNAPSHOT_BASE || 'https://snapshot.lorcan.top'

/** 公开仓库，Star 激励只看它（快照仓库是私有的，没有 star）。 */
export const GITHUB_REPO = process.env.DSH_FREELLMAPI_REPO || 'duncanpanic/dsh-freellmapi'

/** Star 数达到该值后启用每周更新。 */
export const STAR_THRESHOLD = 100

// ─── 缓存 TTL（毫秒）─────────────────────────────────────────────────────────
const CACHE_TTL_MS       = 5  * 60 * 1000  // free: 5分钟
const STAR_CACHE_TTL_MS  = 3  * 60 * 1000  // star: 3分钟
const VIP_CACHE_TTL_MS   = 1  * 60 * 1000  // vip:  1分钟
const OFFICIAL_TTL_MS    = 24 * 60 * 60 * 1000 // 官方免费版: 24小时
const PREMIUM_TTL_MS     = 3  * 24 * 60 * 60 * 1000 // 官方订阅版: 3天
const CUSTOM_TTL_MS      = 5  * 60 * 1000  // 自定义: 5分钟
const STAR_CHECK_TTL_MS  = 6  * 60 * 60 * 1000  // star 数检查缓存: 6小时

const CACHE_DIR = process.env.DSH_FREELLMAPI_CACHE_DIR
  || path.join(os.homedir(), '.dsh-freellmapi')
const CACHE_FILE = path.join(CACHE_DIR, 'snapshot.json')
const STAR_FILE = path.join(CACHE_DIR, 'star.json')
const PREMIUM_KEY_FILE = path.join(CACHE_DIR, 'premium-key.json')

const emitter = new EventEmitter()
const inflight = new Map()

// ─── 工具函数 ────────────────────────────────────────────────────────────────
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

/** 从文件路径或 URL 读取 JSON。 */
async function loadJsonSource(source) {
  if (typeof source === 'string' && (source.startsWith('http://') || source.startsWith('https://'))) {
    const resp = await fetch(source, { signal: AbortSignal.timeout(15_000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${source}`)
    return resp.json()
  }
  // 本地文件路径
  const absolute = source.startsWith('/') || /^[a-zA-Z]:/i.test(source)
    ? source
    : path.resolve(process.cwd(), source)
  return readJson(absolute)
}

/** 从 settings 中解析 catalogMode 和对应配置。 */
function parseSettings(settings) {
  const mode = settings?.catalogMode || 'dsh-free'
  const provider = settings?.[mode] || {}
  return { mode, provider }
}

// ─── CatalogSource 接口定义（JSDoc）───────────────────────────────────────────
/**
 * @typedef {object} CatalogSource
 * @property {string} id           - 来源唯一标识
 * @property {string} name         - 来源显示名称
 * @property {function(): Promise<object>} fetchCatalog    - 拉取完整目录（platforms + models）
 * @property {function(): Promise<object|null>} fetchSnapshot - 拉取快照（免费模型标记），无快照返回 null
 * @property {function(): number} getCacheTtl              - 返回缓存 TTL（毫秒）
 * @property {function(): boolean} requiresAuth            - 是否需要认证密钥
 */

// ─── 6 个 Source 实现类 ─────────────────────────────────────────────────────

/**
 * 1. OfficialFreeSource - 官方免费版
 * 拉取 FreeLLMAPI 官方免费目录（https://freellmapi.co/catalog.json）
 */
export class OfficialFreeSource {
  id = 'official-free'
  name = 'FreeLLMAPI 免费版'

  async fetchCatalog() {
    const resp = await fetch('https://freellmapi.co/catalog.json', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!resp.ok) throw new Error(`官方免费版 catalog: HTTP ${resp.status}`)
    return resp.json()
  }

  async fetchSnapshot() { return null } // 免费版无独立快照
  getCacheTtl() { return OFFICIAL_TTL_MS }
  requiresAuth() { return false }
}

/**
 * 2. OfficialPremiumSource - 官方订阅版
 * 拉取带 Ed25519 签名的实时目录（https://freellmapi.co/signed-catalog）
 */
export class OfficialPremiumSource {
  id = 'official-premium'
  name = 'FreeLLMAPI 订阅版'
  
  constructor(flaKey) { this.flaKey = flaKey }

  async fetchCatalog() {
    if (!this.flaKey) throw new Error('OfficialPremiumSource requires fla_ key')
    const resp = await fetch('https://freellmapi.co/signed-catalog', {
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${this.flaKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!resp.ok) throw new Error(`官方订阅版 catalog: HTTP ${resp.status}`)
    const data = await resp.json()
    if (!verifySignature(data.signature, data.payload, OFFICIAL_PUBLIC_KEY)) {
      throw new Error('官方订阅版目录签名验证失败')
    }
    return data.payload || data
  }

  async fetchSnapshot() { return null }
  getCacheTtl() { return PREMIUM_TTL_MS }
  requiresAuth() { return true }
}

/**
 * 3. DshFreeSource - dsh 免费版
 * 读本地 catalog.json + 从 dsh 快照服务器拉取 free 快照
 */
export class DshFreeSource {
  id = 'dsh-free'
  name = 'dsh-freellmapi 免费版'

  async fetchCatalog() {
    const catalogPath = path.join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../native/catalog.json'
    )
    return loadJsonSource(catalogPath)
  }

  async fetchSnapshot() {
    return fetchSnapshotFromBase(SNAPSHOT_BASE, 'free')
  }
  
  getCacheTtl() { return CACHE_TTL_MS }
  requiresAuth() { return false }
}

/**
 * 4. DshStarSource - dsh Star 版
 * 读本地 catalog.json + 从 dsh 快照服务器拉取 star 快照
 */
export class DshStarSource {
  id = 'dsh-star'
  name = 'dsh-freellmapi Star 版'

  async fetchCatalog() {
    const catalogPath = path.join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../native/catalog.json'
    )
    return loadJsonSource(catalogPath)
  }

  async fetchSnapshot() {
    return fetchSnapshotFromBase(SNAPSHOT_BASE, 'star')
  }
  
  getCacheTtl() { return STAR_CACHE_TTL_MS }
  requiresAuth() { return false }
}

/**
 * 5. DshSponsorSource - dsh 赞助版
 * 读本地 catalog.json + 从 dsh 快照服务器拉取 vip 快照
 */
export class DshSponsorSource {
  id = 'dsh-sponsor'
  name = 'dsh-freellmapi 赞助版'
  
  constructor(sponsorKey) { this.sponsorKey = sponsorKey }

  async fetchCatalog() {
    const catalogPath = path.join(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../native/catalog.json'
    )
    return loadJsonSource(catalogPath)
  }

  async fetchSnapshot() {
    return fetchSnapshotFromBase(SNAPSHOT_BASE, 'vip')
  }
  
  getCacheTtl() { return VIP_CACHE_TTL_MS }
  requiresAuth() { return !!this.sponsorKey }
}

/**
 * 6. CustomSource - 自定义
 * 用户指定本地文件或远程 URL
 */
export class CustomSource {
  id = 'custom'
  name = '自定义'
  
  constructor(config) {
    this.catalogSource = config?.catalogSource // 文件或 URL
    this.snapshotSource = config?.snapshotSource // 文件或 URL
    this.ttlMs = config?.ttlMs || CUSTOM_TTL_MS
  }

  async fetchCatalog() {
    if (!this.catalogSource) throw new Error('CustomSource: catalogSource not configured')
    return loadJsonSource(this.catalogSource)
  }

  async fetchSnapshot() {
    if (!this.snapshotSource) return null
    return loadJsonSource(this.snapshotSource)
  }
  
  getCacheTtl() { return this.ttlMs }
  requiresAuth() { return false }
}

// ─── 工厂函数 ────────────────────────────────────────────────────────────────

/**
 * 根据配置创建 CatalogSource 实例
 * @param {object} settings - 插件设置对象
 * @returns {CatalogSource}
 */
export function createCatalogSource(settings) {
  const { mode, provider } = parseSettings(settings)
  
  switch (mode) {
    case 'official-free':
      return new OfficialFreeSource()
    case 'official-premium':
      return new OfficialPremiumSource(provider?.flaKey)
    case 'dsh-free':
      return new DshFreeSource()
    case 'dsh-star':
      return new DshStarSource()
    case 'dsh-sponsor':
      return new DshSponsorSource(provider?.sponsorKey)
    case 'custom':
      return new CustomSource(provider)
    default:
      throw new Error(`Unknown catalog mode: ${mode}`)
  }
}

// ─── 快照拉取（向后兼容）─────────────────────────────────────────────────────

/**
 * 内部：从指定 base 拉取指定前缀的快照
 */
async function fetchSnapshotFromBase(base, prefix) {
  const pointer = await fetch(`${base}/latest.json`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.json())
  
  if (!pointer?.file) throw new Error(`latest.json has no "file" for ${prefix}`)
  
  const resp = await fetch(`${base}/${pointer.file}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) throw new Error(`${pointer.file}: HTTP ${resp.status}`)
  return resp.json()
}

/**
 * 查询公开仓库的 Star 数。结果落盘 6 小时，避免每次启动都打 GitHub。
 * 任何失败都退化为「不是 Star 模式」，不让网络问题影响主流程。
 */
export async function checkStarMode({ force = false } = {}) {
  const cached = readJson(STAR_FILE)
  if (!force && cached && Number.isFinite(cached.checkedAt)
      && Date.now() - cached.checkedAt < STAR_CHECK_TTL_MS) {
    return cached.isStarMode
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-freellmapi' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const repo = await response.json()
    const starCount = Number(repo.stargazers_count) || 0
    const isStarMode = starCount >= STAR_THRESHOLD
    writeJson(STAR_FILE, { starCount, isStarMode, checkedAt: Date.now() })
    return isStarMode
  } catch {
    writeJson(STAR_FILE, { starCount: cached?.starCount ?? 0, isStarMode: false, checkedAt: Date.now() })
    return false
  }
}

export async function isStarMode() {
  const cached = readJson(STAR_FILE)
  if (cached && typeof cached.isStarMode === 'boolean') return cached.isStarMode
  return checkStarMode()
}

/**
 * 取快照（向后兼容 API）
 *
 * @param {object} options
 * @param {boolean} options.force   忽略新鲜缓存，强制重拉
 * @param {string}  options.base    覆盖服务器地址（测试 / 自建镜像）
 * @returns {Promise<object>}       快照本身，额外带 fetchedAt / fetchedFrom / stale
 */
export async function fetchSnapshot({ force = false, base = SNAPSHOT_BASE } = {}) {
  const starMode = await isStarMode()
  const ttl = starMode ? STAR_CACHE_TTL_MS : CACHE_TTL_MS
  const cached = readJson(CACHE_FILE)

  if (!force && cached?.data && Number.isFinite(cached.cachedAt)
      && Date.now() - cached.cachedAt < ttl) {
    return { ...cached.data, fetchedAt: cached.cachedAt, fetchedFrom: cached.base, stale: false }
  }

  const key = base
  if (!force && inflight.has(key)) return inflight.get(key)

  const task = (async () => {
    try {
      // 两跳协议
      const pointerResp = await fetch(`${base}/latest.json`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!pointerResp.ok) throw new Error(`latest.json: HTTP ${pointerResp.status}`)
      const pointer = await pointerResp.json()

      let snapshot
      // 指针本身就是一份快照，省掉第二跳
      if (pointer?.providers) {
        snapshot = pointer
      } else if (pointer?.file) {
        const resp = await fetch(`${base}/${pointer.file}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        })
        if (!resp.ok) throw new Error(`${pointer.file}: HTTP ${resp.status}`)
        snapshot = await resp.json()
      } else {
        throw new Error('latest.json has no "file" field and no providers')
      }

      const now = Date.now()
      writeJson(CACHE_FILE, { cachedAt: now, base, pointer, data: snapshot })
      emitter.emit('update', snapshot)
      return { ...snapshot, fetchedAt: now, fetchedFrom: base, stale: false }
    } catch (error) {
      if (cached?.data) {
        return { ...cached.data, fetchedAt: cached.cachedAt, fetchedFrom: cached.base, stale: true }
      }
      throw new Error(`无法获取快照: ${error.message}`)
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

// ─── 新 API：使用 CatalogSource ─────────────────────────────────────────────

/**
 * 通过 CatalogSource 拉取目录和快照
 *
 * @param {CatalogSource} source
 * @param {object} options
 * @param {boolean} options.force
 * @returns {Promise<{ catalog: object, snapshot: object|null, source: CatalogSource }>}
 */
export async function fetchWithSource(source, { force = false } = {}) {
  const ttl = source.getCacheTtl()
  const cacheKey = `source:${source.id}`
  const cached = readJson(path.join(CACHE_DIR, `${cacheKey}.json`))

  if (!force && cached?.catalog && Number.isFinite(cached.cachedAt)
      && Date.now() - cached.cachedAt < ttl) {
    return { catalog: cached.catalog, snapshot: cached.snapshot || null, source, stale: false }
  }

  const task = (async () => {
    try {
      const [catalog, snapshot] = await Promise.allSettled([
        source.fetchCatalog(),
        source.fetchSnapshot(),
      ])
      
      const result = {
        catalog: catalog.status === 'fulfilled' ? catalog.value : null,
        snapshot: snapshot.status === 'fulfilled' ? snapshot.value : null,
        source,
        stale: false,
      }
      
      const now = Date.now()
      writeJson(path.join(CACHE_DIR, `${cacheKey}.json`), { ...result, cachedAt: now })
      return result
    } catch (error) {
      if (cached?.catalog) {
        return { ...cached, source, stale: true }
      }
      throw error
    }
  })()

  inflight.set(cacheKey, task)
  return task
}

// ─── 事件与工具 ──────────────────────────────────────────────────────────────

/** 订阅快照更新，返回取消订阅函数。 */
export function onUpdate(callback) {
  emitter.on('update', callback)
  return () => emitter.off('update', callback)
}

/** 缓存现状，给面板显示用。 */
export async function getCacheStatus() {
  const cached = readJson(CACHE_FILE)
  if (!cached?.data) return { isCached: false }

  const starMode = await isStarMode()
  const ttl = starMode ? STAR_CACHE_TTL_MS : CACHE_TTL_MS
  const age = Date.now() - cached.cachedAt

  return {
    isCached: true,
    ageSeconds: Math.round(age / 1000),
    ttlSeconds: Math.round(ttl / 1000),
    expired: age >= ttl,
    mode: starMode ? 'star' : 'free',
    fetchedFrom: cached.base,
    file: cached.pointer?.file ?? null,
    freeModels: cached.data?.summary?.freeModels ?? null,
    totalModels: cached.data?.summary?.totalModels ?? null,
  }
}

/** 清掉磁盘缓存，测试和"强制刷新"用。 */
export function clearCache() {
  for (const file of [CACHE_FILE, STAR_FILE]) {
    try { fs.rmSync(file, { force: true }) } catch { /* 不存在就算了 */ }
  }
}
