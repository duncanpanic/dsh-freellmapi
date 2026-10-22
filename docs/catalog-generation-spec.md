# AI 技术文档：生成符合 FreeLLMAPI 原版目录结构的 catalog.json

## 任务概述

从 `freellmapi-snapshot` 项目的 `config/providers.json` 和实际 API 调研数据，生成一个符合 FreeLLMAPI 原版目录结构的 `catalog.json` 文件。

---

## 一、FreeLLMAPI 原版 catalog.json 结构规范

### 1.1 顶层结构

```json
{
  "source": "freellmapi catalog (models table) + provider registrations",
  "license": "MIT (tashfeenahmed/freellmapi)",
  "platforms": {
    // 平台注册表：key -> { baseURL }
  },
  "models": [
    // 模型列表：每个模型一条记录
  ]
}
```

### 1.2 platforms 字段

每个成功的供应商提供一个 entry：

```json
{
  "platforms": {
    "provider_key": {
      "baseURL": "https://api.example.com/v1"
    },
    ...
  }
}
```

**平台 key 命名规则**：
- 使用小写、短名称（如 `nvidia`、`openrouter`、`groq`）
- 对应 `config/providers.json` 中的 provider key
- 用于 models 数组中的 `platform` 字段

### 1.3 models 字段

每个模型记录包含以下字段：

```json
{
  "platform": "provider_key",
  "id": "model-id-from-api",
  "name": "Model Display Name",
  "contextWindow": 131072,
  "limits": {
    "rpm": null,
    "rpd": null,
    "tpm": null,
    "tpd": null
  },
  "monthlyBudget": "free · 40 RPM",
  "tools": true,
  "vision": false,
  "intelligence": 85,
  "speed": 6,
  "size": "Medium",
  "paidInputPerM": null,
  "paidOutputPerM": null
}
```

### 1.4 各字段说明

| 字段 | 类型 | 说明 | 数据来源 |
|------|------|------|----------|
| `platform` | string | 平台 key，对应 platforms 中的 key | config.providers.json 的 key |
| `id` | string | 模型唯一标识 | API 返回的 model.id |
| `name` | string | 显示名称 | API 返回的 model.name 或 model.id |
| `contextWindow` | number\|null | 上下文窗口大小（token） | API 返回的 context_length / context_window |
| `limits.rpm` | number\|null | 每分钟请求数限制 | 供应商文档或实测 |
| `limits.rpd` | number\|null | 每日请求数限制 | 供应商文档或实测 |
| `limits.tpm` | number\|null | 每分钟 token 数限制 | 供应商文档或实测 |
| `limits.tpd` | number\|null | 每日 token 数限制 | 供应商文档或实测 |
| `monthlyBudget` | string\|null | 月度额度描述 | config.providers.json 的 note |
| `tools` | boolean | 是否支持工具调用 | 供应商文档或推测 |
| `vision` | boolean | 是否支持视觉 | 供应商文档或推测 |
| `intelligence` | number | 智能评分（1-100） | FreeLLMAPI 的 ranking 算法，参考值 |
| `speed` | number | 速度评分（1-10） | 参考值 |
| `size` | string | 模型大小分类：Small / Medium / Large / Frontier | 参考值 |
| `paidInputPerM` | number\|null | 付费输入价格（每百万 token） | 供应商定价页面 |
| `paidOutputPerM` | number\|null | 付费输出价格（每百万 token） | 供应商定价页面 |

### 1.5 枚举值参考

**size 枚举**：
- `Small`：参数 < 8B
- `Medium`：参数 8B - 30B
- `Large`：参数 30B - 100B
- `Frontier`：参数 > 100B 或旗舰模型

**intelligence 参考范围**：
- 0-30：小型/实验性模型
- 30-60：中等模型
- 60-80：较强模型
- 80-95：旗舰模型
- 95-100：顶尖模型

