# FEATURE: LLM confidence sanity check — detect obviously wrong confidence values

**Labels:** enhancement

## Problem
If the LLM returns `confidence: 1.0` in a novel situation with no matching patterns and no relevant episodic memory, there's no sanity check. A confidence of 1.0 in an unfamiliar situation is a strong signal the LLM is hallucinating certainty. The kernel acts on this confidence value to gate escalation — an inflated confidence can prevent needed human escalation.

## Location
`kernel.js` — `_decide()` or `ActionValidator`, after LLM `reason()` returns

## Suggested Fix
After LLM returns confidence in `_decide`, apply a sanity discount:
```js
const baseConfidence = result.decision.confidence ?? 0.5;
const noveltyPenalty = matchedPatterns.length === 0 ? 0.2 : 0;
const adjustedConfidence = Math.max(0.1, baseConfidence - noveltyPenalty);
```
Log a warning when confidence is adjusted. This prevents the kernel from over-trusting the LLM in unfamiliar situations.

## Priority
Medium


**Suggested labels:** enhancement
