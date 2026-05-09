# vaexcore relay

vaexcore relay is the hosted service boundary for Twitch chatbot identity. Console remains the local operator surface, while Relay handles the server-side Twitch app-token paths that are required for the bot account to appear as a Chat Bot in Twitch chat.

## Responsibilities

- Store Twitch bot and broadcaster grants with encrypted token fields.
- Register and receive Twitch EventSub webhooks with an app access token.
- Queue normalized chat events for vaexcore console.
- Send Twitch chat messages through the Send Chat Message API with app-token authorization.
- Report relay readiness without exposing secrets.

## Local Setup

```bash
npm install
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
```

`TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte key. Generate one with:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
```

Development uses the placeholder D1 database id in `wrangler.jsonc`. Create the real D1 database before deployment and replace the binding id.

## GitHub Remote

This local repo intentionally starts without a remote. After the GitHub repo exists:

```bash
git remote add origin https://github.com/jmars319/vaexcore-relay
git push -u origin main
```
