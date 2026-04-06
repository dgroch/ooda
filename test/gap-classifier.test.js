import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyGap, createGapEvent } from '../gap-classifier.js';
import { AgentKernel, InMemoryStore, MemoryManager, SkillRegistry, ToolRegistry } from '../kernel.js';

function baseContext(overrides = {}) {
  return {
    goalId: 'goal_1',
    stepId: 'step_1',
    stepDescription: 'Implement API client',
    skillRequired: null,
    toolsRequired: [],
    availableSkills: ['existing-skill'],
    availableTools: ['existing-tool'],
    ...overrides,
  };
}

test('classifyGap: procedural', () => {
  const classification = classifyGap(baseContext({
    skillRequired: 'missing-skill',
    availableSkills: ['existing-skill'],
  }));
  assert.equal(classification.gapType, 'procedural');
});

test('classifyGap: tool', () => {
  const classification = classifyGap(baseContext({
    toolsRequired: ['missing-tool'],
    availableTools: ['existing-tool'],
  }));
  assert.equal(classification.gapType, 'tool');
});

test('classifyGap: authority', () => {
  const classification = classifyGap(baseContext({
    escalationReason: 'Need manager approval before proceeding',
  }));
  assert.equal(classification.gapType, 'authority');
});

test('classifyGap: ambiguity', () => {
  const classification = classifyGap(baseContext({
    stepDescription: 'do it',
  }));
  assert.equal(classification.gapType, 'ambiguity');
});

test('classifyGap: knowledge fallback', () => {
  const classification = classifyGap(baseContext());
  assert.equal(classification.gapType, 'knowledge');
});

test('gap persistence: saveGap + getGapHistory + getGapsByGoal', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);

  const gap1 = createGapEvent(
    { gapType: 'knowledge', confidence: 0.7, reason: 'Need facts' },
    { goalId: 'goal_1', stepId: 'step_a', stepDescription: 'Research facts' },
  );
  const gap2 = createGapEvent(
    { gapType: 'tool', confidence: 0.9, reason: 'Missing scraper tool' },
    { goalId: 'goal_1', stepId: 'step_b', stepDescription: 'Collect web data' },
  );
  const gap3 = createGapEvent(
    { gapType: 'ambiguity', confidence: 0.8, reason: 'Too vague' },
    { goalId: 'goal_2', stepId: 'step_c', stepDescription: 'do it' },
  );

  await memory.saveGap(gap1);
  await memory.saveGap(gap2);
  await memory.saveGap(gap3);

  const stepHistory = await memory.getGapHistory('step_b');
  const goalHistory = await memory.getGapsByGoal('goal_1');

  assert.equal(stepHistory.length, 1);
  assert.equal(stepHistory[0].gapType, 'tool');
  assert.equal(goalHistory.length, 2);
  assert.deepEqual(goalHistory.map((g) => g.stepId).sort(), ['step_a', 'step_b']);
});

test('circuit-open emits tool gap and pauses cleanly', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);
  const skills = new SkillRegistry();
  const tools = new ToolRegistry();

  await memory.upsertGoal({
    id: 'goal_circuit',
    description: 'Handle outage',
    status: 'active',
    priority: 1,
    steps: [
      {
        id: 'step_circuit',
        description: 'Diagnose service outage',
        status: 'pending',
        dependencies: [],
        toolsRequired: ['diag-tool'],
      },
    ],
  });

  const kernel = new AgentKernel({
    memory,
    skills,
    tools,
    reason: async () => ({ ok: true }),
    circuitBreakerThreshold: 1,
  });

  kernel._circuitBreaker.recordFailure();

  const result = await kernel.activate({
    mode: 'event',
    source: 'test',
    eventType: 'manual',
    payload: {},
    timestamp: new Date().toISOString(),
  });

  assert.equal(result.status, 'paused');
  assert.equal(result.reason, 'llm_circuit_open');

  const gapHistory = await memory.getGapsByGoal('goal_circuit');
  assert.equal(gapHistory.length, 1);
  assert.equal(gapHistory[0].gapType, 'tool');
});
