# FEATURE: No-op skill execution without progress detection — goal loops indefinitely

**Labels:** enhancement

## Problem
The continue condition (kernel.js ~952-956) requires `outcome.success` and not a communicate/wait action. If a skill executes "successfully" (`{ success: true }`) but doesn't actually advance the goal (step isn't meaningful), the loop continues indefinitely. The only safeguard is `maxCycles` (default 20). A skill can waste all 20 cycles with no useful progress, burning expensive LLM calls.

## Location
`kernel.js` — `_integrate()` continue logic (~line 952-956)

## Suggested Fix
Track step-level progress: compare `state.goal.steps` before and after skill execution. If no step changed from `in_progress` to `done`, increment a `noProgressCycles` counter. If `noProgressCycles > 3` (configurable), treat as `{ success: false }` and trigger escalation or goal failure rather than continuing to loop.

## Priority
Medium


**Suggested labels:** enhancement
