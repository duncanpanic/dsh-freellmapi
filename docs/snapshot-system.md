# Snapshot 系统

插件**不自己生成**快照，而是从 `snapshot.lorcan.top` 拉取。快照的生成与发布在
**独立的私有仓库** `freellmapi-snapshot` 里完成。

## 职责划分

| 仓库 | 可见性 | 职责 |
|------|--------|------|
| `dsh-freellmapi` | 公开 | 插件本体 + 快照**消费端**（`src/snapshot/snapshot-fetcher.js`） |
| `freellmapi-snapshot` | 私有 | 快照**生产端**（`generate-snapshot.mjs` + Actions 定时任务） |

生成脚本放在公开仓库里会连“我们怎么筛免费模型”一起开源出去，所以它只在私有仓库中。

## 插件端目录

```
dsh-freellmapi/src/snapshot/
├── providers.json          # 供应商元数据（不含生成逻辑）
└── snapshot-fetcher.js     # 拉取 / 缓存 / 订阅（插件运行时用这个）
```

内置的离线模型目录在 `src/native/catalog.json`（368 行模型记录、297 个模型 ID，其中
342 条路由落在 32 个可拨号的平台上），属于 native 路由的名单，和快照的格式不同，不要混用。

私有仓库 `freellmapi-snapshot/`：

```
freellmapi-snapshot/
├── generate-snapshot.mjs   # 快照生成脚本
└── snapshots/              # 生成结果（snapshot-*.json + latest.json）
```

## 运行流程

1. 私有仓库定时运行 `generate-snapshot.mjs`（免费模式每月，Star 模式每周，订阅每日）
2. 脚本向 NVIDIA / OpenRouter 拉取模型列表并筛选免费模型
3. 生成 `snapshot-<prefix>-<date>.json`，上传到 `snapshot.lorcan.top`
4. 同时刷新 `latest.json` 指针
5. 插件启动后调用 `fetchSnapshot()`，先读 `latest.json`，再按指针取具体版本
6. 结果进程内缓存：免费 5 分钟，Star 模式 3 分钟，订阅 1 分钟

## 接口约定

```
GET https://snapshot.lorcan.top/latest.json          # 指针 { file, generatedAt, frequency, prefix }
GET https://snapshot.lorcan.top/<file>               # 具体版本快照
```

## 供应商与免费口径

列表接口都是公开的，**生成快照不需要任何 API Key**。但“免费”的来源不同，不能共用一个规则：

| 供应商 | 列表接口 | 免费口径 | 调用时认证 |
|--------|---------|---------|-----------|
| NVIDIA NIM | `integrate.api.nvidia.com/v1/models` | 全部（credits 制） | 需 key |
| OpenRouter | `openrouter.ai/api/v1/models` | 零价（`pricing.prompt` 与 `pricing.completion` 均为 0） | 需 key |

NVIDIA 的列表只返回 `id`／`object`／`created`／`owned_by`，**没有价格字段**，所以不能按价格筛；它走注册赠送 credits 的模式，额度内全部模型可用，整份列表都算免费。

Sensetime `api.sensenova.cn/v1/models` 返回 404，已从供应商列表移除。

## 更新频率与激励机制

### 免费模式（默认）
- 更新频率：每月一次
- 触发方式：手动运行 GitHub Actions
- 缓存 TTL：5 分钟

### Star 激励模式
- 更新频率：每周一次
- 触发条件：GitHub Star 数 ≥ 100
- 缓存 TTL：3 分钟

### 订阅模式（未来）
- 更新频率：每日自动
- 触发条件：付费订阅
- 缓存 TTL：1 分钟

## 插件端用法

```javascript
import { fetchSnapshot, onUpdate, isStarMode } from './snapshot-fetcher.js'

const snapshot = await fetchSnapshot()
console.log(snapshot.summary.totalModels)

if (isStarMode()) {
  console.log('当前处于 Star 激励模式')
}
```

## 待办事项

- [ ] 实现上传到 snapshot.lorcan.top 的逻辑
- [ ] 实现付费订阅验证 API
- [ ] 添加订阅态持久化
- [ ] 完善 UI 提示
