/**
 * Logic Kernel v2 — Cognitive Architecture for AI Agents
 *
 * A runtime-agnostic OODA-based agent kernel that structures
 * how an AI agent thinks, plans, and acts within a team.
 *
 * v2 closes three gaps from v1:
 *  1. ActivationHarness — event listener + cron scheduler
 *  2. DependencyResolver — structural step sequencing
 *  3. Structural enforcement — escalation, pattern matching,
 *     and self-interrogation are kernel logic, not prompt hopes
 *
 * Zero dependencies. Plug in your own LLM, storage, and tools.
 */

// ─────────────────────────────────────────────
// 1. ACTIVATION HARNESS
//    The ears and clock of the agent.
// ─────────────────────────────────────────────

class ActivationHarness {
  /**
   * @param {AgentKernel} kernel
   * @param {Object} [options]
   * @param {function} [options.onError] - (error, trigger) → void
   * @param {function} [options.onResult] - (result, trigger) → void
   * @param {number} [options.maxConcurrent] - max parallel activations (default: 1)
   */
  constructor(kernel, options = {}) {
    this.kernel = kernel;
    this.onError = options.onError ?? ((err) => console.error('[harness]', err));
    this.onResult = options.onResult ?? (() => {});
    this.maxConcurrent = options.maxConcurrent ?? 1;

    this._eventHandlers = new Map();
    this._cronJobs = [];
    this._activeCount = 0;
    this._queue = [];
    this._running = false;
  }

  /**
   * Register a handler for an event type.
   * @param {string} eventType
   * @param {Object} [options]
   * @param {function} [options.filter] - (payload) → boolean
   * @param {function} [options.transform] - (payload) → transformedPayload
   */
  on(eventType, options = {}) {
    if (!this._eventHandlers.has(eventType)) {
      this._eventHandlers.set(eventType, []);
    }
    this._eventHandlers.get(eventType).push({
      filter: options.filter ?? (() => true),
      transform: options.transform ?? ((p) => p),
    });
    return this;
  }

  /**
   * Emit an inbound event. Matched handlers trigger kernel activation.
   */
  async emit(eventType, payload, source = 'external') {
    const handlers = this._eventHandlers.get(eventType) ?? [];
    for (const handler of handlers) {
      if (!handler.filter(payload)) continue;
      const trigger = {
        mode: 'event',
        source,
        eventType,
        payload: handler.transform(payload),
        timestamp: new Date().toISOString(),
      };
      await this._enqueue(trigger);
    }
  }

  /**
   * Register a recurring cron task.
   * @param {string} id - Unique job ID
   * @param {number} intervalMs - Interval in milliseconds
   * @param {string} label - Human description
   * @param {function} [payloadFn] - () → trigger payload
   */
  cron(id, intervalMs, label, payloadFn = () => ({})) {
    this._cronJobs.push({ id, intervalMs, label, payloadFn, timer: null });
    return this;
  }

  start() {
    if (this._running) return;
    this._running = true;

    for (const job of this._cronJobs) {
      const fire = async () => {
        if (!this._running) return;
        const trigger = {
          mode: 'cron',
          source: `cron:${job.id}`,
          eventType: job.id,
          payload: job.payloadFn(),
          timestamp: new Date().toISOString(),
          cronLabel: job.label,
        };
        await this._enqueue(trigger);
      };
      fire();
      job.timer = setInterval(fire, job.intervalMs);
    }
  }

  stop() {
    this._running = false;
    for (const job of this._cronJobs) {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
    }
  }

  async _enqueue(trigger) {
    if (this._activeCount < this.maxConcurrent) {
      this._activeCount++;
      this._run(trigger).finally(() => {
        this._activeCount--;
        this._processQueue();
      });
    } else {
      this._queue.push(trigger);
    }
  }

  async _run(trigger) {
    try {
      const result = await this.kernel.activate(trigger);
      this.onResult(result, trigger);
    } catch (err) {
      this.onError(err, trigger);
    }
  }

  _processQueue() {
    if (this._queue.length > 0 && this._activeCount < this.maxConcurrent) {
      const next = this._queue.shift();
      this._activeCount++;
      this._run(next).finally(() => {
        this._activeCount--;
        this._processQueue();
      });
    }
  }
}

// ─────────────────────────────────────────────
// 2. DEPENDENCY RESOLVER
//    Structural step sequencing.
// ─────────────────────────────────────────────

class DependencyResolver {
  /**
   * Return steps ready to execute: pending + all deps done.
   */
  static getReady(steps) {
    const statusMap = new Map(steps.map((s) => [s.id, s.status]));
    return steps.filter((s) => {
      if (s.status !== 'pending') return false;
      return (s.dependencies ?? []).every((depId) => statusMap.get(depId) === 'done');
    });
  }

  /**
   * Check if a step is blocked.
   */
  static isBlocked(step, allSteps) {
    const statusMap = new Map(allSteps.map((s) => [s.id, s.status]));
    const waitingOn = (step.dependencies ?? []).filter((depId) => statusMap.get(depId) !== 'done');
    return { blocked: waitingOn.length > 0, waitingOn };
  }