**speed 参考范围**：
- 1-3：慢速
- 4-6：中等
- 7-10：快速

---

## 二、输入数据源

### 2.1 config/providers.json

路径：`D:\AI-Dev\purgeDSH\freellmapi-snapshot\config\providers.json`

包含：
- `providers` 对象：每个供应商的配置
- `key`（JSON 对象的 key）：用作 platforms 的 key 和 models 的 platform
- `baseUrl`：平台的 baseURL
- `displayName`：显示名称
- `quotaType`：配额类型（credit / rate_limit / concurrency / neurons / per_model）
- `freeBasis`：免费判定依据（credits / zero-price / all_free / trial_credit / per_model_free）
- `note`：额度描述，用于 monthlyBudget
- `auth`：认证配置（type、env、required）
- `lastStatus`：上次测试结果（success / failed / partial）

### 2.2 snapshot 文件

路径：`D:\AI-Dev\purgeDSH\freellmapi-snapshot\snapshots\snapshot-free-*.json`

包含：
- `providers.<key>.models[]`：成功供应商的模型列表
- 每个模型包含：
  - `id`：模型 ID
  - `name`：模型名称
  - `context_window`：上下文窗口
  - `isFree`：是否免费

---

## 三、生成逻辑

### 3.1 平台构建

```javascript
const platforms = {}
for (const [key, cfg] of Object.entries(providersConfig.providers)) {
  if (cfg.lastStatus === 'success' || cfg.lastStatus === 'partial') {
    platforms[key] = { baseURL: cfg.baseUrl }
  }
}
```

### 3.2 模型构建

```javascript
const models = []
for (const [key, cfg] of Object.entries(providersConfig.providers)) {
  // 找到对应的 snapshot 数据
  const snapshotData = findSnapshotData(key)
  
  if (snapshotData && snapshotData.models) {
    for (const m of snapshotData.models) {
      models.push({
        platform: key,
        id: m.id,
        name: m.name,
        contextWindow: m.context_window || m.contextLength || null,
        limits: extractLimits(cfg, m),
        monthlyBudget: cfg.note || null,
        tools: inferTools(key, m),
        vision: inferVision(key, m),
        intelligence: estimateIntelligence(m.id, m.name),
        speed: estimateSpeed(m.context_window),
        size: estimateSize(m.context_window),
        paidInputPerM: inferPrice(cfg, m, 'prompt'),
        paidOutputPerM: inferPrice(cfg, m, 'completion'),
      })
    }
  }
}
```

### 3.3 字段推断规则

#### limits（速率限制）

从 config.providers.json 的 note 字段解析，或使用供应商文档默认值：

```javascript
function extractLimits(cfg, model) {
  const note = cfg.note || ''
  const limits = { rpm: null, rpd: null, tpm: null, tpd: null }
  
  // 从 note 中提取数字
  const rpmMatch = note.match(/(\d+)\s*RPM/i)
  const rpdMatch = note.match(/(\d+)\s*RPD/i)
  const tpmMatch = note.match(/(\d+)\s*TPM/i)
  const tpdMatch = note.match(/(\d+)\s*TPD/i)
  
  if (rpmMatch) limits.rpm = parseInt(rpmMatch[1])
  if (rpdMatch) limits.rpd = parseInt(rpdMatch[1])
  if (tpmMatch) limits.tpm = parseInt(tpmMatch[1])
  if (tpdMatch) limits.tpd = parseInt(tpdMatch[1])
  
  return limits
}
```

#### tools（工具调用）

```javascript
function inferTools(providerKey, model) {
  // 已知支持工具的模型特征
  const toolsPatterns = [
    /instruct$/i,           // 大多数 instruct 模型支持工具
    /code/i,                // 编码模型通常支持
    /chat/i,                // chat 模型通常支持
  ]
  
  // 已知不支持工具的供应商/模型
  const noToolsKeys = ['groq'] // Groq 早期不支持工具
  if (noToolsKeys.includes(providerKey)) return false
  
  // 根据模型名称特征推断
  for (const pattern of toolsPatterns) {
    if (pattern.test(model.name) || pattern.test(model.id)) return true
  }
  
  return null // 未知，留空
}
```

