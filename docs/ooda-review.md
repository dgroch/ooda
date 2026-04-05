# Logic Kernel v2 — Architecture Review

## 1. Architecture & Design

### The OODA + Reflect loop is a strong choice — with caveats

The OODA framework maps well to autonomous agents. It's a real cognitive model (Boyd's loop was designed for decision-making under uncertainty), and adding Reflect between Orient and Decide is a genuinely good idea — it creates a checkpoint where the agent can revise confidence before committing to action.

**What's good:**
- The structural/LLM boundary is mostly drawn in the right place. The kernel controls sequencing, escalation, and step readiness. The LLM provides judgement within guardrails. This is the correct instinct — most agent failures come from giving the LLM too much control over flow.
- The escalation engine running *before* the LLM's decide phase is a key insight. Most agent frameworks let the LLM decide whether to escalate, which is exactly backwards.
- DependencyResolver is clean and correct. Topological sort with cycle detection, ready/blocked gating — this is the right level of structure.

**What's missing or wrong:**

1. **No priority system for goals.** The kernel always picks `activeGoals[0]` (`kernel.js:539`, `kernel.js:1013`). With multiple active goals, ordering is arbitrary (insertion order). The Orient phase asks the LLM to pick a `goalId`, but the flat state only exposes the first goal's data. This means pattern matching is blind to all but the first goal, and the LLM's goal selection has no structural backing.

2. **The Reflect phase can't actually change anything.** It revises confidence (which feeds escalation) and produces "insights" that go into working memory — but the insights are never read by anything downstream. The `_decide` method reads `reflection.revisedConfidence` but ignores `reflection.answers` and `reflection.insights`. Self-interrogation is a good idea, but right now it's half-implemented: the kernel asks questions, the LLM answers, and then the answers are mostly discarded.

3. **Orient feeds too much context to the LLM.** The orient prompt includes the full trigger, all active goals, 10 episodes, all matched patterns, predictions, stored knowledge, and the team roster (`kernel.js:563-573`). With a real deployment, this will blow past context windows fast. There's no summarisation, no relevance filtering, no token budget. This will be the first thing that breaks in production.

4. **No Plan phase.** The OODA loop assumes goals arrive pre-decomposed into steps. But real work requires the agent to decompose goals into steps itself. Right now, steps are externally provided via the `/goals` API or seeded in memory. If you want an agent that can receive "Research competitor pricing and write a report" and figure out the steps, the kernel has no mechanism for that. This is the biggest missing piece.

### Comparison to established architectures

- **BDI (Belief-Desire-Intention):** Your three-tier memory maps roughly to beliefs (episodic + knowledge), desires (goals), and intentions (the current step being executed). The kernel enforces intention commitment better than most BDI implementations — the DependencyResolver and EscalationEngine create hard commitment rules. BDI frameworks typically allow more flexible intention revision, which could be an issue here (you can't reprioritise mid-goal).

- **SOAR/ACT-R:** These architectures have explicit impasse detection and sub-goaling. Your research mode is a simplified version of this (skill gap → research sub-cycle), but SOAR's approach is more general: any blocked state triggers structured problem-solving. Your kernel only sub-goals for skill gaps — it doesn't handle other types of impasses (e.g., conflicting evidence, ambiguous goals).

- **LangGraph/CrewAI:** These are orchestration frameworks, not cognitive architectures. Your kernel is a fundamentally different (and more principled) thing. LangGraph gives the LLM full control of graph traversal. CrewAI's role system is a social pattern, not a decision architecture. Your structural enforcement approach is stronger than both, but those frameworks have better tool ecosystems and production hardening.

## 2. Correctness & Robustness

### Race conditions

**The activation harness queue has a subtle concurrency bug.** In `_enqueue` (`kernel.js:120-125`), the check-and-run is not atomic:

```js
async _enqueue(trigger) {
  if (this._activeCount < this.maxConcurrent) {
    await this._run(trigger);  // awaits the full activation
  } else {
    this._queue.push(trigger);
  }
}
```

Since `_enqueue` is `async` and `_run` is awaited, two near-simultaneous `emit()` calls will both enter `_run` before either increments `_activeCount`, violating `maxConcurrent`. With `maxConcurrent: 1`, you can get two activations running in parallel.

Fix: increment `_activeCount` in `_enqueue` before awaiting `_run`, or use a proper mutex/semaphore pattern.

**Memory is also racy.** `MemoryManager.recordEpisode` does read-modify-write (`kernel.js:376-380`):

```js
const episodes = (await this.store.get('episodes')) ?? [];
episodes.push(...);
await this.store.set('episodes', episodes);
```

With concurrent activations (even with maxConcurrent > 1), two cycles can read the same episode list, both append, and one write clobbers the other's addition. Same pattern exists in `upsertPattern`, `upsertGoal`, `addSkill`, and `addKnowledge`. Every read-modify-write in MemoryManager is a lost-update bug waiting to happen.

### Degenerate loop states

1. **Research oscillation.** If a step requires skill X, the kernel enters research mode (`kernel.js:745-758`). Research calls the LLM, which can return `newSkill: null`. Next cycle, the skill is still missing, so research fires again. The escape hatch is `researchFailed` in working memory — but research only sets this on `!outcome.success` (`kernel.js:840`). The research `_research()` method always returns `{ success: true }` if the LLM responds (`kernel.js:993`). So: **research can never "fail" unless the LLM throws an exception.** The `researchFailed` → escalation path is unreachable under normal conditions.

2. **Infinite continuation with no progress.** The continue condition (`kernel.js:952-956`) requires `outcome.success` and not a communicate/wait action. If a skill executes "successfully" but doesn't actually advance the goal (e.g., returns `{ success: true }` but the step isn't meaningful), the loop continues indefinitely. The `maxCycles` cap is the only safeguard, but 20 cycles of wasted LLM calls is expensive.

