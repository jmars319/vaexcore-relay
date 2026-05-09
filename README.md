# vaexcore relay

vaexcore relay is the hosted service boundary for Twitch chatbot identity, OAuth grants, EventSub webhooks, app-token chat delivery, and Discord interaction webhooks. Console remains the local operator surface, while Relay handles the public hosted paths that local desktop apps should not own directly.

Relay is not a desktop app, packaging target, public dashboard, or generic SaaS bot platform. Its role is narrow connective tissue for hosted integration flows that local desktop apps should not own directly.

## Operational Purpose

- Give vaexcore console a server-side Twitch chatbot identity path.
- Hold bot and broadcaster grants in encrypted Worker storage.
- Receive Twitch EventSub webhooks and normalize chat events for Console pickup.
- Send bot chat messages through Twitch app-token authorization.
- Receive Discord slash command interactions and queue operator-visible actions for Console.
- Register Discord slash commands for the target server.
- Queue Discord suggestions without auto-posting externally.
- Report readiness and diagnostics without exposing secrets.

## Design Posture

- Hosted only where Twitch requires a public callback or app-token flow.
- Console remains the operator-controlled local surface.
- Secrets live in Worker secrets or encrypted D1 fields, never in logs or diagnostics.
- D1 stores integration state; Relay does not own creator workflows.
- APIs are intentionally small, serializable, and auditable.

## Responsibilities

- Store Twitch bot and broadcaster grants with encrypted token fields.
- Register and receive Twitch EventSub webhooks with an app access token.
- Queue normalized chat events for vaexcore console.
- Send Twitch chat messages through the Send Chat Message API with app-token authorization.
- Verify Discord interaction signatures and handle `PING` validation.
- Register `/suggest`, `/live`, `/late`, `/cancelled`, `/scheduled`, and `/setup-status`.
- Queue Discord announcement requests for guarded Console review.
- Track Discord suggestions with new, reviewed, accepted, rejected, and archived states.
- Report relay readiness without exposing secrets.

## Architecture

```text
src/
  index.ts        Worker routes, OAuth callbacks, Console API, EventSub webhook
  discord.ts      Discord interaction signature, slash command, and queue helpers
  twitch.ts       Twitch OAuth, EventSub, Send Chat Message, and normalization helpers
  crypto.ts       token encryption, hashing, HMAC, and secure random helpers
  types.ts        Worker request, grant, readiness, and event contracts

migrations/       D1 schema for installations, grants, subscriptions, queues, and audit
test/             Node test coverage for crypto, signatures, scopes, and event mapping
wrangler.jsonc    Cloudflare Worker, D1 binding, vars, and observability config
```

## Current State

- Cloudflare Worker scaffold is implemented.
- D1 schema covers installations, OAuth grants, EventSub subscriptions, inbound chat events, outbound chat sends, Discord command/suggestion queues, and audit events.
- Twitch bot and broadcaster OAuth flows are implemented.
- EventSub webhook challenge and signature validation are implemented.
- Discord interaction signature validation, slash command registration, and suggestion queue APIs are implemented.
- Console-facing status, pairing, event pickup, subscription registration, and chat send endpoints are implemented.
- Worker dry-run, typecheck, lint, and unit tests are available.

## Deployment Posture

Relay is deployed as a Cloudflare Worker with D1. Before live use, create the real D1 database, replace the placeholder binding id in `wrangler.jsonc`, and set all required Worker secrets with `wrangler secret put`.

## Local Setup

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run worker:check
```

Required Worker secrets:

```text
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
TWITCH_EVENTSUB_SECRET
TOKEN_ENCRYPTION_KEY
RELAY_ADMIN_TOKEN
DISCORD_BOT_TOKEN
DISCORD_PUBLIC_KEY
DISCORD_APPLICATION_ID
```

`TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte key. Generate one with:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
```

Development uses the placeholder D1 database id in `wrangler.jsonc`. Create the real D1 database before deployment and replace the binding id.

Optional Discord vars/secrets:

```text
DISCORD_GUILD_ID
DISCORD_OPERATOR_ROLE_ID
```

Use `DISCORD_GUILD_ID` for guild-scoped command registration during testing and live rollout. Set `DISCORD_OPERATOR_ROLE_ID` when a Discord role should be allowed to queue announcement commands without requiring Manage Server permission.

Discord interaction endpoint:

```text
https://<relay-worker-host>/webhooks/discord/interactions
```

This endpoint must be configured in the Discord application Interactions Endpoint URL. Relay verifies `X-Signature-Ed25519` and `X-Signature-Timestamp`, responds to Discord `PING`, and queues command events for Console pickup.

## Working Locally

```bash
npm install
npm run ci
npm run dev
```

Use local Wrangler development for endpoint smoke checks. Real Twitch EventSub validation requires a public Worker URL and configured Twitch application callback URLs.

## Direction

- Keep Relay focused on hosted integration flows that cannot be local-only.
- Keep Console responsible for operator workflows, confirmations, and local logs.
- Add Discord-hosted integration paths only when a public callback or shared service boundary is required.
- Avoid moving desktop app behavior, moderation decisions, or stream production logic into Relay.

## Related Documentation

- [Cloudflare Worker configuration](wrangler.jsonc)
- [D1 schema](migrations/0001_initial.sql)
- [VaexCore Suite](https://github.com/jmars319/vaexcore-suite)
- [VaexCore Console](https://github.com/jmars319/vaexcore-console)
