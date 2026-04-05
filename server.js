/**
 * Runtime Shell — The thin layer between the kernel and the real world.
 *
 * ~150 lines. Provides:
 *  - HTTP webhook listener for inbound events
 *  - Cron scheduling via the ActivationHarness
 *  - Goal assignment endpoint
 *  - Agent status endpoint
 *  - Outbound communication hook (escalation → Slack, webhook, etc.)
 *  - SQLite persistence
 *
 * Configure via environment variables:
 *   PORT=3100              HTTP port (default: 3100)
 *   AUTH_TOKEN=secret       Bearer token for webhook auth (optional)
 *   DB_PATH=./agent.db      SQLite file path
 *   OUTBOUND_WEBHOOK_URL=   URL to POST escalation/communication messages
 *   AGENT_NAME=Agent        Agent identity name
 *   AGENT_ROLE=worker       Agent identity role
 *   CONFIDENCE_THRESHOLD=0.4
 *   MAX_CYCLES=20
 *
 * Usage:
 *   node server.js
 */

import express from 'express';
import { createHmac } from 'crypto';
import { AgentKernel, ActivationHarness, MemoryManager, SkillRegistry, ToolRegistry } from './kernel.js';
import { SqliteStore } from './store-sqlite.js';

// ─────────────────────────────────────────────
// HTTPS Requirement (enforce in production)
// ─────────────────────────────────────────────
// This server handles authentication secrets (WEBHOOK_SECRET) in plaintext.
// Deploy behind a TLS-terminating reverse proxy (nginx, cloud LB) to ensure
// X-Hub-Signature-256 headers and auth tokens are not transmitted in the clear.

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const config = {
  port: parseInt(process.env.PORT ?? '3100'),
  authToken: process.env.AUTH_TOKEN ?? null,
  dbPath: process.env.DB_PATH ?? './agent.db',
  outboundWebhookUrl: process.env.OUTBOUND_WEBHOOK_URL ?? null,
  agentName: process.env.AGENT_NAME ?? 'Agent',
  agentRole: process.env.AGENT_ROLE ?? 'worker',
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.4'),
  maxCycles: parseInt(process.env.MAX_CYCLES ?? '20'),
  webhookSecret: process.env.WEBHOOK_SECRET ?? null,
  webhookSecretOld: process.env.WEBHOOK_SECRET_OLD ?? null,
};

// ─────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────

const store = new SqliteStore(config.dbPath);
const memory = new MemoryManager(store);

// ─────────────────────────────────────────────
// Registries (register your skills + tools here)
// ─────────────────────────────────────────────

const skills = new SkillRegistry();
const tools = new ToolRegistry();

