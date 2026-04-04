# Logic Kernel

A runtime-agnostic cognitive architecture for AI agents that operate like human workers within a team.

The kernel structures *how* an agent thinks — the LLM provides reasoning within guardrails the kernel enforces. Zero dependencies beyond Express for the runtime shell.

## What it does

An agent powered by this kernel can:

- Be activated by **inbound events** (webhooks) or **cron tasks**
- Maintain **three-tier memory** (working → episodic → long-term) across activations
- **Decompose goals** into dependency-ordered steps and track progress
- **Pattern match** against learned patterns and make predictions about outcomes
- **Acquire new skills** through self-directed research when it hits a knowledge boundary
- **Escalate, delegate, or collaborate** with team members (human or AI) based on hard rules
- Know when a goal is **done** — acceptance criteria, not vibes

## Architecture

The core loop is **OODA + Reflect**:

```
OBSERVE → ORIENT → REFLECT → DECIDE → ACT → INTEGRATE → (loop)
```

Key design principle: **the kernel enforces behaviour structurally**. The LLM advises within guardrails.

| Module | What it controls | Logic type |
|---|---|---|
| `DependencyResolver` | Step sequencing, ready/blocked status | Structural |
| `PatternMatcher` | Condition evaluation, confidence tracking | Structural |
| `EscalationEngine` | Hard escalation rules (overrides LLM) | Structural |
| `AgentKernel._reflect()` | Self-interrogation questions | Structural |
| `AgentKernel._orient()` | Situation assessment | LLM |
| `AgentKernel._decide()` | How to execute (within guardrails) | LLM |

Full architecture doc: [`docs/architecture.md`](docs/architecture.md)

## Quick start

Requires Node.js 22+ (for native SQLite).

```bash
npm install
cp .env.example .env    # configure
node server.js          # start the runtime shell
```

The server exposes:

```
POST /webhook/:eventType   → Inbound events (fire-and-forget)
POST /goals                → Assign a goal with steps
GET  /status               → Current goals, progress, recent activations
GET  /health               → Liveness check
```

### Assign a goal

```bash
curl -X POST localhost:3100/goals \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "goal_1",
    "description": "Research competitor pricing",
    "assignedBy": "dan",
    "steps": [
      { "id": "s1", "description": "Search competitors", "skillRequired": "web_research" },
      { "id": "s2", "description": "Compile summary", "skillRequired": "summarise", "dependencies": ["s1"] }
    ]
  }'
```

### Fire an event

```bash
curl -X POST localhost:3100/webhook/task_start \
  -H 'Content-Type: application/json' \
  -d '{ "instruction": "begin pricing research" }'
```

### Run the standalone demo

```bash
npm run demo
```

Runs three scenarios with a mock LLM: event activation, cron activation, and escalation override.

## Wiring up an LLM

The kernel is LLM-agnostic. Replace the stub `reason()` function in `server.js`:

```js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();

async function reason(prompt) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: 'Respond with valid JSON only. No markdown, no preamble.',
    messages: [{ role: 'user', content: prompt }],
  });
  return JSON.parse(msg.content[0].text);
}
```

## File map

```
kernel.js          Core kernel — OODA loop, memory, patterns, escalation, deps
server.js          Runtime shell — Express server, webhook listener, SQLite persistence
store-sqlite.js    SQLite store adapter (Node 22 native, zero deps)
example.js         Standalone demo with mock LLM
docs/
  architecture.md  Full architecture spec
```

## License

MIT
