import test from 'node:test';
import assert from 'node:assert/strict';

import { createCapabilityAcquiredEvent } from '../acquisition.js';
import { AgentKernel, InMemoryStore, MemoryManager, SkillRegistry, ToolRegistry } from '../kernel.js';
import { buildRetryContext, recordRetryOutcome, shouldRetry } from '../retry-on-learn.js';

function makeGoal(stepStatus = 'blocked') {
  return {
    id: 'goal_1',
    description: 'Ship retry-on-learn',
    status: 'active',
    steps: [
      {
        id: 'step_1',
        description: 'Implement feature',
        status: stepStatus,
        dependencies: [],
        skillRequired: 'skill_new',
      },
    ],
  };
}

function makeGap(overrides = {}) {
  return {
    id: 'gap_1',
    goalId: 'goal_1',
    stepId: 'step_1',
    gapType: 'procedural',
    description: 'Missing required skill skill_new',
    reason: 'Missing required skill',
    skillRequired: 'skill_new',
    toolsRequired: [],
    ...overrides,
  };
}

test('shouldRetry: allows retry for pending/blocked steps when under limit and capability matches', () => {
  const gap = makeGap();
  const event = createCapabilityAcquiredEvent('skill', { id: 'skill_new', name: 'Skill New' }, gap);

  const blockedVerdict = shouldRetry({ ...event, retryCount: 0 }, makeGoal('blocked'), [gap]);
  const pendingVerdict = shouldRetry({ ...event, retryCount: 1 }, makeGoal('pending'), [gap]);

  assert.equal(blockedVerdict.retry, true);
  assert.equal(pendingVerdict.retry, true);
});

test('shouldRetry: rejects when step is done, retry limit exceeded, or capability mismatches gap', () => {
  const gap = makeGap();
  const event = createCapabilityAcquiredEvent('skill', { id: 'skill_new', name: 'Skill New' }, gap);

  const doneVerdict = shouldRetry({ ...event, retryCount: 0 }, makeGoal('done'), [gap]);
  assert.equal(doneVerdict.retry, false);

  const overLimitVerdict = shouldRetry({ ...event, retryCount: 2 }, makeGoal('blocked'), [gap]);
  assert.equal(overLimitVerdict.retry, false);

  const mismatchEvent = createCapabilityAcquiredEvent('skill', { id: 'skill_other', name: 'Other Skill' }, gap);
  const mismatchVerdict = shouldRetry({ ...mismatchEvent, retryCount: 0 }, makeGoal('blocked'), [gap]);
  assert.equal(mismatchVerdict.retry, false);
});

test('buildRetryContext: produces enriched context and instruction string', () => {
  const gap = makeGap({ gapType: 'knowledge', description: 'Need OAuth flow knowledge' });
  const event = createCapabilityAcquiredEvent('skill', {
    id: 'skill_oauth',
    name: 'OAuth Skill',
    description: 'Implements OAuth flow',
  }, gap);

  const ctx = buildRetryContext(event, gap, { error: 'Auth failed', actionType: 'execute_skill' });

  assert.equal(ctx.acquiredCapability.type, 'skill');
  assert.equal(ctx.acquiredCapability.id, 'skill_oauth');
  assert.equal(ctx.previousGap.gapType, 'knowledge');
  assert.equal(ctx.previousFailure.error, 'Auth failed');
  assert.match(ctx.instruction, /You previously failed because Need OAuth flow knowledge/);
  assert.match(ctx.instruction, /You have now acquired OAuth Skill/);
});

test('recordRetryOutcome: success resolves gap and increases skill confidence', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);

  const gap = makeGap();
  await memory.saveGap(gap);
  await memory.addSkill({ id: 'skill_new', name: 'Skill New', confidence: 0.5 });
  await memory.incrementRetryCount('step_1');

  const event = createCapabilityAcquiredEvent('skill', { id: 'skill_new', name: 'Skill New' }, gap);
  const result = await recordRetryOutcome({ success: true }, gap, event, memory);

  assert.equal(result.success, true);
  assert.equal(result.escalated, false);

  const gapHistory = await memory.getGapHistory('step_1');
  assert.equal(gapHistory[gapHistory.length - 1].status, 'resolved');

  const updatedSkill = (await memory.getSkills()).find((s) => s.id === 'skill_new');
  assert.equal(updatedSkill.confidence, 0.6);

  const retryCount = await memory.getRetryCount('step_1');
  assert.equal(retryCount, 0);
});

test('recordRetryOutcome: failure persists gap, decreases confidence, and returns escalation flag at limit', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);

  const gap = makeGap();
  await memory.saveGap(gap);
  await memory.addSkill({ id: 'skill_new', name: 'Skill New', confidence: 0.7 });
  await memory.incrementRetryCount('step_1');
  await memory.incrementRetryCount('step_1');

  const event = createCapabilityAcquiredEvent('skill', { id: 'skill_new', name: 'Skill New' }, gap);
  const result = await recordRetryOutcome({ success: false, error: 'Still failing' }, gap, event, memory);

  assert.equal(result.success, false);
  assert.equal(result.escalated, true);

  const gapHistory = await memory.getGapHistory('step_1');
  assert.equal(gapHistory[gapHistory.length - 1].status, 'persistent');

  const updatedSkill = (await memory.getSkills()).find((s) => s.id === 'skill_new');
  assert.equal(updatedSkill.confidence, 0.6);
});

test('retry count tracking: increment, query, reset', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);

  assert.equal(await memory.getRetryCount('step_1'), 0);
  assert.equal(await memory.incrementRetryCount('step_1'), 1);
  assert.equal(await memory.incrementRetryCount('step_1'), 2);
  assert.equal(await memory.getRetryCount('step_1'), 2);
  assert.equal(await memory.resetRetryCount('step_1'), 0);
  assert.equal(await memory.getRetryCount('step_1'), 0);
});

test('integration: acquisition event triggers retry and re-queues blocked step', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);
  const skills = new SkillRegistry();
  const tools = new ToolRegistry();

  const goal = makeGoal('blocked');
  await memory.upsertGoal(goal);

  const gap = makeGap();
  await memory.saveGap(gap);

  const kernel = new AgentKernel({
    memory,
    skills,
    tools,
    reason: async () => ({ ok: true }),
  });

  const event = createCapabilityAcquiredEvent('skill', { id: 'skill_new', name: 'Skill New' }, gap);
  const activation = {
    stepCycleCounts: new Map([['step_1', 4]]),
    working: {},
  };

  const triggerResult = await kernel._triggerRetryOnLearn(activation, event);
  assert.equal(triggerResult.triggered, true);

  const goals = await memory.getGoals();
  const updatedGoal = goals.find((g) => g.id === 'goal_1');
  const step = updatedGoal.steps.find((s) => s.id === 'step_1');
  assert.equal(step.status, 'pending');
  assert.equal(activation.stepCycleCounts.has('step_1'), false);
  assert.equal(activation.working.retryContext.acquiredCapability.id, 'skill_new');
  assert.equal(await memory.getRetryCount('step_1'), 1);
});
