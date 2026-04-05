# BUG: _research() always returns success=true — researchFailed escalation path is unreachable

**Labels:** bug, critical-path

## Problem
`_research()` (kernel.js ~993) always returns `{ success: true }` whenever the LLM responds normally. The escape hatch `researchFailed` in working memory is only set when `outcome.success === false` (kernel.js ~1048), which is unreachable unless the LLM throws. The `researchFailed → escalate` path in `EscalationEngine.evaluate()` (kernel.js ~360-366) is therefore completely dead code.

**Effect:** If a step requires a skill the agent doesn't have, it enters research mode, the LLM responds (always "successfully"), and the kernel re-enters research mode on the next cycle. This loops until `maxCycles` (default 20) is exhausted. The human is never notified. The skill-gap escalation mechanism (architecture.md: "Skill gap + research failed → escalate") never fires.

## Location
`kernel.js` — `_research()` (~line 993) and `EscalationEngine.evaluate()` (~line 360)

## Suggested Fix
In `_research()`, detect when the LLM returns `newSkill === null` or an empty skill and return `{ success: false }` in that case — not just on LLM exception:
```js
const result = await this.reason(...)
if (!result.success || !result.findings?.newSkill) {
  return { success: false, error: result.error || 'no skill acquired' };
}
return { success: true, skill: result.findings.newSkill };
```
This makes the `researchFailed → escalate` path reachable.

## Priority
Critical


**Suggested labels:** bug, critical-path
