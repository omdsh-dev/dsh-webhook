<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-webhook — verified HTTP events become durable Automation Runs">
</p>

# dsh-webhook

English | [中文](README.zh.md)

A durable inbound-webhook Trigger adapter for DSH Automation. It verifies HTTP events, persists a receipt, and submits an idempotent fresh-Session Run. It never executes an Agent turn itself.

The responsibility boundary is deliberate:

- dsh-webhook owns HTTP serving, authentication, rate limits, receipt durability, source deduplication, replay, and outbound callbacks.
- dsh-automation owns the Run queue, fresh canonical Sessions, concurrency, retries, cancellation, event history, retention, and worker recovery.
- dsh-cron is the equivalent time-driven Trigger adapter.

## Install

Install `dsh-automation` first, then this adapter:

```sh
dsh plugin --profile web add github:cofy-x/dsh-automation
dsh plugin --profile web add github:omdsh-dev/dsh-webhook
```

A Git install runs the package's self-contained `prepare` build. If pnpm asks, allow the exact package key it prints in the profile's `pnpm-workspace.yaml`, then repeat the add. Verify the composed rows with `dsh --profile web --dump-config`.

The plugin listens on `127.0.0.1:8788` by default. Only the process holding the listener lock accepts events and reconciles Automation results; other processes sharing the same Harness home remain management-only and can take over.

## Lifecycle

```text
HTTP request
  → authenticate and enforce limits
  → persist verified receipt (accepted)
  → submit Run with a stable idempotency key
  → persist Automation Run id (submitted)
  → consume durable Automation events after restart
  → project terminal outcome (settled)
  → dispatch matching callbacks
```

The receipt is committed before submission. If the process dies after Automation accepted the Run but before the receipt stored its Run id, startup resubmits the same key and receives the same Run. Unknown model or tool side effects are never retried by the adapter.

For a source event id, the key is `v1:<hook-id>:<event-id>`. When a sender provides no recognized id header, the persisted delivery id becomes the occurrence id. Manual replay deliberately creates a new receipt and a new occurrence.

## Usage

Model tools:

- `webhook_add` — register `POST /hooks/<name>` with a prompt template, auth profile, and optional absolute `cwd`.
- `webhook_list`, `webhook_remove`, `webhook_pause`, `webhook_resume` — manage hooks.
- `webhook_deliveries` — inspect receipt and linked Run projections.
- `webhook_replay` — submit a stored, previously verified payload as a new occurrence.
- `webhook_callbacks` — inspect outbound callback attempts.

Human command examples:

```text
/webhook add github-ci "Review {{payload.repository.full_name}} event {{header.x-github-event}}" auth=hmac-sha256 secret=GITHUB_WEBHOOK_SECRET
/webhook deliveries github-ci
/webhook replay dl-2
/webhook pause github-ci
/webhook resume github-ci
/webhook remove github-ci
```

Hooks created by a command or tool capture the creating Session's absolute workspace as a fresh Automation target. API or static hooks must provide `cwd` or inherit `defaultCwd`. Migrated legacy hooks without either are paused with a `migrationIssue`; set a fresh target before resuming them.

## Verification

Secrets are never stored in hook definitions. A `secretRef` is resolved through the Harness credentials service at request time.

| Auth | Verification | Typical sources |
|:---|:---|:---|
| `hmac-sha256` | HMAC-SHA256 of the raw body; configurable signature header; constant-time comparison | GitHub and compatible senders |
| `bearer` | Bearer token or configurable token header | GitLab, Grafana, CI and scripts |
| `none` | Source must be loopback | local scripts only |

Wrong signature returns `401`; disallowed source `403`; unknown hook `404`; rate exhaustion `429`; oversized body `413`. A public `0.0.0.0` bind refuses secret-less hooks at load and creation time.

Recognized source occurrence headers, in order, are `X-GitHub-Delivery`, `X-GitLab-Delivery`, and `X-Request-Id`. Repeating one within retained history records a rejected duplicate and does not create another Run.

## Receipts and reconciliation

Each receipt contains bounded headers and payload, the stable idempotency key, linked `automationRunId`, Automation state, terminal outcome, result excerpt or error, and callback status. Receipt states are:

- `accepted`: verified and persisted, but Run id is not yet known;
- `submitted`: linked Run is non-terminal;
- `settled`: linked Run is terminal (`succeeded`, `failed`, `cancelled`, or `indeterminate`);
- `rejected`: source-level duplicate or another pre-submission rejection.

The adapter owns a durable Automation consumer checkpoint named `webhook.adapter.v1`. It advances its local cursor and the central checkpoint after projecting each scanned page. If retention has pruned an old cursor, it refreshes every linked Run by id, advances to the published prune watermark, and continues. A terminal callback is emitted only on the first non-terminal-to-terminal projection.

Legacy `delivered` and `held` receipts remain readable as migration audit records; new events never use those states.

## Callbacks

Terminal receipts fan out to matching global rules and hook-local targets. HTTP targets receive JSON and may use a credential-backed bearer token. `local://macos-notification` is also supported. Failed callbacks use a persistent exponential-backoff queue (2 seconds doubling, five-minute cap) for `callbackRetries` total attempts; callback failure never changes Run settlement.

```yaml
callbacks:
  - source: webhook
    outcomes: [error]
    target: https://hooks.example.com/alert
    secretRef: ALERT_TOKEN
```

Installing dsh-cron alongside this plugin also lets cron settlement events use the same optional callback service; cron does not depend on webhook for execution.

## Configuration

| Key | Default | Meaning |
|:---|:---|:---|
| `bind` | `127.0.0.1` | listener address |
| `port` | `8788` | listener port |
| `maxPayloadBytes` | `262144` | request body limit |
| `rateLimitPerMinute` | `60` | accepted requests per hook per minute |
| `defaultCwd` | none | absolute fallback workspace for fresh Sessions |
| `reconcilePollMs` | `1000` | Automation event-feed poll interval |
| `dataDir` | `$DSH_HOME/webhook` | durable store and lock directory |
| `hooks` | `[]` | static hooks (`name`, `promptTemplate`, auth fields, `cwd`, `concurrencyLimit`, `paused`, `callbacks`) |
| `callbacks` | `[]` | global callback rules |
| `callbackRetries` | `4` | total callback attempts, including the first |

Each hook has a stable concurrency key `webhook:<hook-id>` and a configurable `concurrencyLimit` (default 1). The actual limit is enforced transactionally by dsh-automation across all workers and processes.

## Operations and compatibility

`store.json` schema v3 migrates v2 on load. Writes are atomic and coordinated by short-lived locks; cross-process records and the Automation cursor are merged without moving the cursor backward. Corrupt files are quarantined. Active receipts are never trimmed merely to meet the bounded terminal history size.

Keep the listener behind a TLS reverse proxy or Cloudflare Tunnel for public use. Prefer loopback binding even when authentication is enabled.

The adapter requires the public `dsh-automation >=0.2.0-alpha.0 <0.3.0` service contract. It does not import private dsh-automation source and does not require any deepseek-harness change.

## Development

```sh
pnpm install
pnpm run verify:self-contained
pnpm run typecheck
pnpm test
pnpm run build
pnpm run prepare
```

See [the plugin contract](docs/dsh-plugin-contracts.md) and [source layout](src/README.md).

## License

[MIT](LICENSE)
