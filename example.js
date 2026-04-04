/**
 * Example: Logic Kernel v2 — Full Feature Demo
 *
 * Demonstrates:
 *  1. ActivationHarness — event + cron triggers
 *  2. DependencyResolver — structural step sequencing
 *  3. EscalationEngine — hard rules override LLM
 *  4. Self-interrogation — kernel-generated reflection questions
 *  5. Pattern matching — structural, not LLM-guessed
 */

import {
  AgentKernel,
  ActivationHarness,
  DependencyResolver,
  MemoryManager,
  SkillRegistry,
  ToolRegistry,
  InMemoryStore,
} from './kernel.js';

// ─────────────────────────────────────────────
// 1. LLM ADAPTER (mock — replace with real API)
// ─────────────────────────────────────────────

async function reason(prompt) {
  const ctx = JSON.parse(prompt);

  if (ctx.phase === 'orient') {
    const goal = ctx.observation?.activeGoals?.[0];
    return {
      situationAssessment: `Trigger from ${ctx.observation?.trigger?.source}. Goal: ${goal?.description ?? 'none'}. ${ctx.observation?.matchedPatterns?.length ?? 0} patterns matched.`,
      goalId: goal?.id ?? null,
      knowledgeGaps: [],
      confidence: 0.75,
    };
  }

  if (ctx.phase === 'reflect') {
    return {
      answers: (ctx.questions ?? []).map((q) => ({
        question: q,
        answer: 'Yes, this looks right.',
        adjustConfidence: 0.0,
      })),
      revisedConfidence: 0.75,
      insights: [],
    };
  }

  if (ctx.phase === 'decide') {
    return {
      route: 'self',
      reasoning: `Executing step: ${ctx.nextStep?.description}`,
      action: {
        type: 'execute_skill',
        skillId: ctx.nextStep?.skillRequired,
        toolId: null,
        params: { query: 'competitor flower subscription pricing Melbourne' },
      },
      delegateTo: null,
    };
  }

  if (ctx.phase === 'research') {
    return {
      topic: ctx.plan?.topic ?? 'unknown',
      findings: 'Research complete.',
      confidence: 0.7,
      newSkill: null,
      newPatterns: [],
    };
  }

  return {};
}

// ─────────────────────────────────────────────
// 2. TOOLS + SKILLS
// ─────────────────────────────────────────────

const tools = new ToolRegistry();
tools.register({
  id: 'web_search', name: 'Web Search', description: 'Search the web',
  execute: async (params) => {
    console.log(`    [tool] web_search: "${params.query}"`);
    return { results: [{ title: 'Example', snippet: 'Some data...' }] };
  },
});
tools.register({
  id: 'send_message', name: 'Send Message', description: 'Send to team member',
  execute: async (params) => {
    console.log(`    [tool] send_message → ${params.to}: "${params.content}"`);
    return { sent: true };
  },
});

const skills = new SkillRegistry();
skills.register({
  id: 'web_research', name: 'Web Research',
  description: 'Research a topic via web search',
  triggerConditions: ['research', 'search'],
  execute: async (ctx) => {
    const result = await ctx.tools.execute('web_search', { query: ctx.params.query });
    return { success: true, summary: `Found ${result.results.length} results`, data: result };
  },
});
skills.register({
  id: 'summarise', name: 'Summarise',
  description: 'Compile findings into a summary',
  triggerConditions: ['summarise', 'compile'],
  execute: async (ctx) => {
    return { success: true, summary: 'Competitors: $45–$89/month for weekly subscriptions.' };
  },
});

// ─────────────────────────────────────────────
// 3. MEMORY + SEED DATA
// ─────────────────────────────────────────────

const store = new InMemoryStore();
const memory = new MemoryManager(store);

// Goal with dependency chain: step_2 depends on step_1
await store.set('goals', [{
  id: 'goal_1',
  description: 'Research competitor pricing and produce a summary',
  criteria: [],
  steps: [
    { id: 'step_1', description: 'Search for competitor pricing data', skillRequired: 'web_research', toolsRequired: ['web_search'], dependencies: [], status: 'pending' },
    { id: 'step_2', description: 'Compile findings into summary', skillRequired: 'summarise', toolsRequired: [], dependencies: ['step_1'], status: 'pending' },
  ],
  status: 'active',
  assignedBy: 'human_dan',
}]);

await store.set('team', [
  { id: 'human_dan', name: 'Dan', role: 'human', capabilities: ['strategy', 'review', 'approval'], channel: 'slack' },
  { id: 'agent_bloom', name: 'Bloom', role: 'peer', capabilities: ['seo', 'content'], channel: 'openclaw' },
  { id: 'agent_intern', name: 'Intern', role: 'junior', capabilities: ['data_entry'], channel: 'openclaw' },
]);

// Pattern: tasks from Dan tend to succeed
await store.set('patterns', [{
  id: 'pat_dan_tasks',
  description: 'Tasks assigned by Dan generally succeed',
  conditions: ['goal.assignedBy=human_dan'],
  expectedOutcome: 'success',
  confidence: 0.85,
  occurrences: 12,
}]);

// ─────────────────────────────────────────────
// 4. KERNEL
// ─────────────────────────────────────────────

const kernel = new AgentKernel({
  reason, memory, skills, tools,
  identity: {
    name: 'ResearchAgent',
    role: 'worker',
    description: 'I research topics and produce clear summaries.',
    boundaries: ['Cannot approve budget', 'Cannot publish without review'],
  },
  onPhase: (event) => {
    const badge = {
      observe: '👁 ', orient: '🧭', reflect: '🤔', decide: '⚡', act: '🔨', integrate: '📦',
    }[event.phase] ?? '  ';
    const extra = event.output?.goalComplete ? ' ✅ GOAL COMPLETE' :
                  event.output?.mustEscalate ? ' 🚨 ESCALATING' :
                  event.output?.structuralOverride ? ' ⛔ KERNEL OVERRIDE' : '';
    console.log(`  ${badge} [${event.phase.toUpperCase().padEnd(9)}] cycle=${event.cycle} (${event.durationMs}ms)${extra}`);
  },
  maxCycles: 10,
  confidenceThreshold: 0.4,
  policyBoundaries: ['external_publish'],
});