#### vision（视觉）

```javascript
function inferVision(providerKey, model) {
  const visionPatterns = [
    /vision/i,
    /vl$/i,
    /multi.?modal/i,
  ]
  
  for (const pattern of visionPatterns) {
    if (pattern.test(model.name) || pattern.test(model.id)) return true
  }
  
  return false
}
```

#### intelligence（智能评分）

```javascript
function estimateIntelligence(modelId, modelName) {
  // 基于模型名称的启发式评分
  const rankings = {
    'gpt-4': 98,
    'gpt-4o': 97,
    'claude-3': 97,
    'llama-3': 95,
    'glm-4': 90,
    'qwen': 88,
    'mistral': 85,
    'deepseek': 92,
  }
  
  // 检查是否匹配已知高评分模型
  for (const [prefix, score] of Object.entries(rankings)) {
    if (modelId.toLowerCase().includes(prefix) || modelName.toLowerCase().includes(prefix)) {
      return score
    }
  }
  
  return 50 // 默认中等评分
}
```

#### speed（速度评分）

```javascript
function estimateSpeed(contextWindow) {
  if (!contextWindow) return 5
  if (contextWindow <= 32768) return 8
  if (contextWindow <= 131072) return 6
  return 4
}
```

#### size（模型大小分类）

```javascript
function estimateSize(contextWindow) {
  // 粗略基于上下文窗口推断
  if (!contextWindow) return 'Medium'
  if (contextWindow <= 32768) return 'Small'
  if (contextWindow <= 131072) return 'Medium'
  return 'Large'
}
```

#### paidInputPerM / paidOutputPerM（价格）

```javascript
function inferPrice(cfg, model, type) {
  // credits 制：价格未公开，返回 null
  if (cfg.freeBasis === 'credits') return null
  
  // zero-price：免费模型，返回 null
  if (cfg.freeBasis === 'zero-price' && model.isFree) return null
  
  // 从模型数据中解析价格
  const pricing = model.pricing || {}
  const price = type === 'prompt' ? pricing.prompt : pricing.completion
  
  if (price && parseFloat(price) > 0) {
    return parseFloat(price)
  }
  
  return null
}
```

---

## 四、输出格式

生成的文件保存到：`D:\AI-Dev\purgeDSH\dsh-freellmapi\src\native\catalog.json`

### 4.1 文件头部元信息

```json
{
  "source": "freellmapi-snapshot catalog (custom generated)",
  "generatedAt": "2026-10-22T22:00:00.000Z",
  "version": "1.0.0",
  "platforms": { ... },
  "models": [ ... ]
}
```

### 4.2 与原版 catalog.json 的差异

| 字段 | 原版 FreeLLMAPI | 自定义生成 |
|------|----------------|-----------|
| `source` | "freellmapi catalog (models table) + provider registrations" | "freellmapi-snapshot catalog (custom generated)" |
| `license` | "MIT (tashfeenahmed/freellmapi)" | 可保留或移除 |
| `generatedAt` | 无 | 有（当前时间） |
| `version` | 无 | 有（"1.0.0"） |

---

## 五、执行步骤

1. **读取配置**：加载 `config/providers.json`
2. **读取快照**：加载最新的 `snapshots/snapshot-free-*.json`
3. **构建 platforms**：根据 lastStatus 过滤成功的供应商
4. **构建 models**：合并 snapshot 中的模型数据和 config 中的元数据
5. **推断字段**：对缺失字段使用启发式规则填充
6. **写入文件**：保存为 JSON 到目标路径

---

## 六、注意事项

