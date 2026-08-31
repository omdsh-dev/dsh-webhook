<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-webhook —— 经验证的 HTTP 事件转成持久化 Automation Run">
</p>

# dsh-webhook

[English](README.md) | 中文

DSH Automation 的持久化入站 Webhook Trigger 适配器。它验证 HTTP 事件、先持久化回执，再幂等提交 fresh-Session Run；它自身不再执行 Agent turn。

责任边界：

- dsh-webhook 负责 HTTP 服务、认证、限流、回执、来源去重、重放与出站回调；
- dsh-automation 负责 Run 队列、fresh canonical Session、并发、取消、人工重试、事件历史、retention 与 Worker 恢复；
- dsh-cron 是对应的时间驱动 Trigger 适配器。

## 安装

先安装 dsh-automation，再安装本适配器：

```sh
dsh plugin --profile web add github:cofy-x/dsh-automation
dsh plugin --profile web add github:omdsh-dev/dsh-webhook
```

默认监听 `127.0.0.1:8788`。共享同一 Harness home 的多个进程中，只有持有 listener lock 的进程接收事件并对账 Automation 结果；其他进程保留管理面并可在主进程退出后接管。

## 持久化闭环

```text
HTTP 请求
  → 验证与限流
  → 持久化已验证回执（accepted）
  → 使用稳定幂等键提交 Run
  → 记录 Automation Run id（submitted）
  → 重启后继续消费持久化 Run 事件
  → 投影终态结果（settled）
  → 发送匹配的回调
```

回执必须早于 Run 提交落盘。如果进程在 Automation 已接受 Run、但回执尚未记下 Run id 时崩溃，启动恢复会使用同一幂等键再提交，并取回同一 Run。适配器绝不自动重试未知的模型或工具副作用。

有来源 event id 时，幂等键为 `v1:<hook-id>:<event-id>`；没有可识别 id 时，使用已持久化的 delivery id。人工 replay 会创建新回执和新 occurrence，不伪装成原事件的自动重试。

## 使用

模型工具：

- `webhook_add`：注册 `POST /hooks/<name>`，设置 prompt 模板、认证方式和可选的绝对 `cwd`；
- `webhook_list` / `webhook_remove` / `webhook_pause` / `webhook_resume`：管理 hook；
- `webhook_deliveries`：查看回执与关联 Run 投影；
- `webhook_replay`：将已验证的历史 payload 作为新 occurrence 提交；
- `webhook_callbacks`：查看回调尝试。

```text
/webhook add github-ci "Review {{payload.repository.full_name}} event {{header.x-github-event}}" auth=hmac-sha256 secret=GITHUB_WEBHOOK_SECRET
/webhook deliveries github-ci
/webhook replay dl-2
/webhook pause github-ci
/webhook resume github-ci
/webhook remove github-ci
```

命令或工具创建的 hook 会捕获创建 Session 的绝对工作目录，作为 fresh Automation target。API 或静态 hook 必须显式提供 `cwd`，或继承 `defaultCwd`。无法得到 fresh target 的旧 hook 在迁移时会自动暂停并记录 `migrationIssue`。

## 验证与去重

密钥不会写入 hook。`secretRef` 在请求时通过 Harness credentials service 解析。

| 方式 | 规则 |
|:---|:---|
| `hmac-sha256` | 对 raw body 做 HMAC-SHA256，常量时间比较，签名 header 可配置 |
| `bearer` | Bearer token 或自定义 token header |
| `none` | 只接受 loopback 来源 |

错误签名返回 `401`，来源不允许返回 `403`，未知 hook 返回 `404`，限流返回 `429`，body 超限返回 `413`。`0.0.0.0` 公开绑定会拒绝无密钥 hook。

来源 occurrence id 依次读取 `X-GitHub-Delivery`、`X-GitLab-Delivery`、`X-Request-Id`。在保留历史中重复的 id 只会产生 rejected 回执，不会新建 Run。

## 回执与对账

新回执状态：

- `accepted`：已验证并持久化，尚未确认 Run id；
- `submitted`：已关联非终态 Run；
- `settled`：Run 已到达 `succeeded` / `failed` / `cancelled` / `indeterminate`；
- `rejected`：来源级重复或提交前拒绝。

每条回执包含有界 headers/payload、幂等键、`automationRunId`、Run state、终态 outcome、结果摘要或错误与回调结果。

适配器使用持久化 consumer `webhook.adapter.v1`。每扫描一页事件后，先投影 Run，再推进本地 cursor 和中心 checkpoint。如果旧 cursor 已被 retention 裁剪，它会逐个刷新所有已关联 Run，推进到 prune watermark 后继续。终态回调只在首次从非终态过渡到终态时触发。

旧 `delivered` / `held` 回执保留为迁移审计记录，新事件不再产生这两种状态。

## 回调

只有终态回执才匹配全局规则和 hook 局部目标。HTTP 目标接收 JSON，可使用 credentials 提供 bearer token；也支持 `local://macos-notification`。失败回调进入持久化指数退避队列，回调失败不会改变 Run 结算状态。

## 配置

| 键 | 默认 | 含义 |
|:---|:---|:---|
| `bind` | `127.0.0.1` | 监听地址 |
| `port` | `8788` | 监听端口 |
| `maxPayloadBytes` | `262144` | 请求 body 上限 |
| `rateLimitPerMinute` | `60` | 每 hook 每分钟接受数 |
| `defaultCwd` | 无 | fresh Session 的绝对工作目录默认值 |
| `reconcilePollMs` | `1000` | Automation 事件流轮询间隔 |
| `dataDir` | `$DSH_HOME/webhook` | 持久化与 lock 目录 |
| `hooks` | `[]` | 静态 hook，可含 `cwd` 和 `concurrencyLimit` |
| `callbacks` | `[]` | 全局回调规则 |
| `callbackRetries` | `4` | 包含首次在内的总回调尝试数 |

每个 hook 拥有稳定并发键 `webhook:<hook-id>`，`concurrencyLimit` 默认为 1，由 dsh-automation 在所有 Worker 和进程之间事务性执行。

## 运维与兼容

`store.json` v3 会在加载时迁移 v2。写入原子化并由短期 lock 协调；跨进程合并不会让 Automation cursor 倒退；损坏文件会被隔离；活跃回执不会为了满足历史上限而被裁剪。

公网使用时应把 listener 放在 TLS 反向代理或 Cloudflare Tunnel 后，优先保持 loopback bind。

本适配器只依赖公开的 `dsh-automation >=0.2.0-alpha.0 <0.3.0` service contract，不引入 dsh-automation 私有源码，也不需要修改 deepseek-harness。

## 开发

```sh
pnpm install
pnpm run verify:self-contained
pnpm run typecheck
pnpm test
pnpm run build
pnpm run prepare
```

## 许可证

[MIT](LICENSE)
