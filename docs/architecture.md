# Logic Kernel v2 — Architecture Spec

## 1. What This Is

A runtime-agnostic cognitive architecture for an AI agent that operates like a human worker within a heterogeneous team. The kernel structures *how* the agent thinks — the LLM provides reasoning within guardrails the kernel enforces.

**Runtime targets:** OpenClaw, Hermes, or standalone Node.js
**Language:** JavaScript (ES modules, zero dependencies)
**LLM coupling:** Zero — pass in any `reason(prompt) → structuredOutput` function

### v2 changes from v1
- **ActivationHarness** — event listeners + cron scheduler. The agent now has ears and a clock.
- **DependencyResolver** — structural step sequencing. Dependencies are enforced, not suggested.
- **Structural enforcement** — escalation, pattern matching, and self-interrogation are kernel logic. The LLM advises; the kernel decides.

---

## 2. Activation Harness

The agent is activated by either **inbound events** or **cron tasks**. The `ActivationHarness` is the adapter layer between the outside world and the kernel.

```
                External World
                     │
        ┌────────────┼────────────┐
        │            │            │
   Webhook      Message      Timer
        │            │            │
        └────────────┼────────────┘
                     │
              ActivationHarness
              ├─ .on(eventType, { filter, transform })
              ├─ .cron(id, intervalMs, label)
              ├─ .emit(eventType, payload)
              └─ .start() / .stop()
                     │
                     ▼
              kernel.activate(trigger)
```

### Event Registration
```js
harness.on('task_assigned', {
  filter: (payload) => payload.assignedTo === 'MyAgent',
  transform: (payload) => payload,
});
```

### Cron Registration
```js
harness.cron('daily_review', 86400000, 'Daily progress check');
```

### Concurrency
The harness queues activations and respects `maxConcurrent` (default: 1). Events arriving while the agent is busy are queued and processed in order.

### Runtime Integration
The harness is deliberately simple — it uses `setInterval` for cron. In OpenClaw, you'd replace cron registration with the runtime's scheduler. In Hermes, you'd wire `harness.emit()` to the event bus. The kernel doesn't care.

---

## 3. Core Loop: OODA + Reflect

Every activation follows: **Observe → Orient → Reflect → Decide → Act → Integrate**

The Reflect phase is new in v2 — structured self-interrogation.

```
              ┌────────────────┐
              │    OBSERVE     │  Load trigger + all memory tiers
              │                │  Run structural pattern matching
              └───────┬────────┘
                      ▼
              ┌────────────────┐
              │    ORIENT      │  LLM assesses situation
              │                │  Identifies goal + knowledge gaps
              └───────┬────────┘
                      ▼
              ┌────────────────┐
              │    REFLECT     │  Kernel generates questions
              │                │  LLM answers honestly
              │                │  Confidence may be revised
              └───────┬────────┘
                      ▼
              ┌────────────────┐
              │    DECIDE      │  1. Escalation engine (hard rules)
              │                │  2. Dependency resolver (ready steps)
              │                │  3. Skill gap → research
              │                │  4. Delegation check
              │                │  5. LLM decides HOW (within guardrails)
              └───────┬────────┘
                      ▼
              ┌────────────────┐
              │     ACT        │  Execute skill/tool/research/communicate
              └───────┬────────┘
                      ▼
              ┌────────────────┐
              │   INTEGRATE    │  Update memory tiers
              │                │  Update pattern confidence
              │                │  Structural dep/blocked status
              │                │  Check acceptance criteria
              │                │  Decide: continue or halt
              └───────┬────────┘
                      ▼
                 continue? ──yes──▶ loop to OBSERVE
                      │
                     no
                      ▼
                    DONE
```

---

## 4. Self-Interrogation (Reflect Phase)

The kernel — not the LLM — generates structured questions based on the current situation. The LLM then answers them honestly. This is how the agent "asks itself questions."

### Question generation rules (deterministic):

| Condition | Question generated |
|---|---|
| Always | "Am I working on the highest-priority goal?" |
| Goal exists | "Do I understand what done looks like for [goal]?" |
| Multiple ready steps | "I have N steps ready — which first and why?" |
| All steps blocked | "Can I unblock any, or do I need help?" |
| Skill gap on ready step | "Step X needs skill Y which I don't have — research or escalate?" |
| Patterns matched | "My pattern engine made predictions — do they seem reasonable?" |
| Blocking knowledge gaps | "I have N blocking gaps. Can I resolve with available tools?" |
| Low confidence (<0.6) | "What specifically am I uncertain about?" |

The LLM's answers may **revise its confidence** — which feeds directly into the escalation engine.

---

## 5. Dependency Resolver

Steps declare dependencies. The kernel enforces them structurally.

```js
DependencyResolver.getReady(steps)    // Steps whose deps are all 'done'
DependencyResolver.isBlocked(step)    // { blocked: boolean, waitingOn: [...] }
DependencyResolver.topoSort(steps)    // Topological order (throws on cycles)
DependencyResolver.progress(steps)    // { progress: 0.0–1.0, done, total, blocked }
```

