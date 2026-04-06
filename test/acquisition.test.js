import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCapabilityAcquiredEvent,
  executeAcquiredSkill,
  sandboxTest,
  validateProposedPattern,
  validateProposedSkill,
  validateProposedTool,
} from '../acquisition.js';
import { InMemoryStore, MemoryManager } from '../kernel.js';

test('validateProposedSkill: valid skill passes', () => {
  const skill = {
    id: 'skill_new',
    description: 'A self-acquired process',
    triggerConditions: ['when this scenario appears'],
    procedure: ['step one', 'step two'],
    requiredTools: ['tool_a'],
  };
  const result = validateProposedSkill(skill, {
    has: (id) => id === 'skill_existing',
    hasTool: (id) => id === 'tool_a',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateProposedSkill: missing procedure and duplicate id fails', () => {
  const invalid = {
    id: 'skill_dup',
    description: 'desc',
    triggerConditions: ['condition'],
    procedure: [],
    requiredTools: [],
  };
  const result = validateProposedSkill(invalid, {
    has: (id) => id === 'skill_dup',
    hasTool: () => true,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('already exists')));
  assert.ok(result.errors.some((e) => e.includes('procedure')));
});

test('validateProposedPattern: valid passes, invalid fails', () => {
  const valid = validateProposedPattern(
    {
      id: 'pattern_1',
      conditions: [{ key: 'x', eq: '1' }],
      expectedOutcome: 'Faster completion',
      confidence: 0.7,
    },
    { has: () => false },
  );
  assert.equal(valid.valid, true);

  const invalid = validateProposedPattern(
    {
      id: 'pattern_1',
      conditions: [],
      expectedOutcome: '',
      confidence: 2,
    },
    { has: () => true },
  );
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length >= 3);
});

test('validateProposedTool: valid passes and requiresInstallation flags approval', () => {
  const valid = validateProposedTool(
    {
      id: 'tool_safe',
      executeTemplate: 'run --task {{task}}',
      requiresInstallation: false,
    },
    { has: () => false },
  );
  assert.equal(valid.valid, true);
  assert.equal(valid.requiresApproval, false);

  const approval = validateProposedTool(
    {
      id: 'tool_install',
      executeTemplate: 'installer {{target}}',
      requiresInstallation: true,
    },
    { has: () => false },
  );
  assert.equal(approval.valid, true);
  assert.equal(approval.requiresApproval, true);
});

test('sandboxTest: pass and fail cases', async () => {
  const skill = {
    id: 'skill_sandbox',
    description: 'desc',
    triggerConditions: ['cond'],
    procedure: ['a', 'b'],
  };
  const pass = await sandboxTest(skill, { id: 'goal_1' }, { id: 'step_1' }, async () => ({
    predictedOutcome: 'works',
    confidence: 0.8,
    satisfactory: true,
  }));
  assert.deepEqual(pass, { passed: true });

  const fail = await sandboxTest(skill, { id: 'goal_1' }, { id: 'step_1' }, async () => ({
    predictedOutcome: 'unclear',
    confidence: 0.2,
    satisfactory: false,
    reason: 'low certainty',
  }));
  assert.equal(fail.passed, false);
  assert.equal(fail.reason, 'low certainty');
});

test('createCapabilityAcquiredEvent: all expected fields are present', () => {
  const capability = { id: 'skill_new', name: 'New Skill' };
  const event = createCapabilityAcquiredEvent('skill', capability, {
    id: 'gap_1',
    goalId: 'goal_1',
    stepId: 'step_1',
    gapType: 'knowledge',
  });

  assert.equal(typeof event.id, 'string');
  assert.equal(event.type, 'skill');
  assert.equal(event.capabilityType, 'skill');
  assert.equal(event.capabilityId, 'skill_new');
  assert.equal(event.source, 'self-acquired');
  assert.equal(event.gapContext.gapId, 'gap_1');
  assert.equal(event.gapContext.goalId, 'goal_1');
  assert.equal(typeof event.timestamp, 'string');
});

test('acquisition persistence: save + query', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);

  const event1 = createCapabilityAcquiredEvent('skill', { id: 's1' }, { goalId: 'goal_1', stepId: 'a' });
  const event2 = createCapabilityAcquiredEvent('pattern', { id: 'p1' }, { goalId: 'goal_2', stepId: 'b' });

  await memory.saveAcquisitionEvent(event1);
  await memory.saveAcquisitionEvent(event2);

  const goal1 = await memory.getAcquisitionHistory('goal_1');
  const goal2 = await memory.getAcquisitionHistory('goal_2');

  assert.equal(goal1.length, 1);
  assert.equal(goal1[0].capabilityId, 's1');
  assert.equal(goal2.length, 1);
  assert.equal(goal2[0].capabilityId, 'p1');
});

test('executeAcquiredSkill: returns structured result', async () => {
  const result = await executeAcquiredSkill(
    {
      id: 'skill_exec',
      description: 'exec',
      triggerConditions: ['cond'],
      procedure: ['step a', 'step b'],
    },
    {
      goal: { id: 'goal_1', description: 'Ship feature' },
      step: { id: 'step_1', description: 'Implement code' },
      reason: async () => ({
        summary: 'Implemented the target behavior.',
        artifact: { filesChanged: 2 },
        confidence: 0.78,
        notes: ['validated in sandbox'],
      }),
    },
  );

  assert.equal(result.summary, 'Implemented the target behavior.');
  assert.deepEqual(result.artifact, { filesChanged: 2 });
  assert.equal(result.confidence, 0.78);
  assert.deepEqual(result.notes, ['validated in sandbox']);
});