1. **不要修改原版 FreeLLMAPI 的项目**：这是独立的 catalog 生成脚本
2. **保留原始数据**：生成前先备份现有的 catalog.json
3. **日志输出**：打印每个供应商处理的模型数量和关键推断结果
4. **错误处理**：snapshot 中没有的供应商跳过，不报错
5. **isFree 标记**：如果需要在 catalog.json 中标记免费模型，可以添加可选字段 `"isFree": true`

---

## 七、示例输出（nvidia 供应商部分）

```json
{
  "platforms": {
    "nvidia": {
      "baseURL": "https://integrate.api.nvidia.com/v1"
    }
  },
  "models": [
    {
      "platform": "nvidia",
      "id": "meta/llama-3.2-11b-vision-instruct",
      "name": "Llama 3.2 11B Vision Instruct",
      "contextWindow": 131072,
      "limits": { "rpm": 40, "rpd": null, "tpm": null, "tpd": null },
      "monthlyBudget": "注册赠送 credits，额度内全部模型可用；/models 不返回价格字段，整份列表算免费",
      "tools": true,
      "vision": true,
      "intelligence": 95,
      "speed": 7,
      "size": "Medium",
      "paidInputPerM": null,
      "paidOutputPerM": null
    }
  ]
}
```

---

## 八、CatalogSource 接口设计

生成 `catalog.json` 后，需要在 `src/snapshot/snapshot-fetcher.js` 中实现 `CatalogSource` 接口，让插件支持三种目录来源模式。

### 8.1 接口定义

```javascript
/**
 * CatalogSource 接口：所有目录来源的统一抽象
 */
const CatalogSource = {
  /** 来源唯一标识 */
  id: 'string',
  
  /** 来源显示名称 */
  name: 'string',
  
  /**
   * 拉取完整目录（platforms + models）
   * @returns {Promise<{ platforms: Record<string, {baseURL: string}>, models: ModelRecord[] }>}
   */
  fetchCatalog: function() {},
  
  /**
   * 拉取快照（免费模型标记）
   * @returns {Promise<{ providers: Record<string, {models: SnapshotModel[]}> }> | null}
   */
  fetchSnapshot: function() {},
  
  /**
   * 返回缓存 TTL（毫秒）
   * @returns {number}
   */
  getCacheTtl: function() {},
  
  /**
   * 是否需要认证密钥
   * @returns {boolean}
   */
  requiresAuth: function() {},
}
```

### 8.2 实现 6 个 Source 类

#### 1. OfficialFreeSource - 官方免费版

```javascript
class OfficialFreeSource {
  id = 'official-free'
  name = 'FreeLLMAPI 免费版'
  
  async fetchCatalog() {
    // 拉取 FreeLLMAPI 官方免费目录
    const resp = await fetch('https://freellmapi.co/catalog.json', {
      signal: AbortSignal.timeout(15_000)
    })
    return resp.json()
  }
  
  async fetchSnapshot() {
    // 免费版没有独立快照，从目录中推断免费模型
    return null // 由 caller 处理
  }
  
  getCacheTtl() { return 24 * 60 * 60 * 1000 } // 24小时
  requiresAuth() { return false }
}
```

#### 2. OfficialPremiumSource - 官方订阅版

```javascript
class OfficialPremiumSource {
  id = 'official-premium'
  name = 'FreeLLMAPI 订阅版'
  
  constructor(private flaKey: string) {}
  
  async fetchCatalog() {
    const resp = await fetch('https://freellmapi.co/signed-catalog', {
      headers: { Authorization: `Bearer ${this.flaKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    const data = await resp.json()
    // 验证 Ed25519 签名
    if (!verifySignature(data.signature, data.payload, PUBLIC_KEY)) {
      throw new Error('目录签名验证失败')
    }
    return data.payload
  }
  
  async fetchSnapshot() { return null }
  
  getCacheTtl() { return 3 * 24 * 60 * 60 * 1000 } // 3天
  requiresAuth() { return true }
}
```

#### 3. DshFreeSource - dsh 免费版

```javascript
class DshFreeSource {
  id = 'dsh-free'
  name = 'dsh-freellmapi 免费版'
  