// Built-in: outbound communication tool
tools.register({
  id: 'send_message',
  name: 'Send Message',
  description: 'Send a message to a team member or channel',
  execute: async (params) => {
    console.log(`[comms] → ${params.to}: ${params.content}`);

    // Forward to outbound webhook if configured
    if (config.outboundWebhookUrl) {
      try {
        await fetch(config.outboundWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'agent_message',
            from: config.agentName,
            to: params.to,
            content: params.content,
            goalId: params.goalId,
            stepId: params.stepId,
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.error('[comms] Outbound webhook failed:', err.message);
      }
    }

    return { sent: true, to: params.to };
  },
});

// ─────────────────────────────────────────────
// Kernel
// ─────────────────────────────────────────────

/**
 * Wire in your LLM here. The kernel passes a JSON string
 * and expects structured JSON back.
 *
 * Replace this with:
 *   import Anthropic from '@anthropic-ai/sdk';
 *   const client = new Anthropic();
 *   async function reason(prompt) {
 *     const msg = await client.messages.create({
 *       model: 'claude-sonnet-4-20250514',
 *       max_tokens: 4096,
 *       system: 'Respond with valid JSON only. No markdown, no preamble.',
 *       messages: [{ role: 'user', content: prompt }],
 *     });
 *     return JSON.parse(msg.content[0].text);
 *   }
 */

// ─────────────────────────────────────────────
// LLM Configuration
// ─────────────────────────────────────────────

const llmConfig = {
  baseUrl:         process.env.LLM_BASE_URL         ?? 'https://api.openai.com/v1',
  apiKey:          process.env.LLM_API_KEY          ?? null,
  model:           process.env.LLM_MODEL            ?? 'gpt-4o-mini',
  maxRetries:      parseInt(process.env.LLM_RETRY_MAX     ?? '3'),
  baseRetryDelayMs: parseInt(process.env.LLM_RETRY_DELAY ?? '1000'),
  maxRetryDelayMs:  parseInt(process.env.LLM_MAX_DELAY    ?? '10000'),
  timeoutMs:       parseInt(process.env.LLM_TIMEOUT_MS    ?? '30000'),
  maxTokens:       parseInt(process.env.LLM_MAX_TOKENS    ?? '4096'),
};

/**
 * Retry with exponential backoff + jitter.
 */
async function withRetry(fn) {
  let lastError;
  for (let attempt = 0; attempt <= llmConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err.status === 429) {
        // Respect Retry-After header, or use exponential backoff
        const retryAfter = err.headers?.['retry-after'];
        let delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : Math.min(llmConfig.baseRetryDelayMs * 2 ** attempt, llmConfig.maxRetryDelayMs);
        // Add jitter ±25%
        delay = delay * (0.75 + Math.random() * 0.5);
        console.warn(`[llm] Rate limited. Retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${llmConfig.maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      // Non-retryable error — fail immediately
      if (attempt === 0) throw err;
    }
  }
  throw lastError;
}

/**
 * Parse JSON from LLM response, handling common malformations:
 * - Markdown code fences (```json ... ```)
 * - Trailing commas
 * - Single-quoted strings
 */
function parseLlmJson(raw) {
  let text = typeof raw === 'string' ? raw : String(raw);
  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Remove trailing commas before closing braces/brackets
  text = text.replace(/,(\s*[}\]])/g, '$1');
  // Replace single-quoted strings with double-quoted (simple cases only)
  // Only replace when inside JSON values, not when part of a contraction
  text = text.replace(/'/g, '"');
  try {
    return JSON.parse(text);
  } catch {
    // Last resort: find the first { or [ and parse from there
    const start = text.search(/[[{]/);
    if (start >= 0) {
      try { return JSON.parse(text.slice(start)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Production-grade reason() function.
 * Calls the configured LLM with timeout, retry, JSON recovery, and structured output.
 */
async function reason(prompt) {
  // If no API key is configured, fall back to stub
  if (!llmConfig.apiKey) {
    const ctx = JSON.parse(prompt);
    console.log(`[llm] ${ctx.phase ?? '?'} phase (stub — set LLM_API_KEY to enable)`);
    return {
      situationAssessment: 'stub',
      goalId: null,
      confidence: 0.5,
      answers: [],
      revisedConfidence: 0.5,
      insights: [],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), llmConfig.timeoutMs);

  try {
    const result = await withRetry(async () => {
      const response = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model,
          max_tokens: llmConfig.maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'Respond with valid JSON only. No markdown, no preamble, no commentary.',
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`LLM API error ${response.status}: ${body}`);
        err.status = response.status;
        err.headers = { 'retry-after': response.headers.get('retry-after') };
        throw err;
      }

      return response.json();
    });

    clearTimeout(timeout);
    const raw = result.choices?.[0]?.message?.content ?? '';
    const parsed = parseLlmJson(raw);

    if (!parsed) {
      console.error('[llm] Failed to parse LLM response as JSON:', raw.slice(0, 200));
      throw new Error(`LLM returned unparseable response: ${raw.slice(0, 100)}`);
    }

    return parsed;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`LLM call timed out after ${llmConfig.timeoutMs}ms`);
    }
    throw err;
  }
}

const kernel = new AgentKernel({
  reason,
  memory,
  skills,
  tools,
  identity: {
    name: config.agentName,
    role: config.agentRole,
  },
  onPhase: (event) => {
    const override = event.output?.structuralOverride ? ' ⛔ OVERRIDE' : '';
    const complete = event.output?.goalComplete ? ' ✅ DONE' : '';
    console.log(`[kernel] ${event.phase.padEnd(9)} cycle=${event.cycle} (${event.durationMs}ms)${override}${complete}`);
  },
  maxCycles: config.maxCycles,
  confidenceThreshold: config.confidenceThreshold,
});

// ─────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────

const harness = new ActivationHarness(kernel, {
  onResult: (result, trigger) => {
    console.log(`[harness] Activation complete: ${result.status} (${result.cycles} cycles, progress: ${result.goalProgress})`);
  },
  onError: (err, trigger) => {
    console.error(`[harness] Activation failed:`, err.message);
  },
  maxConcurrent: 1,
});

// Default: accept all events via webhook
// Add filtered handlers for specific event types:
//   harness.on('shopify_order', { filter: (p) => p.topic === 'orders/create' });
//   harness.on('slack_message', { filter: (p) => p.channel === '#agent' });

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// In-memory rate limiter (60 req/min per IP)
// ─────────────────────────────────────────────
const rateLimiter = (() => {
  const windows = new Map();
  return (key, max = 60, windowMs = 60000) => {
    const now = Date.now();
    if (!windows.has(key)) windows.set(key, []);
    const times = windows.get(key).filter((t) => now - t < windowMs);
    windows.set(key, times);
    if (times.length >= max) return false;
    times.push(now);
    return true;
  };
})();

// ─────────────────────────────────────────────
// HMAC Signature Verification
// ─────────────────────────────────────────────
function verifyWebhookSignature(req, secret) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
  return sig === expected;
}

const app = express();
app.use(express.json());

// Auth middleware (optional)
const auth = (req, res, next) => {
  if (!config.authToken) return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== config.authToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── POST /webhook/:eventType ──
// Inbound events from the outside world.
// Fire-and-forget: responds immediately, activation runs async.
app.post('/webhook/:eventType', auth, (req, res) => {
  const { eventType } = req.params;
  const source = req.headers['x-source'] ?? req.ip;

  // Rate limiting (60 req/min per IP)
  if (!rateLimiter(req.ip, 60, 60000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // HMAC signature verification (supports rotation via WEBHOOK_SECRET_OLD)
  if (config.webhookSecret || config.webhookSecretOld) {
    const validNew = config.webhookSecret && verifyWebhookSignature(req, config.webhookSecret);
    const validOld = config.webhookSecretOld && verifyWebhookSignature(req, config.webhookSecretOld);
    if (!validNew && !validOld) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Dynamically register handler if not already registered
  if (!harness._eventHandlers.has(eventType)) {
    harness.on(eventType);
  }

  // Respond immediately — activation runs in background
  res.json({ accepted: true, eventType });

  harness.emit(eventType, req.body, source).catch((err) => {
    console.error(`[webhook] Error processing ${eventType}:`, err.message);
  });
});

// ── POST /goals ──
// Assign a goal to the agent.
app.post('/goals', auth, async (req, res) => {
  const { id, description, steps, criteria, assignedBy } = req.body;

  if (!id || !description) {
    return res.status(400).json({ error: 'id and description required' });
  }

  const goal = {
    id,
    description,
    steps: (steps ?? []).map((s, i) => ({
      id: s.id ?? `step_${i + 1}`,
      description: s.description,
      skillRequired: s.skillRequired ?? '',
      toolsRequired: s.toolsRequired ?? [],
      dependencies: s.dependencies ?? [],
      status: 'pending',
    })),
    criteria: criteria ?? [],
    status: 'active',
    assignedBy: assignedBy ?? 'api',
  };

  await memory.upsertGoal(goal);
  console.log(`[goals] Assigned: "${description}" (${goal.steps.length} steps)`);

  res.json({ created: true, goal: { id: goal.id, steps: goal.steps.length } });
});

// ── GET /status ──
// Current agent state.
app.get('/status', async (req, res) => {
  const goals = await memory.getGoals();
  const episodes = await memory.getRecentEpisodes(5);
  const patterns = await memory.getPatterns();
  const pendingMessages = await memory.getPendingMessages(config.agentName);

  res.json({
    agent: config.agentName,
    role: config.agentRole,
    goals: goals.map((g) => ({
      id: g.id,
      description: g.description,
      status: g.status,
      stepsTotal: g.steps?.length ?? 0,
      stepsDone: g.steps?.filter((s) => s.status === 'done').length ?? 0,
    })),
    recentActivations: episodes.slice(-3).map((e) => ({
      cycle: e.cycle,
      goalId: e.goalId,
      success: e.outcome?.success,
      timestamp: e.timestamp,
    })),
    patternsTracked: patterns.length,
    pendingMessages: pendingMessages.map((m) => ({
      id: m.id,
      from: m.from,
      content: m.content,
      goalId: m.goal_id,
      stepId: m.step_id,
      timestamp: m.created_at,
      metadata: m.metadata,
    })),
  });
});

// ── GET /health ──
app.get('/health', (req, res) => {
  res.json({ ok: true, agent: config.agentName, uptime: process.uptime() });
});

// ── GET /metrics ──
// Agent metrics for monitoring.
app.get('/metrics', auth, async (req, res) => {
  const goals = await memory.getGoals();
  res.json({
    ...kernel.getMetrics(),
    activeGoals: goals.filter((g) => g.status === 'active' || g.status === 'pending').length,
  });
});

// ── GET /messages ──
// List pending messages for the agent (human or operator can poll this).
app.get('/messages', auth, async (req, res) => {
  const toAgent = req.query.to ?? config.agentName;
  const messages = await memory.getPendingMessages(toAgent);
  res.json({ messages });
});

// ── POST /messages/:messageId/ack ──
// Acknowledge a pending message and resume the stalled goal.
app.post('/messages/:messageId/ack', auth, async (req, res) => {
  const { messageId } = req.params;
  const { response } = req.body ?? {};

  const message = await memory.getMessage(messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.status === 'acknowledged') return res.status(409).json({ error: 'Already acknowledged' });

  // Acknowledge the message
  await memory.acknowledgeMessage(messageId);

  // Re-activate the stalled goal if one was attached
  if (message.goal_id) {
    const goals = await memory.getGoals();
    const goal = goals.find((g) => g.id === message.goal_id);
    if (goal) {
      // Clear the blocked flag on the step so the goal can proceed
      const step = goal.steps?.find((s) => s.id === message.step_id);
      if (step && step.status === 'blocked') step.status = 'pending';
      await memory.upsertGoal(goal);

      // Fire a resume trigger — the harness will pick it up
      await harness.emit('goal_resume', {
        messageId,
        response: response ?? '',
        goalId: message.goal_id,
        stepId: message.step_id,
      }, `human:${message.from}`);
    }
  }

  res.json({ acknowledged: true, messageId, goalId: message.goal_id });
});

// ── GET /circuit-status ──
// Returns current circuit breaker state.
app.get('/circuit-status', auth, (req, res) => {
  res.json(kernel.getCircuitStatus());
});

// ── POST /halt ──
// Authenticated kill switch — stops the harness and clears the queue.
// Uses WEBHOOK_SECRET as bearer token.
const haltAuth = (req, res, next) => {
  const secret = config.webhookSecret;
  if (!secret) return next();
  const token = req.headers['authorization']?.replace('Bearer ', '') ?? '';
  if (token !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.post('/halt', haltAuth, (req, res) => {
  console.log('[halt] Received authenticated halt request');
  harness.stop();
  harness._queue = [];
  res.json({ halted: true, agent: config.agentName });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`
┌─────────────────────────────────────────┐
│  ${config.agentName} Runtime Shell                  
│  Port: ${config.port}                              
│  Store: ${config.dbPath}                       
│  Auth: ${config.authToken ? 'enabled' : 'disabled (set AUTH_TOKEN)'}          
│  Outbound: ${config.outboundWebhookUrl ?? 'disabled (set OUTBOUND_WEBHOOK_URL)'}
└─────────────────────────────────────────┘

Endpoints:
  POST /webhook/:eventType   Inbound events
  POST /goals                Assign a goal
  GET  /status               Agent state
  GET  /health               Liveness check

Waiting for events...
`);

  // Start cron harness (register your cron jobs before this)
  // Example:
  //   harness.cron('daily_review', 86400000, 'Daily progress check');
  harness.start();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Stopping...');
  harness.stop();
  store.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  harness.stop();
  store.close();
  process.exit(0);
});
