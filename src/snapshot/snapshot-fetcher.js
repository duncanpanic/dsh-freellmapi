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

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 快照服务器地址，可用环境变量覆盖以便本地联调。 */
export const SNAPSHOT_BASE = process.env.DSH_FREELLMAPI_SNAPSHOT_BASE || 'https://snapshot.lorcan.top'

/** 公开仓库，Star 激励只看它（快照仓库是私有的，没有 star）。 */
export const GITHUB_REPO = process.env.DSH_FREELLMAPI_REPO || 'duncanpanic/dsh-freellmapi'

/** Star 数达到该值后启用每周更新。 */
export const STAR_THRESHOLD = 100

const CACHE_TTL_MS = 5 * 60 * 1000
const STAR_CACHE_TTL_MS = 3 * 60 * 1000
const VIP_CACHE_TTL_MS = 1 * 60 * 1000
const STAR_CHECK_TTL_MS = 6 * 60 * 60 * 1000

const CACHE_DIR = process.env.DSH_FREELLMAPI_CACHE_DIR
  || path.join(os.homedir(), '.dsh-freellmapi')
const CACHE_FILE = path.join(CACHE_DIR, 'snapshot.json')
const STAR_FILE = path.join(CACHE_DIR, 'star.json')

const emitter = new EventEmitter()
const inflight = new Map()

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

/** 当前该用哪个 TTL：Star 模式 3 分钟，否则 5 分钟。 */
function cacheTtl(starMode) {
  return starMode ? STAR_CACHE_TTL_MS : CACHE_TTL_MS
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
    // 查不到就按免费模式走，缓存一份短命的 false 以免反复失败。
    writeJson(STAR_FILE, { starCount: cached?.starCount ?? 0, isStarMode: false, checkedAt: Date.now() })
    return false
  }
}

export async function isStarMode() {
  const cached = readJson(STAR_FILE)
  if (cached && typeof cached.isStarMode === 'boolean') return cached.isStarMode
  return checkStarMode()
}

/** 跟着 latest.json 取到真正的快照对象。 */
async function loadRemote(base) {
  const pointerResponse = await fetch(`${base}/latest.json`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!pointerResponse.ok) throw new Error(`latest.json: HTTP ${pointerResponse.status}`)
  const pointer = await pointerResponse.json()

  // 指针本身就是一份快照，省掉第二跳。
  if (pointer && pointer.providers) {
    return { snapshot: pointer, pointer: { file: null, ...pointer.summary } }
  }

  if (!pointer?.file) throw new Error('latest.json has no "file" field')

  const snapshotResponse = await fetch(`${base}/${pointer.file}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!snapshotResponse.ok) throw new Error(`${pointer.file}: HTTP ${snapshotResponse.status}`)

  return { snapshot: await snapshotResponse.json(), pointer }
}

/**
 * 取快照。
 *
 * @param {object} options
 * @param {boolean} options.force   忽略新鲜缓存，强制重拉
 * @param {string}  options.base    覆盖服务器地址（测试 / 自建镜像）
 * @returns {Promise<object>}       快照本身，额外带 fetchedAt / fetchedFrom / stale
 */
export async function fetchSnapshot({ force = false, base = SNAPSHOT_BASE } = {}) {
  const starMode = await isStarMode()
  const ttl = cacheTtl(starMode)
  const cached = readJson(CACHE_FILE)

  if (!force && cached?.data && Number.isFinite(cached.cachedAt)
      && Date.now() - cached.cachedAt < ttl) {
    return { ...cached.data, fetchedAt: cached.cachedAt, fetchedFrom: cached.base, stale: false }
  }

  // 同一个 base 并发多次只发一轮请求。
  const key = base
  if (!force && inflight.has(key)) return inflight.get(key)

  const task = (async () => {
    try {
      const { snapshot, pointer } = await loadRemote(base)
      const now = Date.now()
      writeJson(CACHE_FILE, { cachedAt: now, base, pointer, data: snapshot })
      emitter.emit('update', snapshot)
      return { ...snapshot, fetchedAt: now, fetchedFrom: base, stale: false }
    } catch (error) {
      // 网络挂了但手里有旧快照：继续用旧的，标记 stale，不让插件变成不可用。
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
  const ttl = cacheTtl(starMode)
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

/** 清掉磁盘缓存，测试和“强制刷新”用。 */
export function clearCache() {
  for (const file of [CACHE_FILE, STAR_FILE]) {
    try { fs.rmSync(file, { force: true }) } catch { /* 不存在就算了 */ }
  }
}
