# BUG: communicate action always halts the activation loop — even non-escalation messages end the cycle

**Labels:** bug

## Problem
In `_integrate` (kernel.js ~1160-1164), `shouldContinue = false` whenever `action.type === 'communicate'`. But `communicate` is used for BOTH human escalation AND regular team coordination. If an agent needs to send a team message and continue processing as part of the same step, the first `communicate` action ends the entire activation.

There's no way to send a non-blocking team message as part of a step without halting. The only current workaround is for the step to complete, but the kernel has no mechanism to resume from a team message and continue the same goal.

## Location
`kernel.js` — `_integrate()` (~line 1160-1164)

## Suggested Fix
Distinguish escalation (`awaitingResponse: true`) from regular team messages (`awaitingResponse: false`):
```js
if (action.type === 'communicate' && action.awaitingResponse === true) {
  shouldContinue = false;
}
// For awaitingResponse=false, keep shouldContinue=true and record the sent message
```
The `communicate` action should only halt if `awaitingResponse === true`.

## Priority
High


**Suggested labels:** bug