  /**
   * Topological sort. Throws on cycles or orphaned dependencies.
   */
  static topoSort(steps) {
    const graph = new Map(steps.map((s) => [s.id, s]));
    const visited = new Set();
    const visiting = new Set();
    const sorted = [];

    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Dependency cycle at step: ${id}`);
      if (!graph.has(id)) throw new Error(`Orphaned dependency: step references "${id}" which does not exist`);
      visiting.add(id);
      const step = graph.get(id);
      if (step) {
        for (const depId of step.dependencies ?? []) visit(depId);
      }
      visiting.delete(id);
      visited.add(id);
      if (step) sorted.push(step);
    };

    for (const s of steps) visit(s.id);
    return sorted;
  }

  /**
   * Validate step definitions. Returns { valid, errors }.
   */
  static validate(steps) {
    const errors = [];
    const ids = new Set(steps.map((s) => s.id));
    for (const s of steps) {
      for (const dep of s.dependencies ?? []) {
        if (!ids.has(dep)) {
          errors.push(`Step "${s.id}" depends on "${dep}" which does not exist`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Progress metrics.
   */
  static progress(steps) {
    const done = steps.filter((s) => s.status === 'done').length;
    const blocked = steps.filter((s) => s.status === 'blocked').length;
    return { progress: steps.length ? done / steps.length : 0, done, total: steps.length, blocked };
  }
}

// ─────────────────────────────────────────────
// 3. PATTERN MATCHER
//    Structural condition evaluation.
// ─────────────────────────────────────────────

class PatternMatcher {
  /**
   * Evaluate patterns against flat state.
   * Conditions: "key=value", "key!=value", "key>value", "key<value",
   *             "key:contains:value", "key:exists"
   */
  static match(patterns, state) {
    const matched = [];
    const predictions = [];

    for (const pattern of patterns) {
      if (!pattern.conditions?.length) continue;
      const conditionsMet = pattern.conditions.every((cond) =>
        PatternMatcher._evalCondition(cond, state),
      );
      if (conditionsMet) {
        matched.push(pattern);
        predictions.push({
          id: `pred_${pattern.id}_${Date.now()}`,
          patternId: pattern.id,
          description: pattern.description,
          expected: pattern.expectedOutcome,
          confidence: pattern.confidence,
        });
      }
    }

    return { matched, predictions };
  }

  static _evalCondition(condition, state) {
    // ── OR / NOT wrappers ──────────────────────────────
    if (condition.type === 'or') {
      return (condition.conditions ?? []).some((c) =>
        PatternMatcher._evalCondition(c, state),
      );
    }
    if (condition.type === 'not') {
      return !PatternMatcher._evalCondition(condition.condition, state);
    }

    // ── String condition ───────────────────────────────
    const cond = condition.condition ?? condition;

    // exists:key  (prefix form — unambiguous over key names)
    if (cond.startsWith('exists:')) {
      const key = cond.slice(7);
      return key in state && state[key] !== undefined && state[key] !== null;
    }

    // key:contains:value
    if (cond.includes(':contains:')) {
      const parts = cond.split(':contains:');
      const key = parts[0];
      const value = parts.slice(1).join(':contains:'); // allow :contains: in value
      const stateVal = state[key];
      if (Array.isArray(stateVal)) return stateVal.includes(value);
      if (typeof stateVal === 'string') return stateVal.includes(value);
      return false;
    }

    // Operators
    const ops = ['>=', '<=', '!=', '>', '<', '='];
    for (const op of ops) {
      const idx = cond.indexOf(op);
      if (idx === -1) continue;

      const key = cond.slice(0, idx).trim();
      const rawValue = cond.slice(idx + op.length).trim();
      const stateVal = state[key];
      if (stateVal === undefined) return false;

      const numState = Number(stateVal);
      const numExpected = Number(rawValue);
      const bothNumeric = !isNaN(numState) && !isNaN(numExpected);

      switch (op) {
        case '=':  return bothNumeric ? numState === numExpected : String(stateVal) === rawValue;
        case '!=': return bothNumeric ? numState !== numExpected : String(stateVal) !== rawValue;
        case '>':  return bothNumeric && numState > numExpected;
        case '<':  return bothNumeric && numState < numExpected;
        case '>=': return bothNumeric && numState >= numExpected;
        case '<=': return bothNumeric && numState <= numExpected;
      }
      break;
    }
    return false;
  }

  static updateConfidence(pattern, predictionCorrect, alpha = 0.2) {
    pattern.occurrences++;
    pattern.confidence = pattern.confidence * (1 - alpha) + (predictionCorrect ? 1 : 0) * alpha;
    return pattern;
  }
}

// ─────────────────────────────────────────────
// 4. ESCALATION ENGINE
//    Hard rules the LLM cannot override.
// ─────────────────────────────────────────────

class EscalationEngine {
  constructor(config = {}) {
    this.confidenceThreshold = config.confidenceThreshold ?? 0.4;
    this.maxBlockedCycles = config.maxBlockedCycles ?? 3;
    this.policyBoundaries = config.policyBoundaries ?? [
      'budget_approval', 'external_publish', 'data_deletion', 'access_grant',
    ];
  }

  /**
   * Returns { mustEscalate, reason, suggestedTarget }.
   * Runs BEFORE the LLM's decide — can override it.
   */
  evaluate(context) {
    if (context.confidence < this.confidenceThreshold) {
      return {
        mustEscalate: true,
        reason: `Confidence ${context.confidence.toFixed(2)} below threshold ${this.confidenceThreshold}`,
        suggestedTarget: this._findSenior(context.team),
      };
    }

    if (context.actionType && this.policyBoundaries.includes(context.actionType)) {
      return {
        mustEscalate: true,
        reason: `Action "${context.actionType}" requires approval`,
        suggestedTarget: this._findHuman(context.team),
      };
    }

    if (!context.hasRequiredSkill && context.researchFailed) {
      return {
        mustEscalate: true,
        reason: 'Missing required skill and self-research failed',
        suggestedTarget: this._findPeerOrSenior(context.team),
      };
    }

    if (context.cyclesOnCurrentStep && context.cyclesOnCurrentStep >= this.maxBlockedCycles) {
      return {
        mustEscalate: true,
        reason: `Stuck on current step for ${context.cyclesOnCurrentStep} cycles`,
        suggestedTarget: this._findSenior(context.team),
      };
    }

    if (context.blockedSteps?.length > 0) {
      const pendingNonBlocked = context.totalSteps - context.blockedSteps.length - (context.doneSteps ?? 0);
      if (pendingNonBlocked <= 0) {
        return {
          mustEscalate: true,
          reason: 'All remaining steps are blocked',
          suggestedTarget: this._findSenior(context.team),
        };
      }
    }

    return { mustEscalate: false, reason: null, suggestedTarget: null };
  }

  _findHuman(team)        { return team?.find((m) => m.role === 'human')?.id ?? null; }
  _findSenior(team)       { return team?.find((m) => m.role === 'senior')?.id ?? this._findHuman(team); }
  _findPeerOrSenior(team) { return team?.find((m) => m.role === 'peer')?.id ?? this._findSenior(team); }
}

// ─────────────────────────────────────────────
// 5. MEMORY MANAGER
// ─────────────────────────────────────────────

class MemoryManager {
  constructor(store) {
    this.store = store;
    this.working = {};
  }

  setWorking(key, value) { this.working[key] = value; }
  getWorking(key) { return this.working[key] ?? null; }
  clearWorking() { this.working = {}; }

  async recordEpisode(episode) {
    const episodes = (await this.store.get('episodes')) ?? [];
    episodes.push({ ...episode, timestamp: new Date().toISOString() });
    if (episodes.length > 200) episodes.splice(0, episodes.length - 200);
    await this.store.set('episodes', episodes);
  }

  async getRecentEpisodes(n = 20) {
    const episodes = (await this.store.get('episodes')) ?? [];
    return episodes.slice(-n);
  }

  async queryEpisodes(filter) {
    const episodes = (await this.store.get('episodes')) ?? [];
    return episodes.filter(filter);
  }

  async getSkills()     { return (await this.store.get('skills')) ?? []; }
  async getPatterns()   { return (await this.store.get('patterns')) ?? []; }
  async getKnowledge()  { return (await this.store.get('knowledge')) ?? []; }
  async getTeamRoster() { return (await this.store.get('team')) ?? []; }
  async getGoals()      { return (await this.store.get('goals')) ?? []; }

  async addSkill(skill) {
    const items = await this.getSkills();
    items.push(skill);
    await this.store.set('skills', items);
  }

  async upsertPattern(pattern) {
    const items = await this.getPatterns();
    const idx = items.findIndex((p) => p.id === pattern.id);
    if (idx >= 0) items[idx] = pattern; else items.push(pattern);
    await this.store.set('patterns', items);
  }

  async addKnowledge(entry) {
    const items = await this.getKnowledge();
    items.push({ ...entry, learnedAt: new Date().toISOString() });
    // Evict lowest-confidence entries when we exceed 1000
    if (items.length > 1000) {
      items.sort((a, b) => (a.confidence ?? 0.5) - (b.confidence ?? 0.5));
      items.splice(0, items.length - 1000);
    }
    await this.store.set('knowledge', items);
  }

  async upsertGoal(goal) {
    const items = await this.getGoals();
    const idx = items.findIndex((g) => g.id === goal.id);
    if (idx >= 0) items[idx] = goal; else items.push(goal);
    await this.store.set('goals', items);
  }

  async getPendingMessages(toAgent) {
    if (!this.store.getPendingMessages) return [];
    return this.store.getPendingMessages(toAgent);
  }

  async acknowledgeMessage(msgId) {
    if (!this.store.acknowledgeMessage) return null;
    return this.store.acknowledgeMessage(msgId);
  }

  async getMessage(msgId) {
    if (!this.store.getMessage) return null;
    return this.store.getMessage(msgId);
  }
}

// ─────────────────────────────────────────────
// 6. SKILL REGISTRY
// ─────────────────────────────────────────────

class SkillRegistry {
  constructor() { this.skills = new Map(); }
  register(skill) { this.skills.set(skill.id, skill); }
  find(skillId) { return this.skills.get(skillId) ?? null; }
  has(skillId) { return this.skills.has(skillId); }
  list() {
    return [...this.skills.values()].map((s) => ({ id: s.id, name: s.name, description: s.description }));
  }
}

// ─────────────────────────────────────────────
// 7. TOOL REGISTRY
// ─────────────────────────────────────────────

class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(tool) { this.tools.set(tool.id, tool); }
  get(toolId) { return this.tools.get(toolId) ?? null; }
  has(toolId) { return this.tools.has(toolId); }
  async execute(toolId, params) {
    const tool = this.tools.get(toolId);
    if (!tool) throw new Error(`Tool not found: ${toolId}`);
    return tool.execute(params);
  }
  list() {
    return [...this.tools.values()].map((t) => ({ id: t.id, name: t.name, description: t.description }));
  }
}

// ─────────────────────────────────────────────
// 7b. ACTION VALIDATOR
//    Validates LLM output before it reaches _act().
//    This is the gate between "LLM recommends" and "kernel executes".
// ─────────────────────────────────────────────

const VALID_ACTION_TYPES = new Set(['execute_skill', 'use_tool', 'research', 'communicate', 'wait']);

class ActionValidator {
  /**
   * @param {Object} registries
   * @param {SkillRegistry} registries.skills
   * @param {ToolRegistry} registries.tools
   * @param {Array|Function} registries.team - array or async () => team[]
   */
  constructor(registries) {
    this.skills = registries.skills;
    this.tools = registries.tools;
    this._teamGetter = Array.isArray(registries.team) ? () => Promise.resolve(registries.team) : registries.team;
  }

  async _getTeam() {
    return this._teamGetter ? await this._teamGetter() : [];
  }

  /**
   * Validate an action returned by the LLM's decide phase.
   * Returns { valid: boolean, error?: string }
   */
  async validate(action, route = 'self') {
    if (!action || typeof action !== 'object') {
      return { valid: false, error: 'Action is not an object' };
    }

    // 1. Action type must be a known type
    if (!action.type || !VALID_ACTION_TYPES.has(action.type)) {
      return {
        valid: false,
        error: `Unknown action type "${action.type}". Must be one of: ${[...VALID_ACTION_TYPES].join(', ')}`,
      };
    }

    // 2. execute_skill must reference a registered skill
    if (action.type === 'execute_skill') {
      if (!action.skillId) return { valid: false, error: 'execute_skill requires skillId' };
      if (!this.skills.has(action.skillId)) {
        return { valid: false, error: `Skill "${action.skillId}" is not registered` };
      }
    }

    // 3. use_tool must reference a registered tool
    if (action.type === 'use_tool') {
      if (!action.toolId) return { valid: false, error: 'use_tool requires toolId' };
      if (!this.tools.has(action.toolId)) {
        return { valid: false, error: `Tool "${action.toolId}" is not registered` };
      }
    }

    // 4. communicate must have a valid message
    if (action.type === 'communicate') {
      if (!action.message) return { valid: false, error: 'communicate requires message object' };
      if (!action.message.content) return { valid: false, error: 'communicate.message.content is required' };
    }

    // 5. delegate route must target a valid team member
    if (route === 'delegate') {
      const target = action.delegateTo;
      if (!target) return { valid: false, error: 'Delegate route requires delegateTo' };
      const team = await this._getTeam();
      if (!team.find((m) => m.id === target)) {
        return { valid: false, error: `Delegate target "${target}" is not in the team roster` };
      }
    }

    return { valid: true };
  }
}

// ─────────────────────────────────────────────
// 8. THE KERNEL
// ─────────────────────────────────────────────

class AgentKernel {
  constructor(config) {
    this.reason = config.reason;
    this.memory = config.memory;
    this.skills = config.skills;
    this.tools = config.tools;
    this.identity = config.identity ?? { name: 'Agent', role: 'worker' };
    this.onPhase = config.onPhase ?? (() => {});
    this.maxCycles = config.maxCycles ?? 20;

    this.escalation = new EscalationEngine({
      confidenceThreshold: config.confidenceThreshold ?? 0.4,
      policyBoundaries: config.policyBoundaries ?? [],
    });

    // Action validation: pluggable, defaults to built-in
    // Pass a team-getter so validation can check delegation targets against live roster
    const teamGetter = () => this.memory.getTeamRoster ? this.memory.getTeamRoster() : Promise.resolve([]);
    const defaultValidator = new ActionValidator({ skills: this.skills, tools: this.tools, team: teamGetter });
    this.validator = config.validator ?? defaultValidator;

    this._cycleCount = 0;
    this._activationId = null;
    this._stepCycleCounts = new Map();

    // Metrics
    this._metrics = {
      totalActivations: 0,
      totalCycles: 0,
      totalEscalations: 0,
      totalGoalCompletes: 0,
      _cycleDurations: [], // rolling window for avg
    };
  }

  getMetrics() {
    const durations = this._metrics._cycleDurations;
    const avgCycleDuration = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    return {
      totalActivations: this._metrics.totalActivations,
      totalCycles: this._metrics.totalCycles,
      avgCycleDurationMs: Math.round(avgCycleDuration),
      totalEscalations: this._metrics.totalEscalations,
      totalGoalCompletes: this._metrics.totalGoalCompletes,
    };
  }

  _recordMetrics(result, totalDurationMs) {
    this._metrics.totalActivations++;
    this._metrics.totalCycles += result.cycles ?? 0;
    if (result.status === 'complete') this._metrics.totalGoalCompletes++;
    this._metrics._cycleDurations.push(totalDurationMs);
    if (this._metrics._cycleDurations.length > 100) {
      this._metrics._cycleDurations.shift(); // keep rolling window at 100
    }
  }

  // ── Public API ──

  async activate(trigger) {
    const t0 = Date.now();
    this._activationId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._cycleCount = 0;
    this._stepCycleCounts.clear();
    this.memory.clearWorking();
    this.memory.setWorking('trigger', trigger);
    this.memory.setWorking('activationId', this._activationId);
    this.memory.setWorking('researchFailed', false); // reset per-activation
    const result = await this._cycle(trigger);
    this._recordMetrics(result, Date.now() - t0);
    return result;
  }

  // ── OODA + Reflect Cycle ──

  async _cycle(trigger) {
    this._cycleCount++;
    if (this._cycleCount > this.maxCycles) {
      return { status: 'halted', reason: 'max_cycles_exceeded', cycles: this._cycleCount };
    }

    const observed  = await this._observe(trigger);
    const oriented  = await this._orient(observed);
    const reflected = await this._reflect(oriented);
    const decided   = await this._decide(reflected);
    const acted     = await this._act(decided);
    const integration = await this._integrate(acted, reflected);

    if (integration.continue) {
      return this._cycle({
        mode: 'continuation',
        source: 'kernel',
        payload: integration.nextContext,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: integration.goalComplete ? 'complete' : 'paused',
      cycles: this._cycleCount,
      result: acted.result?.outcome,
      goalProgress: integration.progress,
    };
  }

  // ── Phase 1: OBSERVE ──

  async _observe(trigger) {
    const t0 = Date.now();
    const [goals, episodes, patterns, knowledge, team] = await Promise.all([
      this.memory.getGoals(),
      this.memory.getRecentEpisodes(10),
      this.memory.getPatterns(),
      this.memory.getKnowledge(),
      this.memory.getTeamRoster(),
    ]);

    const activeGoals = goals.filter((g) => g.status === 'active' || g.status === 'pending');
    const flatState = this._buildFlatState(trigger, activeGoals, episodes);

    // Structural pattern matching — kernel logic, not LLM
    const { matched: matchedPatterns, predictions } = PatternMatcher.match(patterns, flatState);

    const observation = {
      trigger, activeGoals, recentEpisodes: episodes,
      matchedPatterns, predictions,
      availableSkills: this.skills.list(),
      availableTools: this.tools.list(),
      storedKnowledge: knowledge, team, flatState,
    };

    this._emit('observe', trigger, observation, Date.now() - t0);
    return observation;
  }

  // ── Phase 2: ORIENT ──

  async _orient(observation) {
    const t0 = Date.now();

    const orientation = await this.reason(
      this._buildPrompt('orient', {
        identity: this.identity,
        observation: {
          trigger: observation.trigger,
          activeGoals: observation.activeGoals,
          recentEpisodes: observation.recentEpisodes,
          matchedPatterns: observation.matchedPatterns,
          predictions: observation.predictions,
          storedKnowledge: observation.storedKnowledge,
          team: observation.team,
        },
        instructions: `ORIENT phase. The kernel has already pattern-matched for you.

Respond with JSON:
{
  "situationAssessment": "One clear paragraph",
  "goalId": "ID of the goal to focus on, or null",
  "knowledgeGaps": [ { "topic": "...", "severity": "blocking|degrading|nice-to-have" } ],
  "confidence": 0.0-1.0
}

Do NOT decompose goals into steps — the kernel handles sequencing.
Do NOT decide on actions — that happens in DECIDE.`,
      }),
    );

    this.memory.setWorking('orientation', orientation);
    this._emit('orient', observation, orientation, Date.now() - t0);
    return { ...observation, orientation };
  }

  // ── Phase 2.5: REFLECT (Self-Interrogation) ──

  async _reflect(oriented) {
    const t0 = Date.now();

    const goal = oriented.activeGoals?.find((g) => g.id === oriented.orientation?.goalId);
    const steps = goal?.steps ?? [];
    const readySteps = DependencyResolver.getReady(steps);
    const blockedSteps = steps.filter(
      (s) => s.status === 'pending' && DependencyResolver.isBlocked(s, steps).blocked,
    );

    // Kernel generates the questions — deterministic, not LLM
    const questions = this._generateReflectionQuestions(oriented, goal, readySteps, blockedSteps);

    const reflection = await this.reason(
      this._buildPrompt('reflect', {
        identity: this.identity,
        orientation: oriented.orientation,
        questions,
        goalContext: goal ? {
          id: goal.id,
          description: goal.description,
          readySteps: readySteps.map((s) => ({ id: s.id, description: s.description, skillRequired: s.skillRequired })),
          blockedSteps: blockedSteps.map((s) => ({
            id: s.id, description: s.description,
            waitingOn: DependencyResolver.isBlocked(s, steps).waitingOn,
          })),
          progress: DependencyResolver.progress(steps),
        } : null,
        instructions: `REFLECT phase — private self-interrogation.
Answer each question honestly and concisely.

Respond with JSON:
{
  "answers": [ { "question": "...", "answer": "...", "adjustConfidence": 0.0 } ],
  "revisedConfidence": 0.0-1.0,
  "insights": ["Any new realisations"]
}`,
      }),
    );

    this.memory.setWorking('reflection', reflection);
    this._emit('reflect', { questions }, reflection, Date.now() - t0);

    return { ...oriented, reflection, resolvedGoal: goal, readySteps, blockedSteps };
  }

  _generateReflectionQuestions(oriented, goal, readySteps, blockedSteps) {
    const questions = [];

    questions.push('Am I working on the highest-priority goal right now?');

    if (goal) {
      questions.push(`Do I understand what "done" looks like for "${goal.description}"?`);

      if (readySteps.length > 1) {
        questions.push(`I have ${readySteps.length} steps ready — which should I do first and why?`);
      }

      if (readySteps.length === 0 && blockedSteps.length > 0) {
        questions.push('All my next steps are blocked. Can I unblock any, or do I need help?');
      }

      for (const step of readySteps) {
        if (step.skillRequired && !oriented.availableSkills?.find((s) => s.id === step.skillRequired)) {
          questions.push(`Step "${step.description}" needs skill "${step.skillRequired}" which I don't have. Should I research it or escalate?`);
        }
      }
    }

    if (oriented.predictions?.length > 0) {
      questions.push('My pattern engine made predictions — do they seem reasonable?');
    }

    const blockingGaps = oriented.orientation?.knowledgeGaps?.filter((g) => g.severity === 'blocking') ?? [];
    if (blockingGaps.length > 0) {
      questions.push(`I have ${blockingGaps.length} blocking knowledge gap(s). Can I resolve them with available tools?`);
    }

    if ((oriented.orientation?.confidence ?? 1) < 0.6) {
      questions.push('My confidence is low. What specifically am I uncertain about?');
    }

    return questions;
  }

  // ── Phase 3: DECIDE ──

  async _decide(reflected) {
    const t0 = Date.now();
    const goal = reflected.resolvedGoal;
    const readySteps = reflected.readySteps ?? [];
    const blockedSteps = reflected.blockedSteps ?? [];
    const confidence = reflected.reflection?.revisedConfidence ?? reflected.orientation?.confidence ?? 0.5;

    const nextStep = readySteps[0] ?? null;
    const hasRequiredSkill = nextStep ? this.skills.has(nextStep.skillRequired) : true;

    // Track cycles per step
    if (nextStep) {
      const count = (this._stepCycleCounts.get(nextStep.id) ?? 0) + 1;
      this._stepCycleCounts.set(nextStep.id, count);
    }

    // ── STRUCTURAL ESCALATION (before LLM) ──
    const escalationVerdict = this.escalation.evaluate({
      confidence,
      actionType: nextStep?.skillRequired,
      hasRequiredSkill,
      researchFailed: this.memory.getWorking('researchFailed') === true,
      blockedSteps,
      totalSteps: goal?.steps?.length ?? 0,
      doneSteps: (goal?.steps ?? []).filter((s) => s.status === 'done').length,
      cyclesOnCurrentStep: nextStep ? (this._stepCycleCounts.get(nextStep.id) ?? 0) : 0,
      team: reflected.team,
    });

    if (escalationVerdict.mustEscalate) {
      this._metrics.totalEscalations++;
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const pendingMessage = {
        id: msgId,
        from: this.identity.name,
        to: escalationVerdict.suggestedTarget,
        content: `I need help. ${escalationVerdict.reason}`,
        goalId: goal?.id ?? null,
        stepId: nextStep?.id ?? null,
        status: 'pending',
        metadata: {
          reason: escalationVerdict.reason,
          confidence,
          cyclesOnCurrentStep: nextStep ? (this._stepCycleCounts.get(nextStep.id) ?? 0) : 0,
        },
      };
      // Persist the pending message so a human can respond and resume this goal
      if (this.memory.store?.saveMessage) {
        await this.memory.store.saveMessage(pendingMessage);
      }
      const decision = {
        route: 'escalate',
        reasoning: escalationVerdict.reason,
        action: {
          type: 'communicate',
          message: pendingMessage,
        },
        nextStepId: nextStep?.id,
        structuralOverride: true,
      };
      this._emit('decide', { escalationVerdict }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    // ── NO READY STEPS ──
    if (!nextStep) {
      const decision = {
        route: 'self',
        reasoning: 'No ready steps available',
        action: { type: 'wait' },
        nextStepId: null,
      };
      this._emit('decide', { readySteps: [] }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    // ── SKILL GAP → research ──
    if (!hasRequiredSkill) {
      const decision = {
        route: 'self',
        reasoning: `Missing skill "${nextStep.skillRequired}" — entering research mode`,
        action: { type: 'research' },
        researchPlan: {
          topic: nextStep.skillRequired,
          approach: `Learn how to ${nextStep.description}`,
          stepId: nextStep.id,
        },
        nextStepId: nextStep.id,
      };
      this._emit('decide', { skillGap: nextStep.skillRequired }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    // ── DELEGATION CHECK (structural) ──
    const delegationTarget = this._checkDelegation(nextStep, reflected.team);

    // ── LLM DECIDE — within guardrails ──
    const llmDecision = await this.reason(
      this._buildPrompt('decide', {
        identity: this.identity,
        orientation: reflected.orientation,
        reflection: reflected.reflection,
        nextStep: {
          id: nextStep.id, description: nextStep.description,
          skillRequired: nextStep.skillRequired, toolsRequired: nextStep.toolsRequired,
        },
        delegationOption: delegationTarget ? { id: delegationTarget.id, name: delegationTarget.name } : null,
        instructions: `DECIDE phase. The kernel has already:
- Resolved dependencies (this step is ready)
- Checked escalation rules (no escalation needed)
- Identified the next step

Decide HOW to execute. Respond with JSON:
{
  "route": "self|delegate",
  "reasoning": "One sentence",
  "action": {
    "type": "execute_skill|use_tool",
    "skillId": "${nextStep.skillRequired}",
    "toolId": null,
    "params": {}
  },
  "delegateTo": null
}${delegationTarget ? `\n\nA junior "${delegationTarget.name}" can handle "${nextStep.skillRequired}". Consider delegating.` : ''}`,
      }),
    );

    // ── ACTION VALIDATION — kernel gate before execution ──
    const route = llmDecision.route ?? 'self';
    const action = llmDecision.action ?? {};
    const validation = await this.validator.validate(action, route);
    if (!validation.valid) {
      // Log the rejection and emit a failure — do NOT execute
      const decision = {
        route: 'self',
        reasoning: `Action rejected by validator: ${validation.error}`,
        action: { type: 'wait' }, // safe fallback
        nextStepId: nextStep?.id,
        structuralOverride: false,
        validationFailed: true,
        validationError: validation.error,
      };
      this._emit('decide', { nextStep, llmDecision, validationError: validation.error }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    const decision = { ...llmDecision, nextStepId: nextStep.id, structuralOverride: false };
    this._emit('decide', { nextStep, escalationVerdict }, decision, Date.now() - t0);
    return { ...reflected, decision };
  }

  _checkDelegation(step, team) {
    if (!team?.length || !step.skillRequired) return null;
    return team.find((m) => m.role === 'junior' && m.capabilities?.includes(step.skillRequired)) ?? null;
  }

  // ── Phase 4: ACT ──

  async _act(decided) {
    const t0 = Date.now();
    const action = decided.decision?.action;
    if (!action) {
      const result = { action: null, outcome: { success: false, error: 'No action defined' } };
      this._emit('act', null, result, Date.now() - t0);
      return { ...decided, result };
    }

    let outcome;
    try {
      switch (action.type) {
        case 'execute_skill': {
          const skill = this.skills.find(action.skillId);
          if (!skill) {
            outcome = { success: false, error: `Skill not found: ${action.skillId}`, needsResearch: true };
            break;
          }
          outcome = await skill.execute({
            params: action.params ?? {},
            tools: this.tools,
            memory: this.memory,
            reason: this.reason,
          });
          break;
        }
        case 'use_tool': {
          const result = await this.tools.execute(action.toolId, action.params ?? {});
          outcome = { success: true, toolResult: result };
          break;
        }
        case 'research': {
          outcome = await this._research(decided.decision.researchPlan);
          if (!outcome.success) this.memory.setWorking('researchFailed', true);
          break;
        }
        case 'communicate': {
          outcome = {
            success: true, type: 'communication',
            message: action.message,
            awaitingResponse: decided.decision.route === 'escalate',
          };
          break;
        }
        case 'wait': {
          outcome = { success: true, type: 'wait', reason: 'No actionable steps' };
          break;
        }
        default:
          outcome = { success: false, error: `Unknown action type: ${action.type}` };
      }
    } catch (err) {
      outcome = { success: false, error: err.message, stack: err.stack };
    }

    const result = { action, outcome };
    this.memory.setWorking('lastResult', result);
    this._emit('act', decided.decision, result, Date.now() - t0);
    return { ...decided, result };
  }

  // ── Phase 5: INTEGRATE ──

  async _integrate(acted, reflected) {
    const t0 = Date.now();
    const goalId = reflected.orientation?.goalId;

    // 1. Record episode
    await this.memory.recordEpisode({
      activationId: this._activationId,
      cycle: this._cycleCount,
      trigger: acted.trigger,
      goalId,
      action: acted.result?.action,
      outcome: acted.result?.outcome,
      predictions: reflected.predictions ?? [],
    });

    // 2. Update pattern confidence
    if (reflected.predictions?.length) {
      for (const pred of reflected.predictions) {
        const patterns = await this.memory.getPatterns();
        const pattern = patterns.find((p) => p.id === pred.patternId);
        if (pattern) {
          const correct = acted.result?.outcome?.success === (pred.expected === 'success');
          PatternMatcher.updateConfidence(pattern, correct);
          await this.memory.upsertPattern(pattern);
        }
      }
    }

    // 3. Update goal/step status — structurally
    let goalComplete = false;
    let progress = 0;

    if (goalId) {
      const goals = await this.memory.getGoals();
      const goal = goals.find((g) => g.id === goalId);

      if (goal) {
        const steps = goal.steps ?? [];

        // Mark completed step — only for actual execution, not comms/wait/research
        const actionType = acted.result?.action?.type;
        const isExecution = actionType === 'execute_skill' || actionType === 'use_tool';
        if (isExecution && acted.result?.outcome?.success && acted.decision?.nextStepId) {
          const step = steps.find((s) => s.id === acted.decision.nextStepId);
          if (step && step.status !== 'done') step.status = 'done';
        }

        // Structural: update blocked/unblocked status
        for (const step of steps) {
          if (step.status === 'pending') {
            if (DependencyResolver.isBlocked(step, steps).blocked) step.status = 'blocked';
          }
          if (step.status === 'blocked') {
            if (!DependencyResolver.isBlocked(step, steps).blocked) step.status = 'pending';
          }
        }

        // Check acceptance criteria
        if (goal.criteria?.length) {
          const checks = await Promise.all(
            goal.criteria.map(async (c) => {
              try { return await c.check(this.memory.working); }
              catch { return { met: false, evidence: 'Check failed' }; }
            }),
          );
          goalComplete = checks.every((c) => c.met);
          progress = checks.filter((c) => c.met).length / checks.length;
          if (goalComplete) goal.status = 'done';
        }

        // Step-based progress as fallback
        if (!goal.criteria?.length && steps.length) {
          const prog = DependencyResolver.progress(steps);
          progress = prog.progress;
          goalComplete = progress >= 1;
          if (goalComplete) goal.status = 'done';
        }

        await this.memory.upsertGoal(goal);
      }
    }

    const shouldContinue =
      !goalComplete &&
      acted.result?.outcome?.success &&
      acted.result?.action?.type !== 'communicate' &&
      acted.result?.action?.type !== 'wait';

    const integration = {
      continue: shouldContinue,
      goalComplete,
      progress,
      nextContext: shouldContinue ? acted.result.outcome : null,
    };

    this._emit('integrate', acted.result, integration, Date.now() - t0);
    return integration;
  }

  // ── Research ──

  async _research(plan) {
    if (!plan) return { success: false, error: 'No research plan' };

    const findings = await this.reason(
      this._buildPrompt('research', {
        identity: this.identity, plan,
        availableTools: this.tools.list(),
        instructions: `RESEARCH mode. Respond with JSON:
{
  "topic": "...",
  "findings": "Clear, actionable summary",
  "confidence": 0.0-1.0,
  "newSkill": null or { "id": "...", "name": "...", "description": "...", "triggerConditions": [...], "requiredTools": [...] },
  "newPatterns": [ { "id": "...", "description": "...", "conditions": [...], "expectedOutcome": "...", "confidence": 0.5, "occurrences": 1 } ]
}`,
      }),
    );

    await this.memory.addKnowledge({ topic: findings.topic, content: findings.findings, confidence: findings.confidence, source: 'self-research' });
    if (findings.newPatterns) for (const p of findings.newPatterns) await this.memory.upsertPattern(p);
    if (findings.newSkill) await this.memory.addSkill(findings.newSkill);

    return { success: true, type: 'research', findings };
  }

  // ── Helpers ──

  _buildFlatState(trigger, activeGoals, episodes) {
    const state = {
      'trigger.mode': trigger.mode,
      'trigger.source': trigger.source,
      'trigger.eventType': trigger.eventType ?? '',
      'goals.active.count': String(activeGoals.length),
      'episodes.recent.count': String(episodes.length),
    };

    if (trigger.payload && typeof trigger.payload === 'object') {
      for (const [k, v] of Object.entries(trigger.payload)) {
        state[`trigger.payload.${k}`] = String(v);
      }
    }

    if (activeGoals.length > 0) {
      const goal = activeGoals[0];
      state['goal.id'] = goal.id;
      state['goal.status'] = goal.status;
      state['goal.assignedBy'] = goal.assignedBy ?? '';
      if (goal.steps) {
        const prog = DependencyResolver.progress(goal.steps);
        state['goal.progress'] = String(prog.progress.toFixed(2));
        state['goal.steps.done'] = String(prog.done);
        state['goal.steps.total'] = String(prog.total);
        state['goal.steps.blocked'] = String(prog.blocked);
      }
    }

    if (episodes.length > 0) {
      const last = episodes[episodes.length - 1];
      state['last.outcome.success'] = String(last.outcome?.success ?? false);
    }

    return state;
  }

  _buildPrompt(phase, context) {
    return JSON.stringify({
      phase,
      activationId: this._activationId,
      agentIdentity: context.identity,
      ...context,
    });
  }

  _emit(phase, input, output, durationMs) {
    this.onPhase({
      phase, activationId: this._activationId, cycle: this._cycleCount,
      timestamp: new Date().toISOString(), durationMs, input, output,
    });
  }
}

// ─────────────────────────────────────────────
// 9. IN-MEMORY STORE
// ─────────────────────────────────────────────

class InMemoryStore {
  constructor() { this.data = new Map(); }
  async get(key) {
    const val = this.data.get(key);
    return val !== undefined ? JSON.parse(JSON.stringify(val)) : null;
  }
  async set(key, value) { this.data.set(key, JSON.parse(JSON.stringify(value))); }
  async delete(key) { this.data.delete(key); }
  async list(prefix) { return [...this.data.keys()].filter((k) => k.startsWith(prefix ?? '')); }
}

// ─────────────────────────────────────────────
// 10. EXPORTS
// ─────────────────────────────────────────────

export {
  AgentKernel,
  ActivationHarness,
  DependencyResolver,
  PatternMatcher,
  EscalationEngine,
  MemoryManager,
  SkillRegistry,
  ToolRegistry,
  ActionValidator,
  InMemoryStore,
};