// ─────────────────────────────────────────────
// 5. DEMO: Dependency Resolver (standalone)
// ─────────────────────────────────────────────

console.log('═══ Demo: Dependency Resolver ═══\n');

const demoSteps = [
  { id: 's1', status: 'done', dependencies: [] },
  { id: 's2', status: 'pending', dependencies: ['s1'] },
  { id: 's3', status: 'pending', dependencies: ['s1', 's2'] },
  { id: 's4', status: 'pending', dependencies: [] },
];

console.log('Steps:', demoSteps.map((s) => `${s.id}(${s.status})`).join(', '));
console.log('Ready:', DependencyResolver.getReady(demoSteps).map((s) => s.id).join(', '));
console.log('Topo order:', DependencyResolver.topoSort(demoSteps).map((s) => s.id).join(' → '));
console.log('Progress:', DependencyResolver.progress(demoSteps));
console.log('s3 blocked?', DependencyResolver.isBlocked(demoSteps[2], demoSteps));
console.log();

// ─────────────────────────────────────────────
// 6. DEMO: Event-triggered activation
// ─────────────────────────────────────────────

console.log('═══ Demo: Event-Triggered Activation ═══\n');

const harness = new ActivationHarness(kernel, {
  onResult: (result, trigger) => {
    console.log(`\n  Result: ${result.status} | ${result.cycles} cycles | progress: ${result.goalProgress}`);
  },
  onError: (err) => console.error('  Error:', err.message),
});

// Register event handler
harness.on('task_assigned', {
  filter: (payload) => payload.assignedTo === 'ResearchAgent',
  transform: (payload) => payload,
});

// Fire event
await harness.emit('task_assigned', {
  assignedTo: 'ResearchAgent',
  instruction: 'Research competitor pricing for flower subscriptions in Melbourne',
}, 'human_dan');

// ─────────────────────────────────────────────
// 7. DEMO: Cron-triggered activation
// ─────────────────────────────────────────────

console.log('\n═══ Demo: Cron-Triggered Activation ═══\n');

// Reset goal to active
await store.set('goals', [{
  id: 'goal_2',
  description: 'Daily progress check',
  criteria: [],
  steps: [
    { id: 'step_check', description: 'Review task queue', skillRequired: 'summarise', toolsRequired: [], dependencies: [], status: 'pending' },
  ],
  status: 'active',
  assignedBy: 'system',
}]);

const cronHarness = new ActivationHarness(kernel, {
  onResult: (result, trigger) => {
    console.log(`\n  Cron result: ${result.status} | source: ${trigger.source}`);
    cronHarness.stop(); // Stop after first run for demo
  },
  onError: (err) => { console.error('  Error:', err.message); cronHarness.stop(); },
});

cronHarness.cron('daily_check', 60000, 'Daily progress check', () => ({
  type: 'progress_review',
}));

cronHarness.start();

// Wait for cron to fire and complete
await new Promise((r) => setTimeout(r, 100));
cronHarness.stop();

// ─────────────────────────────────────────────
// 8. DEMO: Escalation triggered by low confidence
// ─────────────────────────────────────────────

console.log('\n═══ Demo: Escalation (Low Confidence) ═══\n');

// Override reason to return low confidence
const lowConfidenceReason = async (prompt) => {
  const ctx = JSON.parse(prompt);
  if (ctx.phase === 'orient') {
    return {
      situationAssessment: 'I am unsure how to proceed.',
      goalId: 'goal_3',
      knowledgeGaps: [{ topic: 'advanced analytics', severity: 'blocking' }],
      confidence: 0.2,  // Below threshold!
    };
  }
  if (ctx.phase === 'reflect') {
    return {
      answers: [{ question: 'test', answer: 'uncertain', adjustConfidence: -0.1 }],
      revisedConfidence: 0.15,  // Even lower after reflection
      insights: ['I really do not know how to do this'],
    };
  }
  return reason(prompt);  // fallback to normal mock
};

await store.set('goals', [{
  id: 'goal_3',
  description: 'Build analytics dashboard',
  criteria: [],
  steps: [
    { id: 'step_analytics', description: 'Create dashboard', skillRequired: 'analytics', toolsRequired: [], dependencies: [], status: 'pending' },
  ],
  status: 'active',
  assignedBy: 'human_dan',
}]);

const escalationKernel = new AgentKernel({
  reason: lowConfidenceReason,
  memory, skills, tools,
  identity: { name: 'ResearchAgent', role: 'worker' },
  onPhase: (event) => {
    const badge = {
      observe: '👁 ', orient: '🧭', reflect: '🤔', decide: '⚡', act: '🔨', integrate: '📦',
    }[event.phase] ?? '  ';
    const extra = event.output?.structuralOverride ? ' ⛔ KERNEL OVERRIDE → ESCALATE' : '';
    console.log(`  ${badge} [${event.phase.toUpperCase().padEnd(9)}] cycle=${event.cycle}${extra}`);
  },
  maxCycles: 5,
  confidenceThreshold: 0.4,
});

const escalationResult = await escalationKernel.activate({
  mode: 'event', source: 'human_dan', payload: {}, timestamp: new Date().toISOString(),
});

console.log('\n  Escalation result:', JSON.stringify(escalationResult, null, 2));
