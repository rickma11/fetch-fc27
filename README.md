# fetch-fc27

每日自动抓取 [fut.gg](https://www.fut.gg) 的 **FC27** 球员数据，供 EA FC 微信小程序（FC26/FC27 双版本查询）使用。

## 背景 / 为什么这么绕

fut.gg 在 **Cloudflare Managed Challenge** 之后。它校验客户端 **TLS 指纹（JA3）**：

- `node` / `curl` / 任何非浏览器客户端的 TLS 指纹与 Chrome 不同 → 一律 `403 challenge`，无论怎么带 `cf_clearance` cookie、怎么对齐 UA 都没用。
- **只有真实 Chrome 引擎（正确 TLS）能过。** 所以抓取必须由真实浏览器完成。

本仓库的做法：用 **Playwright 的真实 Chromium**（TLS 指纹正确）在 fut.gg 页面内同源 `fetch` 全量数据 → 落盘原始 JSON → 离线成型 → 提交 git 版本历史 + 推送 WeChat 云存储。

## 目录结构

```
scripts/
  fetch_ci.js        # Playwright 真实 Chromium 过 Cloudflare，抓全量 FC27，写 fc27_dump.json
  fetch_futgg.js     # 离线成型：把 fc27_dump.json 雕成小程序格式，写 cloud-data/fc27 + data
  upload_cloud.js    # 把成型后的 JSON 推到 WeChat 云存储 fc27/
.github/workflows/   # 每日 03:00(北京时间) 定时流水线
cloud-data/fc27/     # players.json / details.json（git 版本历史，并上传云存储）
data/                # players_fc27.js / details_fc27.js（版本化本地兜底）
```

## 自动化（GitHub Actions）

`cron: '0 19 * * *'`（19:00 UTC = 北京时间 03:00）每日触发，流程：

1. 安装依赖 + Playwright Chromium
2. `node scripts/fetch_ci.js` —— 真实浏览器过 Cloudflare 抓数据
3. `node scripts/fetch_futgg.js --from-dump fc27_dump.json --ver 27` —— 离线成型
4. `git commit & push` —— 保留每日版本历史
5. `node scripts/upload_cloud.js` —— 推送云存储（小程序端无需改动即可读到新数据）

### 需要配置的 GitHub Secrets

| Secret | 说明 |
|---|---|
| `TCB_ENV_ID` | WeChat 云开发环境 ID |
| `TCB_SECRET_ID` | 云开发永久密钥 SecretId |
| `TCB_SECRET_KEY` | 云开发永久密钥 SecretKey |

在仓库 **Settings → Secrets and variables → Actions** 中添加。

## 本地手动跑（调试 / 兜底）

```bash
npm install
npx playwright install chromium
node scripts/fetch_ci.js
node scripts/fetch_futgg.js --from-dump fc27_dump.json --ver 27
node scripts/upload_cloud.js   # 需先设置 TCB_ENV_ID/SECRET_ID/SECRET_KEY
```

## 已知风险

- **Cloudflare 可能对 CI 出口 IP 弹交互验证**（而非自动解除的 Managed Challenge）。若出现，CI 会在第 2 步失败并通知。兜底方案：本机手动跑同样的 `fetch_ci.js`（真实 Chrome 必过），或将来改用海外 VPS / 本机计划任务跑同一套脚本。
- GitHub 在美国、云开发在国内，CI 直推云存储可能偏慢；git 提交不受此影响（数据永不丢失）。
