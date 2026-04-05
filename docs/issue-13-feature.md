# FEATURE: Goal priority system — ordered goal selection instead of arbitrary activeGoals[0]

**Labels:** enhancement

## Problem
The kernel always picks `activeGoals[0]` (kernel.js ~539, ~1013) — ordering is arbitrary insertion order. The Orient phase asks the LLM to pick a `goalId`, but the flat state only exposes the first goal's data, so the LLM's selection has no structural backing and pattern matching is blind to all but the first goal.

## Location
`kernel.js` — `AgentKernel.activate()` (~line 539), `DependencyResolver.getReady()` (~line 1013), `_buildFlatState()` (~line 1221)

## Suggested Fix
1. Add `goal.priority: number` field (higher = more urgent)
2. Sort `activeGoals` by priority descending before selecting
3. Restructure `_buildFlatState` to expose all active goals' metadata (id, priority, progress) so pattern matcher and LLM orient can reason across all goals
4. The LLM goal picker in orient then has structural backing: it picks from a properly ordered list with full visibility

## Priority
Medium


**Suggested labels:** enhancement
