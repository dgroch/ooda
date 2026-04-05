# BUG: /health endpoint always returns { ok: true } — no dependency checks

**Labels:** bug

## Problem
`GET /health` returns `{ ok: true }` unconditionally. It doesn't verify SQLite connectivity, LLM availability, or outbound webhook reachability. A health check that always passes gives a false sense of system health — the agent could be completely unable to make LLM calls while `/health` reports green.

## Location
`server.js` — `GET /health` endpoint

## Suggested Fix
Add actual dependency checks:
```js
app.get('/health', async (req, res) => {
  const checks = {
    sqlite: await checkSqlite(),      // run SELECT 1
    llm: await checkLlmHealth(),     // lightweight /models or /chat probe
    webhook: await checkWebhookReachability()
  };
  const healthy = Object.values(checks).every(v => v === true);
  res.status(healthy ? 200 : 503).json({ ok: healthy, checks });
});
```

## Priority
Medium


**Suggested labels:** bug