  async fetchCatalog() {
    // 读本地 catalog.json
    return loadCatalogFromFile('src/native/catalog.json')
  }
  
  async fetchSnapshot() {
    // 从 dsh 快照服务器拉取免费快照
    return fetchSnapshot({ prefix: 'free' })
  }
  
  getCacheTtl() { return 5 * 60 * 1000 } // 5分钟
  requiresAuth() { return false }
}
```

#### 4. DshStarSource - dsh Star 版

```javascript
class DshStarSource {
  id = 'dsh-star'
  name = 'dsh-freellmapi Star 版'
  
  async fetchCatalog() {
    return loadCatalogFromFile('src/native/catalog.json')
  }
  
  async fetchSnapshot() {
    return fetchSnapshot({ prefix: 'star' })
  }
  
  getCacheTtl() { return 3 * 60 * 1000 } // 3分钟
  requiresAuth() { return false }
}
```

#### 5. DshSponsorSource - dsh 赞助版

```javascript
class DshSponsorSource {
  id = 'dsh-sponsor'
  name = 'dsh-freellmapi 赞助版'
  
  constructor(private sponsorKey?: string) {}
  
  async fetchCatalog() {
    return loadCatalogFromFile('src/native/catalog.json')
  }
  
  async fetchSnapshot() {
    return fetchSnapshot({ prefix: 'vip' })
  }
  
  getCacheTtl() { return 1 * 60 * 1000 } // 1分钟
  requiresAuth() { return !!this.sponsorKey }
}
```

#### 6. CustomSource - 自定义

```javascript
class CustomSource {
  id = 'custom'
  name = '自定义'
  
  constructor(private config: CustomConfig) {}
  
  async fetchCatalog() {
    if (this.config.localCatalogPath) {
      return loadCatalogFromFile(this.config.localCatalogPath)
    }
    if (this.config.catalogUrl) {
      const resp = await fetch(this.config.catalogUrl, {
        signal: AbortSignal.timeout(15_000)
      })
      return resp.json()
    }
    throw new Error('Custom catalog not configured: missing localCatalogPath or catalogUrl')
  }
  
  async fetchSnapshot() {
    if (this.config.localSnapshotPath) {
      return loadJsonFromFile(this.config.localSnapshotPath)
    }
    if (this.config.snapshotUrl) {
      const resp = await fetch(this.config.snapshotUrl, {
        signal: AbortSignal.timeout(15_000)
      })
      return resp.json()
    }
    return null
  }
  
  getCacheTtl() { return 5 * 60 * 1000 }
  requiresAuth() { return false }
}
```

### 8.3 工厂函数

```javascript
/**
 * 根据配置创建 CatalogSource 实例
 */
export function createCatalogSource(config: Settings): CatalogSource {
  switch (config.catalogMode) {
    case 'official-free':
      return new OfficialFreeSource()
    case 'official-premium':
      return new OfficialPremiumSource(config.official?.flaKey)
    case 'dsh-free':
      return new DshFreeSource()
    case 'dsh-star':
      return new DshStarSource()
    case 'dsh-sponsor':
      return new DshSponsorSource(config.dsh?.sponsorKey)
    case 'custom':
      return new CustomSource(config.custom)
    default:
      throw new Error(`Unknown catalog mode: ${config.catalogMode}`)
  }
}
```

---

## 九、下一步：实现 CatalogSource 接口

按照以上设计，修改 `src/snapshot/snapshot-fetcher.js`：
1. 定义 `CatalogSource` 接口
2. 实现 6 个 Source 类
3. 添加工厂函数 `createCatalogSource()`
4. 在 `index.js` 中使用新的 Source 系统

---

**文档结束**
