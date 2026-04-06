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

Requires **Node.js 22+** (uses native `node:sqlite`, no separate DB install).

```bash
# 1. Clone
git clone https://github.com/dgroch/ooda.git
cd ooda

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — minimum required:
#   AUTH_TOKEN=<secret>       # Bearer token for all protected endpoints
#   LLM_API_KEY=<key>         # OpenAI or compatible API key
#   LLM_MODEL=gpt-4o-mini     # or your model

# 4. Start
node server.js
# SQLite schema auto-created on first start at ./agent.db
```

### Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_TOKEN` | **Yes** | Bearer token for `/goals`, `/halt`, `/status`, etc. |
| `LLM_API_KEY` | **Yes** | API key for your LLM provider |
| `LLM_BASE_URL` | No | Override LLM endpoint (default: OpenAI) |
| `LLM_MODEL` | No | Model name (default: `gpt-4o-mini`) |
| `WEBHOOK_SECRET` | No | HMAC signing secret for inbound webhooks |
| `PORT` | No | HTTP port (default: `3100`) |
| `DB_PATH` | No | SQLite file path (default: `./agent.db`) |
| `MAX_CYCLES` | No | Safety cap per activation (default: `20`) |
| `OUTBOUND_WEBHOOK_URL` | No | Escalation messages POSTed here |

### Ports

Exposes port `3100` (configurable via `PORT`). **Deploy behind a TLS-terminating reverse proxy** (nginx, Cloudflare, etc.) — the server handles secrets in plaintext and must not be exposed to the internet directly.

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

## Production deployment

For an EC2 handoff runbook and templates, see docs/deploy-ec2.md and files under deploy/.

### System requirements

- **Node.js 22+** (tested on Node 22.x)
- **SQLite** — bundled with Node 22's `node:sqlite`, no separate install
- Linux/Unix — systemd for process management, nginx for TLS/reverse proxy

### Installing Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # should be v22.x
```

### Systemd service

```bash
sudo nano /etc/systemd/system/ooda-agent.service
```

```ini
[Unit]
Description=Logic Kernel Agent
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/ooda
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/ooda/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable ooda-agent
sudo systemctl start ooda-agent
sudo systemctl status ooda-agent
```

### nginx reverse proxy (TLS termination)

```nginx
server {
    listen 443 ssl;
    server_name your-agent.example.com;

    ssl_certificate /etc/ssl/certs/your-agent.crt;
    ssl_certificate_key /etc/ssl/private/your-agent.key;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

### Health monitoring

```bash
# Active health check
curl https://your-agent.example.com/health

# Expected response when healthy:
# {"ok":true,"checks":{"sqlite":true,"llm":true,"webhook":null},"timestamp":"..."}
```

Integrate with Prometheus, Grafana, or your monitoring tool of choice.

### Upgrading

```bash
cd /opt/ooda
git pull origin main
npm install
sudo systemctl restart ooda-agent
```

### Data persistence

- SQLite database at `DB_PATH` (default: `./agent.db`)
- Schema auto-created on first start — no migrations needed
- Set `DB_PATH` to an absolute path on a persistent volume (e.g., `/var/lib/ooda/agent.db`)
- Backup: `cp /var/lib/ooda/agent.db /backup/agent.db.$(date +%Y%m%d)`

## License

MIT
