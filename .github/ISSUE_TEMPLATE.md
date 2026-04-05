**Severity:** Critical
**File:** server.js ~554-559

**Problem:** haltAuth middleware calls next() when WEBHOOK_SECRET is unset, allowing unauthenticated anyone to halt the agent.

**Fix:** haltAuth now falls back to checking AUTH_TOKEN (Bearer token). Never calls next() without a valid token.