### Rules
- A step can only execute if **all** dependencies are status `'done'`.
- If a step has unmet deps, it's marked `'blocked'` in INTEGRATE.
- When a dep completes, blocked steps are automatically re-evaluated and unblocked.
- The LLM never picks which step to run — the resolver does.
- If no steps are ready and some are blocked, the agent pauses or escalates.

---

## 6. Escalation Engine

Hard rules that the LLM **cannot override**. The escalation engine runs **before** the LLM's DECIDE phase.

| Rule | Condition | Target |
|---|---|---|
| Low confidence | `confidence < threshold` (default: 0.4) | Senior or human |
| Policy boundary | Action type in `policyBoundaries` list | Human (always) |
| Skill gap + research failed | No skill and self-research already failed | Peer or senior |
| Stuck too long | Same step for `maxBlockedCycles` (default: 3) | Senior |
| Fully blocked | All remaining steps are blocked | Senior |

When escalation fires:
1. The kernel overrides the LLM's decision
2. A `communicate` action is emitted with the escalation reason
3. The cycle pauses (awaiting response)
4. The `structuralOverride: true` flag is set for observability

---

## 7. Pattern Matcher

Structural condition evaluation — patterns are matched by the kernel, not the LLM.

### Pattern definition
```js
{
  id: 'pat_dan_tasks',
  description: 'Tasks from Dan generally succeed',
  conditions: ['goal.assignedBy=human_dan'],
  expectedOutcome: 'success',
  confidence: 0.85,
  occurrences: 12,
}
```

### Supported condition operators
`=`, `!=`, `>`, `<`, `>=`, `<=`, `:contains:`, `:exists`

### Flat state
The kernel builds a flat key-value state object from the trigger, goals, and recent episodes. Example keys:
- `trigger.mode`, `trigger.source`, `trigger.eventType`
- `trigger.payload.{key}`
- `goal.id`, `goal.status`, `goal.assignedBy`
- `goal.progress`, `goal.steps.done`, `goal.steps.total`
- `last.outcome.success`

### Confidence tracking
After each cycle, the kernel compares predictions to actuals. Pattern confidence is updated using an exponential moving average (alpha = 0.2).

---

## 8. Memory Architecture (Three-Tier)

Unchanged from v1. See memory tier descriptions:

| Tier | Scope | Contains | Analogy |
|---|---|---|---|
| Working | Current activation | Active goals, scratch state, predictions | What's on your desk |
| Episodic | Recent history (200 max) | Past trigger → action → outcome records | What you did last week |
| Long-term | Persistent | Skills, knowledge, patterns, team roster | Your training + org chart |

### Memory flow
- OBSERVE reads all three tiers
- ACT writes to working memory
- INTEGRATE promotes: working → episodic, episodic → long-term (pattern updates)

---

## 9. Skill System

Skills are composable capability units with trigger conditions and an execute function.

### Skill acquisition
When DECIDE identifies a skill gap:
1. Kernel enters research mode (a sub-cycle)
2. LLM uses tools to gather knowledge
3. Findings encoded as knowledge + pattern (Tier 3)
4. If research fails → escalation engine fires
5. Skill executor must be wired by runtime/human (safety rail)

---

## 10. Team Protocol

The agent knows its team roster with roles and capabilities.

### Routing decisions (structural, in DECIDE):
| Route | When | How |
|---|---|---|
| **Self** | Has skill + confidence | Execute directly |
| **Delegate** | Junior has the required skill | Assign to junior |
| **Collaborate** | Peer has complementary skill | Coordinate |
| **Escalate** | Hard rules triggered | Communicate + pause |

Delegation is checked structurally — the kernel looks for junior team members whose `capabilities` include the required skill. The LLM can accept or decline the delegation suggestion, but cannot override escalation.

---

## 11. Acceptance Criteria

Every goal can carry explicit acceptance criteria:
```js
{
  description: 'Summary contains competitor pricing data',
  check: async (state) => ({ met: true, evidence: 'Found 3 competitors' }),
}
```

When no criteria are defined, the kernel falls back to step-based progress (done/total).

A step is only marked `'done'` after a successful **execution** action (`execute_skill` or `use_tool`). Communication, waiting, and research actions do not mark steps complete.

---

## 12. Observability

Every phase emits a structured event:
```js
{
  phase: 'observe|orient|reflect|decide|act|integrate',
  activationId, cycle, timestamp, durationMs,
  input: { ... },
  output: { ... },
}
```

Key flags to watch:
- `output.structuralOverride: true` — kernel overrode LLM decision
- `output.goalComplete: true` — goal finished
- `output.mustEscalate: true` — escalation fired

---

## 13. Module Summary

| Module | Responsibility | Logic type |
|---|---|---|
| `ActivationHarness` | Event listener + cron scheduler | Structural |
| `DependencyResolver` | Step sequencing + progress | Structural |
| `PatternMatcher` | Condition evaluation + confidence | Structural |
| `EscalationEngine` | Hard escalation rules | Structural |
| `AgentKernel._reflect()` | Self-interrogation questions | Structural (questions) + LLM (answers) |
| `AgentKernel._orient()` | Situation assessment | LLM |
| `AgentKernel._decide()` | HOW to execute (within guardrails) | LLM |
| `MemoryManager` | Three-tier state | Structural |
| `SkillRegistry` / `ToolRegistry` | Capability inventory | Structural |
