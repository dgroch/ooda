# FEATURE: Webhook security hardening — HMAC signing, rate limiting, HTTPS

**Labels:** security, enhancement

## Problem
Webhook authentication uses a static bearer token with no rotation mechanism. Missing:
- No request signing (HMAC) — payloads can be tampered with in transit
- No HTTPS enforcement — server binds plain HTTP
- No rate limiting on the webhook endpoint — an attacker can flood the agent with events
- Single static token with no rotation — if compromised, no way to rotate without downtime

## Location
`server.js` — webhook handler (~line 68-86), `server.js` — `POST /webhook` endpoint

## Suggested Fix
1. Add `WEBHOOK_SECRET` env var; verify `X-Hub-Signature-256` HMAC on every inbound webhook request
2. Add `express-rate-limit` to the webhook endpoint
3. Document requirement for HTTPS reverse proxy (nginx/Caddy) in front of the server
4. Support token rotation: accept up to two valid tokens (old + new) during a migration window via `WEBHOOK_SECRET_OLD`

## Priority
High


**Suggested labels:** security, enhancement
