# Source Layout

The baseline source entries are:

- `src/index.ts`: Loader-facing plugin namespace and public exports;
- `src/config.ts`: serializable schema, resolved defaults, and configuration types;
- `src/runtime.ts`: fakeable host boundary and Cordis activation;
- `src/server.ts`: the inbound HTTP listener (own node:http server, works in every profile);
- `src/sign.ts`: HMAC-SHA256 and bearer verification against the credentials seam (pure, zero-dependency);
- `src/template.ts`: `{{payload.path}}` / `{{header.name}}` prompt expansion with bounded excerpts;
- `src/engine.ts`: verification, deduplication, delivery, receipts, and replay (the `ctx.webhook` service view);
- `src/store.ts`: the durable JSON store for hooks and deliveries (the source of truth);
- `src/coldwake.ts`: cold-session resume behind the `coldWake` config;
- `src/lock.ts`: the single-instance listener lock for shared Harness homes;
- `src/tracking.ts`: turn-outcome tracking that writes receipts back onto deliveries;
- `src/callbacks.ts`: outbound callback fan-out (HTTP POST with optional bearer, macOS notification) and the `ctx.callbacks` service for other plugins;
- `src/tools.ts`: the `webhook_add` / `webhook_list` / `webhook_remove` / `webhook_deliveries` / `webhook_replay` / `webhook_pause` / `webhook_resume` / `webhook_callbacks` model tools;
- `src/command.ts`: the `/webhook` human command.

Keep the baseline files focused. Extend `src/config.ts` rather than hiding deployment choices in implementation constants; extend `src/runtime.ts` with fakeable process, clock, transport, or UI boundaries.