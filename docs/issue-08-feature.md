# FEATURE: Circuit breakers and authenticated /halt kill switch

**Labels:** enhancement, security

## Problem
There is no way to stop a runaway agent short of killing the process. If the agent enters an escalation loop (e.g., escalation target auto-responds and re-triggers the kernel), it runs until `maxCycles` on every activation — burning LLM calls and potentially sending repeated messages. No circuit breaker exists for:
- Repeated LLM failures (circuit opens after N consecutive failures)
- Activation rate (circuit opens after N activations per hour)
- No authenticated remote halt endpoint

## Location
`kernel.js` — `ActivationHarness`, `server.js` — new endpoint

## Suggested Fix
1. Add `CircuitBreaker` class: tracks consecutive LLM failures and activation rate; opens circuit (rejects new activations) after threshold
2. Add `POST /halt` endpoint with bearer token auth: calls `harness.stop()` and clears queues
3. Add `GET /circuit-status` endpoint: returns `{ closed: bool, failures: N, activations_this_hour: M }`
4. Wrap `reason()` calls in circuit breaker — if open, return `{ type: 'wait', reason: 'circuit_open' }` instead of calling LLM

## Priority
High


**Suggested labels:** enhancement, security
