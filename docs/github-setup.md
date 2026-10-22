# GitHub 仓库设置指南

本文档详细说明如何设置公开仓库（插件）和私有仓库（快照生成）。

## 1. 公开仓库 - dsh-freellmapi

### 创建步骤

```bash
# 1. 初始化 Git
cd dsh-freellmapi
git init
git add .
git commit -m "Initial commit: DSH FreeLLMAPI plugin"

# 2. 在 GitHub 创建新仓库
#    Name: dsh-freellmapi
#    Visibility: Public
#    Add .gitignore: Node
#    License: MIT
#    不要初始化 README

# 3. 关联并推送
git remote add origin https://github.com/duncanpanic/dsh-freellmapi.git
git branch -M main
git push -u origin main
```

### 工作流说明

**公开仓库里没有、也不需要任何与快照相关的 GitHub Actions 工作流。** 快照的生成与上传全部在私有仓库
`freellmapi-snapshot` 里完成（见 [snapshot-system.md](snapshot-system.md) 的职责划分）；
公开仓库只包含插件本体和快照**消费端**代码。

| 工作流文件（位于私有仓库） | 触发条件 | 功能 |
|-----------|---------|------|
| `update-snapshot-monthly.yml` | 每月1日 + 手动 | 免费模式快照生成 |
| `update-snapshot-weekly.yml` | 每周一 + 手动 | Star 激励模式快照生成 |
| `update-snapshot-daily.yml` | 每天 + 手动 | 订阅模式快照生成 |

**注意**: `weekly` 和 `daily` 工作流需要额外配置才能启用（见下文）。

---

## 2. 私有仓库 - freellmapi-snapshot

### 创建步骤

```bash
# 1. 在 GitHub 创建私有仓库
#    Name: freellmapi-snapshot
#    Visibility: Private
#    Add .gitignore: Node
#    License: MIT

# 2. 克隆仓库
git clone https://github.com/duncanpanic/freellmapi-snapshot.git
cd freellmapi-snapshot

# 3. 快照生成脚本只存在于本私有仓库中（公开仓库不含、也不应含生成逻辑）
#    首次建立时在这里新写 generate-snapshot.mjs
mkdir -p scripts

# 4. 创建 workflows 目录
mkdir -p .github/workflows
```

### 添加 GitHub Actions 工作流

在**私有仓库**的 `.github/workflows/` 下新建三个工作流文件（见上表）。公开仓库
`dsh-freellmapi` 里没有这些文件可供复制——生成端不随公开仓库发布。

### 配置 Secrets

在私有仓库的 **Settings → Secrets and variables → Actions** 中添加：

- `SNAPSHOT_API_KEY`: snapshot.lorcan.top 的 API Key

---

## 3. Star 激励模式设置

### 工作原理

1. 当 `dsh-freellmapi` 仓库的 Star 数达到 100 时
2. `update-snapshot-weekly.yml` 工作流会自动启用
3. 每周自动生成并上传快照

### 配置步骤

#### 在公开仓库中：

1. **启用 GitHub Actions**：
   - 进入仓库 Settings → Actions → General
   - 选择 "Allow all actions and reusable workflows"

2. **配置 Secret**（可选）：
   - Settings → Secrets and variables → Actions
   - 添加 `SNAPSHOT_API_KEY`（如果需要上传到私有服务器）

#### 在私有仓库中：

1. **启用工作流**：
   - 进入仓库 Actions 页面
   - 找到 "Update Snapshot (Weekly - Star Mode)" 工作流
   - 点击 "Enable workflow"

2. **测试工作流**：
   - 手动触发一次工作流
   - 检查日志确认 Star 数量检测正常

---

## 4. 订阅模式设置（未来）

### 工作原理

1. 用户付费订阅后获得 API Key
2. 在私有仓库中配置订阅验证逻辑
3. 每天自动生成快照

### 配置步骤

1. **实现订阅验证 API**（下面是示意，不是可直接运行的代码）：
   ```javascript
   // 在 update-snapshot-daily.yml 的验证步骤中
   const res = await fetch('https://your-api.com/verify-subscription', {
     headers: { Authorization: `Bearer ${process.env.SUBSCRIPTION_KEY}` },
   })
   ```

2. **在私有仓库中配置 Secret**：
   - `SUBSCRIPTION_KEY`: 订阅验证 API 的密钥

---

## 5. snapshot.lorcan.top 服务器配置

### 需要实现的 API

```python
# POST /api/snapshot
# 接收快照数据并保存
async def upload_snapshot(request):
    api_key = request.headers.get("Authorization")
    if api_key != SNAPSHOT_API_KEY:
        return {"error": "Unauthorized"}, 401
    
    snapshot = request.json
    filename = f"snapshot-{datetime.now().strftime('%Y-%m-%d-%H-%M')}.json"
    
    # 保存快照文件
    save_snapshot(filename, snapshot)
    
    # 更新 latest.json 指针
    update_latest(filename, snapshot)
    
    return {"success": True, "url": f"/{filename}"}

# GET /latest.json
# 返回最新快照指针
async def get_latest():
    return read_latest()
```

### 部署建议

- 使用静态文件服务器（如 Nginx、Cloudflare Pages）
- 快照文件存储在对象存储（如 S3、OSS）
- latest.json 使用 CDN 缓存

---

## 6. 完整工作流程图

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   GitHub Repo   │────▶│  GitHub Actions  │────▶│ Snapshot Server  │
│  dsh-freellmapi │     │  (每月/周/天)    │     │ lorcan.top       │
└─────────────────┘     └──────────────────┘     └──────────────────┘
       │                        │                         │
       │                        │                         │
       ▼                        ▼                         ▼
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ 插件端消费者    │◀────│  本地缓存        │◀────│  用户访问        │
│ snapshot-fetcher│     │  5分钟/3分钟     │     │  latest.json     │
└─────────────────┘     └──────────────────┘     └──────────────────┘
```

---

## 7. 常见问题

### Q: 如何手动触发快照更新？

A: 进入 GitHub Actions 页面，选择对应工作流，点击 "Run workflow"。

### Q: Star 数不够 100 会怎样？

A: `update-snapshot-weekly.yml` 会检查 Star 数，不满足条件时跳过生成，只记录日志。

### Q: 如何切换到 VIP 模式？

A: 需要在私有仓库中配置订阅验证逻辑，并将 `update-snapshot-daily.yml` 启用。

### Q: 本地如何测试？

A: 在私有仓库 `freellmapi-snapshot` 的根目录运行脚本并指定频率：
```bash
node generate-snapshot.mjs --frequency monthly
```