3. **The "wait" action halts the loop but drops the ball.** When no steps are ready, the kernel returns `{ type: 'wait' }`, which causes `shouldContinue = false`. The activation ends with status `'paused'`. But nothing re-activates the kernel when the blocking condition resolves. If steps are blocked on external events, the kernel just stops. There's no wake-up mechanism.

### DependencyResolver edge cases

The resolver is actually solid. The topoSort correctly detects cycles. `getReady` handles diamond dependencies correctly (all deps must be 'done'). One edge case:

**Orphaned steps** — if a step depends on a non-existent step ID, `statusMap.get(depId)` returns `undefined`, which is `!== 'done'`, so the step stays blocked forever. It would be worth validating step references at goal creation time rather than silently deadlocking.

### PatternMatcher edge cases

1. **Operator parsing ambiguity.** The condition `key>=value` is parsed by scanning for `>=` first (it's first in the ops array), which is correct. But `key=>=value` (key is "key", value is ">=value") would parse incorrectly — it would match `>=` at index 3, making key "key" and value ">value" after slicing past ">=". This is a minor edge case but shows the DSL needs escaping or a proper parser if it grows.

2. **Non-numeric comparisons silently return false.** `score>high` returns `false` because both aren't numeric. This is correct behaviour but there's no warning, logging, or error — the condition silently doesn't match. Could be confusing to debug.

3. **The flat state is all strings** (`kernel.js:1004`, `String(prog.done)`), but the pattern matcher does numeric coercion. This works because `Number("3")` is `3`, but it's a fragile contract. If someone puts `goal.steps.done>2` as a condition, it works. But `goal.progress>0.5` works only because `String(0.50.toFixed(2))` is `"0.50"` and `Number("0.50")` is `0.5`. Correct by accident.

## 3. Scalability & Production Readiness

### What breaks at scale

1. **Token cost explosion.** Every cycle makes 2-3 LLM calls (orient, reflect, decide, sometimes research). A 10-cycle activation is 20-30 LLM calls. At ~4K tokens per prompt (with all that context), that's 80-120K input tokens per activation. With Claude at $3/M input tokens, a single activation costs ~$0.30. At 100 activations/day, that's $30/day — just for one agent. And this is a conservative estimate; real memory contents will be larger.

2. **SQLite will bottleneck.** `DatabaseSync` (`store-sqlite.js:12`) is synchronous — it blocks the event loop on every read/write. Under load, the Express server will stall on every memory operation. The async wrapper in SqliteStore is cosmetic — the underlying calls are sync. You need `node:sqlite`'s async API or better-sqlite3 with worker threads.

3. **Episode list growth.** The 200-episode cap (`kernel.js:379`) prevents unbounded growth, but every `recordEpisode` call reads all 200 episodes, deserialises them, pushes one, re-serialises, and writes them all back. That's O(n) per write on the full episode history. With SQLite, this means writing a multi-KB JSON blob on every cycle. Use individual rows, not a single JSON array.

4. **No LLM failure handling.** If `reason()` throws (timeout, rate limit, malformed JSON), the error bubbles up through `_orient`/`_reflect`/`_decide` and kills the entire activation. The catch in `_act` (`kernel.js:858`) only covers skill/tool execution, not the reasoning calls themselves. You need retry logic with backoff for LLM calls, and graceful degradation when the LLM is unavailable.

### What's missing for production

- **No request tracing.** The `activationId` exists but isn't attached to LLM calls, tool executions, or store operations. You can't correlate a slow SQLite write back to which activation caused it.
- **No metrics.** No counters for activations, cycle counts, LLM latency, escalation rates, pattern match rates. You're flying blind.
- **No structured logging.** Console.log everywhere. No log levels, no JSON formatting, no correlation IDs.
- **No health check for dependencies.** The `/health` endpoint returns `{ ok: true }` unconditionally. It doesn't check SQLite connectivity, LLM availability, or outbound webhook reachability.
- **No graceful degradation.** If the LLM is down, the whole agent is down. There's no fallback behaviour (e.g., queue the activation for later, execute with cached decisions).

### Storage migration path

The `InMemoryStore` → `SqliteStore` abstraction is a good start but insufficient. The interface (get/set/delete/list with string keys and JSON values) is essentially a document store. Moving to Postgres would require:
- Separate tables for goals, episodes, patterns, knowledge, team (not a single KV table)
- Proper indexes (episodes by timestamp, goals by status, patterns by condition)
- Transactions for the read-modify-write patterns in MemoryManager

I'd recommend defining the MemoryManager's operations as the real interface (not the store's get/set), and having store implementations handle their own schema. This way, a Postgres adapter can use proper tables and queries while the InMemoryStore stays simple.

## 4. Extensibility

### Adding skills/tools/team members

**Easy.** The registry pattern is clean:
```js
tools.register({ id, name, description, execute });
skills.register({ id, name, description, triggerConditions, execute });
```
This is one of the strongest parts of the design. The contract is simple, the skill executor gets a useful context object (tools, memory, reason), and there's no framework magic.

### Multiple concurrent goals

**Doesn't work currently.** The kernel processes one goal per cycle (the one the LLM selects in orient). There's no interleaving, no goal-switching, and the flat state only represents the first active goal. To support this properly:
- Priority system with preemption rules
- Per-goal working memory (currently shared)
- Goal-switching costs (save/restore context)
- The dependency resolver would need cross-goal dependencies

This is a significant redesign. I'd recommend keeping single-goal execution and adding a goal scheduler above the kernel — let the scheduler decide which goal to activate, and have the kernel focus on executing one goal at a time.

### Team communication integration

The outbound webhook in `server.js:68-86` is the right hook. To integrate with Slack/email:
- Implement specific tools (`slack_send`, `email_send`) rather than a generic `send_message`
- Add inbound webhook handlers for responses (Slack interactive messages, email replies)
- The `communicate` action in the act phase should record what it's waiting for, so the harness can match incoming responses to pending escalations

### Pattern matcher DSL scaling

The current DSL (key-op-value string parsing) will hit limits fast:
- No boolean operators (AND is implicit across conditions; there's no OR)
- No nested conditions
- No temporal conditions ("X happened in the last N cycles")
- No aggregation ("success rate > 80% over last 10 episodes")

For now, the DSL is fine — it's simple and structural. But if you need complex rules, either switch to a proper rule engine (e.g., json-rules-engine) or make conditions executable predicate functions rather than parsed strings. The string DSL is a maintenance trap if it grows beyond 5-6 operators.

## 5. Security & Safety

### Action guardrails

The `policyBoundaries` mechanism is a good start — it prevents specific action types without human approval. But it only checks `nextStep.skillRequired` against the boundary list (`kernel.js:318-323`). If the LLM decides to use a tool that *does* something dangerous but the step's `skillRequired` doesn't match a boundary keyword, the boundary is bypassed.

**What's needed:**
- Tool-level permissions. Each tool should declare its risk level and required approval. `web_search` is safe; `delete_database` is not.
- Output validation. After the LLM's decide phase, validate the returned `action` against an allowlist of permitted actions for this step, not just the step's `skillRequired`.
- Rate limiting on sensitive tools. Even approved tools should have per-hour/per-day limits.
- An audit log. Every action the agent takes should be logged immutably — not just in episodes (which can be trimmed to 200).

### Adversarial LLM output

The kernel trusts `reason()` output completely. If the LLM returns malformed JSON, `JSON.parse` throws and kills the activation (no catch around LLM calls). If the LLM returns structurally valid but semantically adversarial output (e.g., `route: "self"` with `action.type: "execute_skill"` pointing to a dangerous skill), the kernel executes it without question.

**Mitigations needed:**
- Schema validation on every `reason()` response. Use a lightweight validator (Zod, ajv) to verify the response matches the expected shape before acting on it.
- Action sandboxing. Skills and tools should run with least privilege. A skill shouldn't be able to call arbitrary tools — only those listed in its `toolsRequired`.
- Confidence bounds. If the LLM returns `confidence: 1.0` on a novel situation with no patterns, something is wrong. Add sanity checks on confidence values.

### Webhook auth

Bearer token auth (`server.js:165-169`) is minimal but acceptable for a first pass. Missing:
- No HTTPS enforcement (the server binds plain HTTP)
- No request signing (HMAC) for webhook payloads
- No IP allowlisting
- No rate limiting on the webhook endpoint — an attacker can flood the agent with events
- The auth token is compared with `===`, which is fine (no timing attack concern for bearer tokens at this layer), but it's a single static token with no rotation mechanism

### The biggest safety gap

There's no **kill switch**. If the agent enters a bad loop (escalation to a target that auto-responds, triggering re-activation), there's no way to stop it short of killing the process. The harness has `stop()` but nothing calls it based on runtime conditions. You need:
- A circuit breaker (N failures in M minutes → halt)
- A remote kill endpoint (authenticated)
- Rate limiting on activations (max N per hour)

## 6. What I'd Change

### Keep

- **The structural/LLM boundary.** This is the core insight and it's correct. The kernel enforces, the LLM advises. Don't compromise this.
- **The DependencyResolver.** Clean, correct, minimal. Ship it.
- **The EscalationEngine running before decide.** Non-negotiable safety property.
- **The ActivationHarness abstraction.** Event + cron triggers with queue management is the right pattern.
- **Zero-dependency core.** This makes the kernel portable and auditable.

### Cut

- **The pattern matcher's string DSL.** Replace with executable predicate functions now, before the DSL accumulates syntax. Patterns should be `{ conditions: [(state) => state['goal.assignedBy'] === 'human_dan'] }`. You can always add a DSL compiler later.
- **The single JSON-blob storage model.** Storing episodes, goals, and patterns as single JSON arrays in a KV store is a prototype pattern. It creates O(n) reads and lost-update races. Move to proper per-entity storage before anything else.

### Do differently

1. **Add a Plan phase.** Between Orient and Reflect, the kernel should be able to decompose a high-level goal into steps. Right now it requires pre-decomposed goals. Make planning a structural kernel operation (with LLM input), not an external concern.

2. **Add LLM response validation.** Every `reason()` call should validate the response against a schema before the kernel acts on it. This is a 30-line change that prevents an entire class of failures.

3. **Fix the memory model for production.** Replace read-modify-write-entire-list patterns with proper per-entity operations. MemoryManager should have `addEpisode(episode)` backed by an `INSERT`, not `getAll → push → setAll`.

4. **Add circuit breakers.** Wrap `reason()` in a circuit breaker that tracks failures and degrades gracefully. Wrap tool execution similarly.

5. **Make the context window budget explicit.** Before calling `reason()`, calculate the token count of the prompt. If it exceeds a budget, summarise or truncate. This is the #1 production reliability issue.

### Single biggest risk

**Unbounded context feeding to the LLM.** The orient phase dumps everything into a single prompt — goals, episodes, patterns, knowledge, team. In production, this *will* exceed context windows, and the failure mode is silent (truncated context → bad decisions → wrong actions → no error). This needs a hard token budget with summarisation before anything else.

### What to build next

1. **LLM response validation** (hours, not days — highest ROI)
2. **Token budget management** for context assembly
3. **Proper per-entity storage** (eliminate read-modify-write races)
4. **Goal decomposition** (Plan phase)
5. **Circuit breakers + kill switch**
6. **Structured logging + metrics**
