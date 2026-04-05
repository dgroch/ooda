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
import { AgentKernel, ActivationHarness, MemoryManager, SkillRegistry, ToolRegistry } from './kernel.js';
import { SqliteStore } from './store-sqlite.js';

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
async function reason(prompt) {
  // Placeholder — replace with real LLM call
  const ctx = JSON.parse(prompt);
  console.log(`[llm] ${ctx.phase} phase (stub — wire up your LLM)`);
  return { situationAssessment: 'stub', goalId: null, confidence: 0.5, answers: [], revisedConfidence: 0.5, insights: [] };
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
