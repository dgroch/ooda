# FEATURE: Tool-level permissions and action allowlisting per step

**Labels:** security, enhancement

## Problem
`policyBoundaries` only checks `nextStep.skillRequired` against a keyword list. If the LLM decides to use a dangerous tool that isn't tagged with the boundary keyword, the boundary is bypassed. There's no per-step action allowlisting and no tool risk-level system.

## Location
`kernel.js` — `ActionValidator` (~line 520), `policyBoundaries` logic (~line 318-323)

## Suggested Fix
1. Add `riskLevel: 'safe' | 'elevated' | 'dangerous'` field to every registered tool and skill
2. Add `allowedTools: string[]` and `blockedTools: string[]` fields to each step definition
3. `ActionValidator` checks the step's `allowedTools`/`blockedTools` in addition to `skillRequired`
4. Tools with `riskLevel: 'dangerous'` require explicit step-level allowlist entry to execute

## Priority
High


**Suggested labels:** security, enhancement
