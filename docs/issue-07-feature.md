# FEATURE: Goal Plan phase — decompose high-level goals into steps

**Labels:** enhancement

## Problem
The kernel assumes goals arrive pre-decomposed into steps. If an agent receives "Research competitor pricing and write a report," it has no mechanism to figure out the steps. Steps must be provided externally via `/goals` API or seeded in memory. The OODA loop is incomplete without a Plan phase that handles goal decomposition.

## Location
`kernel.js` — new `PlanPhase` class or `_plan()` method in `AgentKernel`

## Suggested Fix
Add a `_plan()` phase between `_orient()` and `_reflect()`:
1. If a goal has no steps and no `plan` field, enter Plan phase
2. Call the LLM with the goal description + context, asking for a step decomposition
3. Validate the returned steps (no cycles, all dependencies reference valid steps)
4. Store the decomposition in the goal and proceed to Reflect
5. Plan is skipped if steps are already provided

This is a new kernel phase with its own LLM call, triggered conditionally on goal structure.

## Priority
High


**Suggested labels:** enhancement
