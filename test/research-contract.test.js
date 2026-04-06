import test from 'node:test';
import assert from 'node:assert/strict';

import { createGapEvent } from '../gap-classifier.js';
import {
  createResearchObjective,
  validateResearchResult,
  shouldTriggerResearch,
} from '../research-contract.js';
import { AgentKernel, InMemoryStore, MemoryManager, SkillRegistry, ToolRegistry } from '../kernel.js';

function buildGap(gapType = 'knowledge', context = {}) {
  return createGapEvent(
    { gapType, confidence: 0.9, reason: `${gapType} gap` },
    {
      goalId: 'goal_1',
      stepId: 'step_1',
      stepDescription: 'Implement research flow',
      skillRequired: context.skillRequired ?? 'missing_skill',
      toolsRequired: context.toolsRequired ?? [],
      description: context.description ?? 'Gap detected while executing step',
    },
  );
}

test('shouldTriggerResearch: triggers for knowledge/procedural/tool and skips authority/ambiguity', () => {
  assert.equal(shouldTriggerResearch(buildGap('knowledge'), []), true);
  assert.equal(shouldTriggerResearch(buildGap('procedural'), []), true);
  assert.equal(shouldTriggerResearch(buildGap('tool'), []), true);
  assert.equal(shouldTriggerResearch(buildGap('authority'), []), false);
  assert.equal(shouldTriggerResearch(buildGap('ambiguity'), []), false);
});

test('shouldTriggerResearch: does not trigger if already resolved previously', () => {
  const gap = buildGap('knowledge');
  const history = [
    { gapId: gap.id, status: 'partial' },
    { gapId: gap.id, status: 'resolved' },
  ];
  assert.equal(shouldTriggerResearch(gap, history), false);
});

test('createResearchObjective: builds valid objective from gap event', () => {
  const gap = buildGap('procedural', { description: 'Missing procedure for deploys' });
  const goal = { id: 'goal_1', description: 'Ship release' };
  const step = { id: 'step_1', description: 'Deploy to staging', skillRequired: 'deploy_skill' };

  const objective = createResearchObjective(gap, goal, step);
  assert.equal(objective.gapId, gap.id);
  assert.equal(objective.gapType, 'procedural');
  assert.equal(objective.goalId, 'goal_1');
  assert.equal(objective.stepId, 'step_1');
  assert.equal(typeof objective.topic, 'string');
  assert.equal(typeof objective.approach, 'string');
  assert.equal(typeof objective.successCriteria, 'string');
  assert.equal(objective.maxAttempts, 3);
  assert.equal(objective.currentAttempt, 1);
});

test('validateResearchResult: accepts valid payload', () => {
  const validResult = {
    gapId: 'gap_1',
    gapType: 'knowledge',
    status: 'resolved',
    findings: 'Found a reliable approach.',
    confidence: 0.85,
    proposedSkill: {
      id: 'skill_1',
      name: 'Knowledge Skill',
      description: 'Do knowledge work',
      triggerConditions: ['when knowledge gap appears'],
      procedure: ['Collect facts', 'Synthesize answer'],
      requiredTools: [],
      estimatedConfidence: 0.8,
    },
    proposedPattern: {
      id: 'pattern_1',
      description: 'Repeatable scenario',
      conditions: [{ key: 'gapType', eq: 'knowledge' }],
      expectedOutcome: 'Gap resolved faster',
      confidence: 0.7,
    },
    proposedTool: {
      id: 'tool_1',
      name: 'Fetcher',
      description: 'Fetches docs',
      executeTemplate: 'fetch --url {{url}}',
      requiresInstallation: false,
    },
    evidence: ['internal docs', 'recent episode'],
    requiresHumanApproval: false,
  };

  const result = validateResearchResult(validResult);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateResearchResult: rejects missing fields and wrong types', () => {
  const invalid = {
    gapId: 123,
    status: 'done',
    findings: null,
    confidence: 2,
    proposedSkill: 'nope',
    proposedPattern: { id: 'p1' },
    proposedTool: { id: 't1' },
    evidence: ['ok', 1],
    requiresHumanApproval: 'false',
  };

  const result = validateResearchResult(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('schema rejection: invalid LLM output is caught and retried', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);
  const skills = new SkillRegistry();
  const tools = new ToolRegistry();

  const calls = [];
  const reason = async () => {
    calls.push(Date.now());
    if (calls.length === 1) {
      return '{ invalid json';
    }
    return {
      gapId: 'wrong_gap_id',
      gapType: 'knowledge',
      status: 'resolved',
      findings: 'Use deterministic decomposition and checklist.',
      confidence: 0.83,
      proposedSkill: null,
      proposedPattern: null,
      proposedTool: null,
      evidence: ['test evidence'],
      requiresHumanApproval: false,
    };
  };

  const kernel = new AgentKernel({ memory, skills, tools, reason });
  const gap = buildGap('knowledge');

  const result = await kernel._research(
    { id: 'act_test_research' },
    gap,
    { id: 'goal_1', description: 'Goal' },
    { id: 'step_1', description: 'Step' },
  );

  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);

  const history = await memory.getResearchHistory(gap.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 'failed');
  assert.equal(history[1].gapId, gap.id);
});

test('research persistence: saveResearchResult + getResearchHistory', async () => {
  const store = new InMemoryStore();
  const memory = new MemoryManager(store);

  await memory.saveResearchResult({
    gapId: 'gap_a',
    status: 'failed',
    findings: 'attempt one',
  });
  await memory.saveResearchResult({
    gapId: 'gap_b',
    status: 'resolved',
    findings: 'other gap',
  });
  await memory.saveResearchResult({
    gapId: 'gap_a',
    status: 'partial',
    findings: 'attempt two',
  });

  const historyA = await memory.getResearchHistory('gap_a');
  const historyB = await memory.getResearchHistory('gap_b');

  assert.equal(historyA.length, 2);
  assert.equal(historyB.length, 1);
  assert.deepEqual(historyA.map((h) => h.status), ['failed', 'partial']);
});
