# fetch-fc27

每日自动抓取 [fut.gg](https://www.fut.gg) 的 **FC27** 球员数据，写入 WeChat 云开发数据库，供 EA FC 微信小程序（FC26/FC27 双版本查询）使用。

## 背景 / 为什么这么绕

fut.gg 在 **Cloudflare Managed Challenge** 之后。它校验客户端 **TLS 指纹（JA3）**：

- `node` / `curl` / 任何非浏览器客户端的 TLS 指纹与 Chrome 不同 → 一律 `403 challenge`，无论怎么带 `cf_clearance` cookie、怎么对齐 UA 都没用。
- **只有真实 Chrome 引擎（正确 TLS）能过。** 所以抓取必须由真实浏览器完成。

本仓库的做法：用 **Playwright 的真实 Chromium** 在 fut.gg 页面内同源 `fetch` 抓数据 → 落盘原始 JSON → 离线成型 → 写云数据库 → 提交 git 版本历史。

## 增量机制（为什么不用每天全量）

FC27 全量约 **10000 张卡**，逐条抓详情约需 15-20 分钟。但实测发现：

> fut.gg **列表接口**的每一条已经包含约 30 个字段（overall / 六维 faceStats / 化学角色 / playstyles / 联赛·俱乐部·国家·稀有度 / 图片路径 / `createdAt`）。
> **详情接口唯一不可替代的产出只有 34 项 `attributes`**，而 attributes 一变必然反映到 `faceStats` 上。

因此可以把「列表项」当作**内容签名**（`scripts/sig.js`）：

| 模式 | 做法 | 耗时 |
|---|---|---|
| `full` | 抓全量列表 + **每一条**的详情 | 约 15-20 分钟 |
| `incremental` | 抓全量列表（便宜）+ 只对**新增/签名变化**的卡抓详情 | 约 3-5 分钟 |

排期：**每周日北京时间跑一次 `full` 兜底，其余每天 `incremental`**。

签名对比同时还能识别出**已下架的卡**（上次快照有、本次列表没有），一并从数据库删除。

## 目录结构

```
scripts/
  sig.js             # 内容签名 + 差异归类（fetch_ci 与 fetch_futgg 共用，保证算法唯一）
  fetch_ci.js        # Playwright 真实 Chromium 过 Cloudflare，抓列表+差异详情，写 fc27_dump.json
  fetch_futgg.js     # 离线成型：写 snapshot / changes / facets（+ full 模式写全量数据）
  upload_db.js       # 落云开发数据库：full=清空重建，incremental=按 _id 覆盖写 + 删下架
  upload_cloud.js    # 【已废弃】旧版云存储 JSON 方案，保留仅供参考
test/
  sig.test.js        # 签名与差异归类单测（npm test）
.github/workflows/   # 每日北京时间 03:00 定时流水线
cloud-data/fc27/
  snapshot.json      # eaId → 签名，下次增量对比的基线（每日提交 git）
  changes.json       # 本次变更摘要（每日提交 git）
  facets.json        # 筛选取值（每日提交 git）
  players.json       # 全量列表数据（仅 full 模式产出，每周提交 git）
  details.json       # 全量详情数据（仅 full 模式产出，每周提交 git）
  incremental.json   # 增量落库包（gitignore，每次运行重新生成）
```

## 自动化（GitHub Actions）

`cron: '0 19 * * *'`（19:00 UTC = 北京时间 03:00）每日触发。手动触发可指定 `mode`：

| 步骤 | 说明 |
|---|---|
| 1 | 判定模式：北京时间周日 → `full`，其余 → `incremental` |
| 2 | 安装依赖 + `npm test` + Playwright Chromium |
| 3 | `node scripts/fetch_ci.js` —— 真实浏览器抓数据 |
| 4 | `node scripts/fetch_futgg.js --from-dump fc27_dump.json --ver 27 --no-local` —— 离线成型 |
| 5 | `node scripts/upload_db.js --ver 27` —— 写云数据库 |
| 6 | `git commit & push` —— 提交快照与摘要 |

> ⚠️ **顺序有讲究**：git 提交必须在落库成功**之后**。快照是增量对比的基线，只有在数据确实写进数据库后才能推进；否则一旦落库失败，下次增量会误判「无变化」而永久漏数据。

### 需要配置的 GitHub Secrets

| Secret | 说明 |
|---|---|
| `TCB_ENV_ID` | WeChat 云开发环境 ID |
| `TCB_SECRET_ID` | 云开发永久密钥 SecretId（建议用 CAM 子用户，仅授 COS/云存储数据读写） |
| `TCB_SECRET_KEY` | 云开发永久密钥 SecretKey |

在仓库 **Settings → Secrets and variables → Actions** 中添加。

### 数据库集合

| 集合 | 内容 | `_id` |
|---|---|---|
| `players_fc27` | 列表字段（供搜索/排序/分页） | eaId |
| `details_fc27` | 完整详情（供主键直查） | eaId |
| `meta_fc27` | 筛选取值（单文档） | `facets` |

## 本地手动跑（调试 / 兜底）

```bash
npm install
npx playwright install chromium

npm test                                          # 单测
node scripts/fetch_ci.js --mode=incremental       # 或 --mode=full
node scripts/fetch_futgg.js --from-dump fc27_dump.json --ver 27 --no-local
node scripts/upload_db.js --ver 27                # 需先设置 TCB_ENV_ID/SECRET_ID/SECRET_KEY
```

## 已知风险

- **Cloudflare 可能对 CI 出口 IP 弹交互验证**（而非自动解除的 Managed Challenge）。若出现，CI 会在抓取步骤失败并通知。兜底：本机跑同样的 `fetch_ci.js`（真实 Chrome 必过）。
- **`count` 可能被接口截断**：fut.gg 列表接口疑似有 10000 条的分页上限（ES `max_result_window`）。日志会打印接口根级元信息（`count` 等）与 `changes.json` 的 `apiCount`，据此可判断是否需要按评分区间分片抓取。
- **签名漏更的极小概率**：若某卡的 attributes 变化但 sig 覆盖的全部列表字段都没变，会被漏掉。每周的 `full` 兜底即为覆盖此风险。
- **重名卡**：`_id` 用 eaId，同名不同版本的卡是不同 eaId，天然共存。
