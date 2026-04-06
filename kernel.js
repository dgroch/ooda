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

import { classifyGap, createGapEvent } from './gap-classifier.js';
import {
  createResearchObjective,
  validateResearchResult,
  shouldTriggerResearch,
} from './research-contract.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  createCapabilityAcquiredEvent,
  executeAcquiredSkill,
  sandboxTest,
  validateProposedPattern,
  validateProposedSkill,
  validateProposedTool,
} from './acquisition.js';

function parseLlmJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  let text = typeof raw === 'string' ? raw : String(raw ?? '');
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  text = text.replace(/,(\s*[}\]])/g, '$1');
  text = text.replace(/'/g, '"');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start >= 0) {
      try { return JSON.parse(text.slice(start)); } catch { /* noop */ }
    }
    return null;
  }
}

// ─────────────────────────────────────────────
// 1. ACTIVATION HARNESS
//    The ears and clock of the agent.
// ─────────────────────────────────────────────

class ActivationHarness {
  static MAX_EVENT_TYPES = 50;

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
    this._stopped = false;
  }

  /**
   * Register a handler for an event type.
   * @param {string} eventType
   * @param {Object} [options]
   * @param {function} [options.filter] - (payload) → boolean
   * @param {function} [options.transform] - (payload) → transformedPayload
   */
  on(eventType, options = {}) {
    if (!this._eventHandlers.has(eventType) && this._eventHandlers.size >= ActivationHarness.MAX_EVENT_TYPES) {
      throw new Error(`Maximum event types reached (${ActivationHarness.MAX_EVENT_TYPES})`);
    }
    if (!this._eventHandlers.has(eventType)) {
      this._eventHandlers.set(eventType, []);
    }
    this._eventHandlers.get(eventType).push({
      filter: options.filter ?? (() => true),
      transform: options.transform ?? ((p) => p),
    });
    return this;
  }

  registerEventType(eventType, options = {}) {
    return this.on(eventType, options);
  }

  hasEventType(eventType) {
    return this._eventHandlers.has(eventType);
  }

  /**
   * Emit an inbound event. Matched handlers trigger kernel activation.
   */
  async emit(eventType, payload, source = 'external') {
    if (this._stopped) throw this._stoppedError();
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
    this._stopped = false;
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
    this._stopped = true;
    for (const job of this._cronJobs) {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
    }
  }

  stopAndClear() {
    this.stop();
    this._queue = [];
  }

  clearQueue() {
    this._queue = [];
  }

  async _enqueue(trigger) {
    if (this._stopped) throw this._stoppedError();
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
      if (err?.code === 'HARNESS_STOPPED') {
        console.warn('[harness] Ignored trigger after stop');
        return;
      }
      this.onError(err, trigger);
    }
  }

  _processQueue() {
    if (this._stopped) return;
    if (this._queue.length > 0 && this._activeCount < this.maxConcurrent) {
      const next = this._queue.shift();
      this._activeCount++;
      this._run(next).finally(() => {
        this._activeCount--;
        this._processQueue();
      });
    }
  }

  _stoppedError() {
    const err = new Error('Activation harness is stopped');
    err.code = 'HARNESS_STOPPED';
    return err;
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

class GoalCriterion {
  static evaluate(criterion, context) {
    const type = criterion?.type ?? 'state_compare';
    if (type === 'completion') return true;

    if (type === 'step_done') {
      if (!criterion.stepId) return false;
      const steps = context.goal?.steps ?? [];
      return steps.some((s) => s.id === criterion.stepId && s.status === 'done');
    }

    if (type === 'pattern_matched') {
      if (!criterion.patternId) return false;
      const matches = context.matchedPatterns ?? [];
      return matches.some((p) => p.id === criterion.patternId);
    }

    const keyPath = criterion.keyPath ?? criterion.path;
    const operator = criterion.operator ?? 'eq';
    const expected = criterion.value;
    if (!keyPath) return false;
    const actual = GoalCriterion._getByPath(context.workingState ?? {}, keyPath);
    return GoalCriterion._compare(actual, expected, operator);
  }

  static _getByPath(obj, keyPath) {
    return keyPath.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
  }

  static _compare(actual, expected, operator) {
    switch (operator) {
      case 'eq': return actual === expected;
      case 'neq': return actual !== expected;
      case 'gt': return Number(actual) > Number(expected);
      case 'gte': return Number(actual) >= Number(expected);
      case 'lt': return Number(actual) < Number(expected);
      case 'lte': return Number(actual) <= Number(expected);
      case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected ?? ''));
      case 'exists': return actual !== undefined && actual !== null;
      default: return false;
    }
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
    this._listeners = new Map();
  }

  setWorking(key, value) { this.working[key] = value; }
  getWorking(key) { return this.working[key] ?? null; }
  clearWorking() { this.working = {}; }

  on(eventType, handler) {
    if (!this._listeners.has(eventType)) this._listeners.set(eventType, []);
    this._listeners.get(eventType).push(handler);
    return this;
  }

  emit(eventType, ...args) {
    const handlers = this._listeners.get(eventType) ?? [];
    for (const h of handlers) h(...args);
  }

  async recordEpisode(episode) {
    const id = episode.id ?? `ep_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const { id: _id, ...rest } = episode;
    await this.store.appendEpisode({ id, ...rest, timestamp: new Date().toISOString() });
  }

  async getRecentEpisodes(n = 20) {
    return this.store.getRecentEpisodes(n);
  }

  async queryEpisodes(filter) {
    return this.store.queryEpisodes(filter);
  }

  async getSkills() {
    const rows = await this.store.listSkills();
    return rows.map((r) => JSON.parse(r.data));
  }

  async getPatterns() {
    return this.store.listPatterns();
  }

  async getKnowledge() {
    return this.store.listKnowledge();
  }

  async getTeamRoster() { return (await this.store.get('team')) ?? []; }

  /** Emit a named event into the episode log (for auditing and pattern learning). */
  async emit(type, event, data) {
    await this.recordEpisode({ id: `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`, type, event, data });
  }

  async getGoals() {
    const rows = await this.store.listGoals();
    return rows.map((r) => JSON.parse(r.data ?? 'null')).filter(Boolean);
  }

  async addSkill(skill) {
    await this.store.upsertSkill(skill);
  }

  async upsertPattern(pattern) {
    await this.store.upsertPattern(pattern);
  }

  async addKnowledge(entry) {
    await this.store.upsertKnowledge(entry);
  }

  async upsertGoal(goal) {
    await this.store.upsertGoal(goal);
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

  async saveMessage(message) {
    if (!this.store.saveMessage) return null;
    return this.store.saveMessage(message);
  }

  async saveGap(gap) {
    if (!this.store.saveGap) return null;
    return this.store.saveGap(gap);
  }

  async getGapHistory(stepId) {
    if (!this.store.getGapHistory) return [];
    return this.store.getGapHistory(stepId);
  }

  async getGapsByGoal(goalId) {
    if (!this.store.getGapsByGoal) return [];
    return this.store.getGapsByGoal(goalId);
  }

  async saveResearchResult(result) {
    if (!this.store.saveResearchResult) return null;
    return this.store.saveResearchResult(result);
  }

  async getResearchHistory(gapId) {
    if (!this.store.getResearchHistory) return [];
    return this.store.getResearchHistory(gapId);
  }

  async saveAcquisitionEvent(event) {
    if (!this.store.saveAcquisitionEvent) return null;
    return this.store.saveAcquisitionEvent(event);
  }

  async getAcquisitionHistory(goalId) {
    if (!this.store.getAcquisitionHistory) return [];
    return this.store.getAcquisitionHistory(goalId);
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
    return [...this.tools.values()].map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      riskLevel: t.riskLevel ?? 'safe',
    }));
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

  _findTool(toolId) {
    return this.tools.get(toolId) ?? null;
  }

  /**
   * Validate an action returned by the LLM's decide phase.
   * Returns { valid: boolean, error?: string }
   * @param {Object} action - the action to validate
   * @param {string} [route='self'] - routing context
   * @param {Object} [step] - optional step definition with allowedTools/blockedTools
   */
  async validate(action, route = 'self', step = null) {
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

    // 6. Tool allowlist/blocklist (per-step permissions)
    if (step) {
      const { allowedTools, blockedTools } = step;
      if (blockedTools?.includes(action.toolId)) {
        return { valid: false, error: `Tool '${action.toolId}' is blocked for this step` };
      }
      if (allowedTools?.length > 0 && !allowedTools.includes(action.toolId)) {
        return { valid: false, error: `Tool '${action.toolId}' is not in step allowlist` };
      }
      // Dangerous tool requires explicit allowlist entry
      const tool = this._findTool(action.toolId);
      if (tool?.riskLevel === 'dangerous' && !allowedTools?.includes(action.toolId)) {
        return { valid: false, error: `Dangerous tool '${action.toolId}' requires explicit allowlist entry` };
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
    // Circuit breaker wraps the raw reason() LLM function
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: config.circuitBreakerThreshold,
      halfOpenMs: config.circuitBreakerWindowMs,
      resetOnSuccess: config.circuitResetOnSuccess,
    });
    // Backward compatibility for existing tests/integrations.
    this._circuitBreaker = this.circuitBreaker;
    this._halfOpenProbeRemaining = 0;
    const originalReason = config.reason;
    this.reason = async (prompt) => {
      if (this.circuitBreaker.isOpen()) {
        return {
          situationAssessment: 'circuit_open',
          goalId: null,
          confidence: 0,
          answers: [],
          revisedConfidence: 0,
          insights: [],
          _circuitOpen: true,
        };
      }

      if (this.circuitBreaker.isHalfOpen() && this._halfOpenProbeRemaining <= 0) {
        return {
          situationAssessment: 'circuit_open',
          goalId: null,
          confidence: 0,
          answers: [],
          revisedConfidence: 0,
          insights: [],
          _circuitOpen: true,
        };
      }

      if (this.circuitBreaker.isHalfOpen() && this._halfOpenProbeRemaining > 0) {
        this._halfOpenProbeRemaining -= 1;
      }

      try {
        const result = await originalReason(prompt);
        this.circuitBreaker.recordSuccess();
        return result;
      } catch (err) {
        this.circuitBreaker.recordFailure(err?.message ?? 'LLM call failed');
        throw err;
      }
    };
    this.memory = config.memory;
    this.skills = config.skills;
    this.tools = config.tools;
    this.identity = config.identity ?? { name: 'Agent', role: 'worker' };
    this.onPhase = config.onPhase ?? (() => {});
    this.maxCycles = config.maxCycles ?? 20;
    this.maxContextTokens = config.maxContextTokens ?? 120000;
    this.maxNoProgressCycles = config.maxNoProgressCycles ?? 3;

    this.escalation = new EscalationEngine({
      confidenceThreshold: config.confidenceThreshold ?? 0.4,
      policyBoundaries: config.policyBoundaries ?? [],
    });

    // Action validation: pluggable, defaults to built-in
    // Pass a team-getter so validation can check delegation targets against live roster
    const teamGetter = () => this.memory.getTeamRoster ? this.memory.getTeamRoster() : Promise.resolve([]);
    const defaultValidator = new ActionValidator({ skills: this.skills, tools: this.tools, team: teamGetter });
    this.validator = config.validator ?? defaultValidator;

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

  /** Returns current circuit breaker status. */
  getCircuitStatus() {
    return this.circuitBreaker.getState();
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
    const activation = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      cycleCount: 0,
      stepCycleCounts: new Map(),
      noProgressCycles: 0,
      shouldPauseContinuation: false,
      working: {
        trigger,
        activationId: null,
        researchFailed: false,
      },
    };
    activation.working.activationId = activation.id;
    const result = await this._cycle(activation, trigger);
    result.debug = {
      activationId: activation.id,
      trigger: activation.working.trigger,
      orientation: activation.working.orientation ?? null,
      reflection: activation.working.reflection ?? null,
      decision: activation.working.lastDecision ?? null,
      result: activation.working.lastResult ?? null,
      integration: activation.working.lastIntegration ?? null,
    };
    this._recordMetrics(result, Date.now() - t0);
    return result;
  }

  // ── OODA + Reflect Cycle ──

  async _cycle(activation, trigger) {
    activation.cycleCount++;
    if (activation.cycleCount > this.maxCycles) {
      return { status: 'halted', reason: 'max_cycles_exceeded', cycles: activation.cycleCount };
    }
    if (this.circuitBreaker.isOpen()) {
      const goals = await this.memory.getGoals();
      const activeGoal = goals
        .filter((g) => g.status === 'active' || g.status === 'pending')
        .sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1))[0] ?? null;
      const step = activeGoal?.steps?.find((s) => s.status === 'pending' || s.status === 'in_progress' || s.status === 'blocked') ?? null;
      await this._detectGap(activation, {
        goalId: activeGoal?.id ?? trigger?.payload?.goalId ?? null,
        stepId: step?.id ?? trigger?.payload?.stepId ?? null,
        stepDescription: step?.description ?? trigger?.payload?.description ?? 'LLM circuit breaker is open',
        toolsRequired: step?.toolsRequired ?? [],
        description: 'LLM circuit breaker is open',
        reason: 'LLM circuit breaker is open',
      }, 'tool');
      return {
        status: 'paused',
        reason: 'llm_circuit_open',
        circuitState: this.circuitBreaker.getState(),
        goalId: activeGoal?.id ?? trigger?.payload?.goalId ?? null,
        willRetryAutomatically: true,
        cycles: activation.cycleCount,
      };
    }
    if (this.circuitBreaker.isHalfOpen()) {
      this._halfOpenProbeRemaining = 1;
    } else {
      this._halfOpenProbeRemaining = 0;
    }

    const observed  = await this._observe(activation, trigger);
    // ── Issue #6: Goal Planning — decompose goals that have no steps ──
    const oriented  = await this._orient(activation, observed);
    const goalFromOrient = oriented.activeGoals?.find((g) => g.id === oriented.orientation?.goalId);
    if (goalFromOrient && !(goalFromOrient.steps && goalFromOrient.steps.length > 0)) {
      await this._plan(activation, goalFromOrient);
    }
    const reflected = await this._reflect(activation, oriented);
    const decided   = await this._decide(activation, reflected);
    const acted     = await this._act(activation, decided);
    const integration = await this._integrate(activation, acted, reflected);

    if (integration.continue) {
      return this._cycle(activation, {
        mode: 'continuation',
        source: 'kernel',
        payload: integration.nextContext,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: integration.goalComplete ? 'complete' : 'paused',
      cycles: activation.cycleCount,
      result: acted.result?.outcome,
      goalProgress: integration.progress,
    };
  }

  // ── Phase 1: OBSERVE ──

  async _observe(activation, trigger) {
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

    let observation = {
      trigger, activeGoals, recentEpisodes: episodes,
      matchedPatterns, predictions,
      availableSkills: this.skills.list(),
      availableTools: this.tools.list(),
      storedKnowledge: knowledge, team, flatState,
    };

    // ── Token Budget Enforcement (Issue #14) ──
    const flat = JSON.stringify(observation);
    const tokens = this._countPromptTokens(flat);
    if (tokens > this.maxContextTokens) {
      const originalTokens = tokens;
      observation = this._applyContextBudget(observation, { over: true });
      const trimmed = JSON.stringify(observation);
      const finalTokens = this._countPromptTokens(trimmed);
      this.memory.emit('warning', 'context_truncated', { originalTokens, finalTokens });
    }

    activation.working.observation = observation;
    this._emit(activation, 'observe', trigger, observation, Date.now() - t0);
    return observation;
  }

  // ── Phase 2: ORIENT ──

  async _orient(activation, observation) {
    const t0 = Date.now();

    const orientation = await this.reason(
      this._buildPrompt(activation, 'orient', {
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

    const activeGoals = observation.activeGoals ?? [];
    const triggerGoalId = observation.trigger?.payload?.goalId ?? null;
    const highestPriorityGoal = activeGoals.length > 0
      ? [...activeGoals].sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1))[0]
      : null;
    const selectedGoal = activeGoals.find((g) => g.id === orientation?.goalId)
      ?? activeGoals.find((g) => g.id === triggerGoalId)
      ?? highestPriorityGoal
      ?? null;

    const normalizedOrientation = {
      ...orientation,
      goalId: selectedGoal?.id ?? null,
      structurallySelectedGoal: !orientation?.goalId && !!selectedGoal,
    };

    activation.working.orientation = normalizedOrientation;
    this._emit(activation, 'orient', observation, normalizedOrientation, Date.now() - t0);
    return { ...observation, orientation: normalizedOrientation };
  }

  // ── Phase 2.5: REFLECT (Self-Interrogation) ──

  async _reflect(activation, oriented) {
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
      this._buildPrompt(activation, 'reflect', {
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

    activation.working.reflection = reflection;
    this._emit(activation, 'reflect', { questions }, reflection, Date.now() - t0);

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

  async _decide(activation, reflected) {
    const t0 = Date.now();
    const goal = reflected.resolvedGoal;
    const readySteps = reflected.readySteps ?? [];
    const blockedSteps = reflected.blockedSteps ?? [];
    const confidence = reflected.reflection?.revisedConfidence ?? reflected.orientation?.confidence ?? 0.5;

    const nextStep = readySteps[0] ?? null;
    const hasRequiredSkill = nextStep ? this.skills.has(nextStep.skillRequired) : true;

    // Track cycles per step
    if (nextStep) {
      const count = (activation.stepCycleCounts.get(nextStep.id) ?? 0) + 1;
      activation.stepCycleCounts.set(nextStep.id, count);
    }

    // ── NO READY STEPS ──
    if (!nextStep) {
      const decision = {
        route: 'self',
        reasoning: 'No ready steps available',
        action: { type: 'wait' },
        nextStepId: null,
      };
      activation.working.lastDecision = decision;
      this._emit(activation, 'decide', { readySteps: [] }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    // ── SKILL GAP → research ──
    if (!hasRequiredSkill) {
      const gapEvent = await this._detectGap(activation, {
        goalId: goal?.id ?? null,
        stepId: nextStep?.id ?? null,
        stepDescription: nextStep?.description ?? '',
        skillRequired: nextStep?.skillRequired ?? null,
        toolsRequired: nextStep?.toolsRequired ?? [],
        priorAttempts: nextStep ? (activation.stepCycleCounts.get(nextStep.id) ?? 0) : 0,
        description: `Missing required skill "${nextStep?.skillRequired ?? 'unknown'}" before execution`,
        reason: 'Missing required skill',
      });
      const decision = {
        route: 'self',
        reasoning: `Missing skill "${nextStep.skillRequired}" — entering research mode`,
        action: { type: 'research' },
        gapEvent,
        nextStepId: nextStep.id,
      };
      activation.working.lastDecision = decision;
      this._emit(activation, 'decide', { skillGap: nextStep.skillRequired, gapEvent }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    // ── DEFAULT TEXT EXECUTION (structural) ──
    const needsPlainTextExecution = nextStep
      && !nextStep.skillRequired
      && (!(nextStep.toolsRequired?.length));

    if (needsPlainTextExecution) {
      const decision = {
        route: 'self',
        reasoning: 'Ready step has no explicit skill or tool requirements; execute as a default text task.',
        action: {
          type: 'execute_text',
          params: {
            goalId: goal?.id ?? null,
            stepId: nextStep.id,
            description: nextStep.description,
          },
        },
        nextStepId: nextStep.id,
        structuralOverride: true,
      };
      activation.working.lastDecision = decision;
      this._emit(activation, 'decide', { nextStep, mode: 'default_text_execution' }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    // ── STRUCTURAL ESCALATION (before LLM, but after default text execution) ──
    const escalationVerdict = this.escalation.evaluate({
      confidence,
      actionType: nextStep?.skillRequired,
      hasRequiredSkill,
      researchFailed: activation.working.researchFailed === true,
      blockedSteps,
      totalSteps: goal?.steps?.length ?? 0,
      doneSteps: (goal?.steps ?? []).filter((s) => s.status === 'done').length,
      cyclesOnCurrentStep: nextStep ? (activation.stepCycleCounts.get(nextStep.id) ?? 0) : 0,
      team: reflected.team,
    });

    if (escalationVerdict.mustEscalate) {
      this._metrics.totalEscalations++;
      await this._detectGap(activation, {
        goalId: goal?.id ?? null,
        stepId: nextStep?.id ?? null,
        stepDescription: nextStep?.description ?? '',
        skillRequired: nextStep?.skillRequired ?? null,
        toolsRequired: nextStep?.toolsRequired ?? [],
        priorAttempts: nextStep ? (activation.stepCycleCounts.get(nextStep.id) ?? 0) : 0,
        escalationReason: escalationVerdict.reason,
        description: escalationVerdict.reason ?? 'Escalation required',
        reason: escalationVerdict.reason ?? 'Escalation required',
      });
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
          cyclesOnCurrentStep: nextStep ? (activation.stepCycleCounts.get(nextStep.id) ?? 0) : 0,
        },
      };
      await this.memory.saveMessage(pendingMessage);
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
      activation.working.lastDecision = decision;
      this._emit(activation, 'decide', { escalationVerdict }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    // ── DELEGATION CHECK (structural) ──
    const delegationTarget = this._checkDelegation(nextStep, reflected.team);

    // ── LLM DECIDE — within guardrails ──
    const llmDecision = await this.reason(
      this._buildPrompt(activation, 'decide', {
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

    // ── NOVELTY PENALTY — reduce confidence when LLM operates in uncharted territory ──
    const matchedPatterns = reflected.matchedPatterns ?? [];
    const hasMatch = matchedPatterns.length > 0;
    const baseConfidence = llmDecision.confidence ?? 0.5;
    const adjustedConfidence = hasMatch ? baseConfidence : Math.max(0.1, baseConfidence - 0.25);

    if (!hasMatch && baseConfidence > 0.8) {
      // High confidence with no pattern support = hallucination risk
      this.memory.emit('warning', 'high_confidence_novel_situation', {
        baseConfidence, adjustedConfidence, goalId: reflected.resolvedGoal?.id,
      });
    } else if (hasMatch && baseConfidence > 0.8) {
      // Positive reinforcement — high confidence backed by pattern
      this.memory.emit('info', 'pattern_confirmed_high_confidence', {
        baseConfidence, matchedPatternIds: matchedPatterns.map(p => p.id), goalId: reflected.resolvedGoal?.id,
      });
    }
    llmDecision.confidence = adjustedConfidence;

    // ── ACTION VALIDATION — kernel gate before execution ──
    const route = llmDecision.route ?? 'self';
    const action = llmDecision.action ?? {};
    const validation = await this.validator.validate(action, route, nextStep);
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
      activation.working.lastDecision = decision;
      this._emit(activation, 'decide', { nextStep, llmDecision, validationError: validation.error }, decision, Date.now() - t0);
      return { ...reflected, decision };
    }

    const decision = { ...llmDecision, nextStepId: nextStep.id, structuralOverride: false };
    activation.working.lastDecision = decision;
    this._emit(activation, 'decide', { nextStep, escalationVerdict }, decision, Date.now() - t0);
    return { ...reflected, decision };
  }

  _checkDelegation(step, team) {
    if (!team?.length || !step.skillRequired) return null;
    return team.find((m) => m.role === 'junior' && m.capabilities?.includes(step.skillRequired)) ?? null;
  }

  // ── Phase 4: ACT ──

  async _act(activation, decided) {
    const t0 = Date.now();
    const action = decided.decision?.action;
    const resolvedStep = this._getStepForDecision(decided);
    if (!action) {
      const result = { action: null, outcome: { success: false, error: 'No action defined' } };
      this._emit(activation, 'act', null, result, Date.now() - t0);
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
          if (skill.source === 'self-acquired') {
            const acquired = await executeAcquiredSkill(skill, {
              params: action.params ?? {},
              goal: decided.resolvedGoal ?? null,
              step: resolvedStep ?? null,
              reason: this.reason,
            });
            outcome = {
              success: true,
              type: 'self_acquired_skill_execution',
              ...acquired,
            };
          } else {
            outcome = await skill.execute({
              params: action.params ?? {},
              tools: this.tools,
              memory: this.memory,
              reason: this.reason,
            });
          }
          break;
        }
        case 'execute_text': {
          const params = action.params ?? {};
          const completion = await this.reason(
            this._buildPrompt(activation, 'execute_text', {
              identity: this.identity,
              goal: decided.resolvedGoal ? {
                id: decided.resolvedGoal.id,
                description: decided.resolvedGoal.description,
              } : null,
              step: {
                id: params.stepId ?? decided.decision?.nextStepId ?? null,
                description: params.description ?? 'Complete the next step',
              },
              instructions: `You are executing a single concrete work step.
Return JSON:
{
  "summary": "What was accomplished in one paragraph",
  "artifact": "The concrete output/result of the step",
  "confidence": 0.0-1.0,
  "notes": ["optional note"]
}`,
            }),
          );
          outcome = {
            success: true,
            type: 'text_execution',
            summary: completion.summary ?? '',
            artifact: completion.artifact ?? '',
            confidence: completion.confidence ?? 0.5,
            notes: completion.notes ?? [],
          };
          break;
        }
        case 'use_tool': {
          const result = await this.tools.execute(action.toolId, action.params ?? {});
          outcome = { success: true, toolResult: result };
          break;
        }
        case 'research': {
          outcome = await this._research(activation, decided.decision.gapEvent, decided.resolvedGoal, resolvedStep);
          if (outcome?.status === 'resolved') {
            await this._processAcquisitionResult(outcome, decided.decision.gapEvent, decided.resolvedGoal, resolvedStep);
          }
          if (!outcome.success) activation.working.researchFailed = true;
          break;
        }
        case 'communicate': {
          outcome = {
            success: true, type: 'communication',
            message: action.message,
            awaitingResponse: decided.decision.route === 'escalate',
          };
          if (decided.decision.route === 'escalate') {
            activation.shouldPauseContinuation = true;
          }
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

    if (action.type === 'execute_skill' && outcome?.success === false && outcome?.needsResearch === true) {
      await this._detectGap(activation, {
        goalId: decided.resolvedGoal?.id ?? null,
        stepId: resolvedStep?.id ?? decided.decision?.nextStepId ?? null,
        stepDescription: resolvedStep?.description ?? '',
        skillRequired: resolvedStep?.skillRequired ?? action.skillId ?? null,
        toolsRequired: resolvedStep?.toolsRequired ?? [],
        priorAttempts: resolvedStep?.id ? (activation.stepCycleCounts.get(resolvedStep.id) ?? 0) : 0,
        lastError: outcome?.error ?? null,
        description: `Skill execution failed and requested research: ${outcome?.error ?? 'unknown error'}`,
        reason: outcome?.error ?? 'execute_skill failed with needsResearch',
      });
    }
    if (action.type === 'execute_text' && Number(outcome?.confidence ?? 1) < 0.3) {
      await this._detectGap(activation, {
        goalId: decided.resolvedGoal?.id ?? null,
        stepId: resolvedStep?.id ?? decided.decision?.nextStepId ?? null,
        stepDescription: resolvedStep?.description ?? action.params?.description ?? '',
        skillRequired: resolvedStep?.skillRequired ?? null,
        toolsRequired: resolvedStep?.toolsRequired ?? [],
        priorAttempts: resolvedStep?.id ? (activation.stepCycleCounts.get(resolvedStep.id) ?? 0) : 0,
        description: `Text execution returned low confidence (${Number(outcome?.confidence ?? 0).toFixed(2)})`,
        reason: 'Low confidence text execution',
      });
    }

    const result = { action, outcome };
    activation.working.lastResult = result;
    this._emit(activation, 'act', decided.decision, result, Date.now() - t0);
    return { ...decided, result };
  }

  // ── Phase 5: INTEGRATE ──

  async _integrate(activation, acted, reflected) {
    const t0 = Date.now();
    const goalId = reflected.orientation?.goalId;

    // Snapshot done steps before execution for no-progress detection.
    let beforeDoneSteps = new Set();
    let hadStepsInProgress = false;
    if (goalId) {
      const goals = await this.memory.getGoals();
      const goal = goals.find((g) => g.id === goalId);
      if (goal?.steps) {
        beforeDoneSteps = new Set(goal.steps.filter((s) => s.status === 'done').map((s) => s.id));
        hadStepsInProgress = goal.steps.some((s) => s.status === 'in_progress' || s.status === 'pending' || s.status === 'blocked');
      }
    }

    // 1. Record episode
    await this.memory.recordEpisode({
      activationId: activation.id,
      cycle: activation.cycleCount,
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
        const isExecution = actionType === 'execute_skill' || actionType === 'use_tool' || actionType === 'execute_text';
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
          const checks = goal.criteria.map((criterion) => {
            try {
              return GoalCriterion.evaluate(criterion, {
                goal,
                matchedPatterns: reflected.matchedPatterns ?? [],
                workingState: activation.working,
              });
            } catch {
              return false;
            }
          });
          goalComplete = checks.every(Boolean);
          progress = checks.length ? (checks.filter(Boolean).length / checks.length) : 0;
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

    // Detect no-progress cycles after execution using done-step delta.
    let afterDoneSteps = new Set();
    if (goalId) {
      const goals = await this.memory.getGoals();
      const goal = goals.find((g) => g.id === goalId);
      if (goal?.steps) {
        afterDoneSteps = new Set(goal.steps.filter((s) => s.status === 'done').map((s) => s.id));
      }
    }

    const completedDelta = afterDoneSteps.size - beforeDoneSteps.size;
    const noStepCompleted = hadStepsInProgress && completedDelta === 0;
    if (noStepCompleted) {
      activation.noProgressCycles++;
      this.memory.emit('warning', 'no_progress_cycles', { count: activation.noProgressCycles, goalId });
      if (activation.noProgressCycles > this.maxNoProgressCycles) {
        const resolvedStep = this._getStepForDecision(acted);
        await this._detectGap(activation, {
          goalId,
          stepId: resolvedStep?.id ?? acted.decision?.nextStepId ?? null,
          stepDescription: resolvedStep?.description ?? '',
          skillRequired: resolvedStep?.skillRequired ?? null,
          toolsRequired: resolvedStep?.toolsRequired ?? [],
          priorAttempts: resolvedStep?.id ? (activation.stepCycleCounts.get(resolvedStep.id) ?? 0) : activation.noProgressCycles,
          lastError: acted.result?.outcome?.error ?? null,
          description: `No progress for ${activation.noProgressCycles} consecutive cycles`,
          reason: 'No-progress threshold exceeded',
        });
        const integration = {
          continue: false,
          goalComplete: false,
          progress,
          nextContext: null,
          noProgress: true,
        };
        activation.working.lastIntegration = integration;
        this._emit(activation, 'integrate', acted.result, integration, Date.now() - t0);
        return integration;
      }
    } else {
      activation.noProgressCycles = 0;
    }

    const shouldContinue =
      !goalComplete &&
      acted.result?.outcome?.success &&
      activation.shouldPauseContinuation !== true &&
      acted.result?.outcome?.awaitingResponse !== true &&
      acted.result?.action?.type !== 'wait';

    const integration = {
      continue: shouldContinue,
      goalComplete,
      progress,
      nextContext: shouldContinue ? acted.result.outcome : null,
    };

    activation.working.lastIntegration = integration;
    this._emit(activation, 'integrate', acted.result, integration, Date.now() - t0);
    return integration;
  }

  // ── Research ──

  async _research(activation, gap, goalContext = null, stepContext = null) {
    try {
      if (!gap || typeof gap !== 'object') {
        const failure = {
          success: false,
          type: 'research',
          gapId: gap?.id ?? null,
          gapType: gap?.gapType ?? null,
          status: 'failed',
          findings: 'Research not started: missing gap event.',
          confidence: 0,
          proposedSkill: null,
          proposedPattern: null,
          proposedTool: null,
          evidence: [],
          requiresHumanApproval: false,
          validationErrors: ['Missing gap event'],
          attempts: 0,
        };
        await this.memory.emit('warning', 'research_failed', failure);
        return failure;
      }

      const gapHistory = await this.memory.getResearchHistory(gap.id);
      if (!shouldTriggerResearch(gap, gapHistory)) {
        return {
          success: false,
          type: 'research',
          gapId: gap.id,
          gapType: gap.gapType,
          status: 'failed',
          findings: `Research skipped for gap type "${gap.gapType}" or already resolved.`,
          confidence: 0,
          proposedSkill: null,
          proposedPattern: null,
          proposedTool: null,
          evidence: [],
          requiresHumanApproval: false,
          skipped: true,
          attempts: 0,
        };
      }

      const objective = createResearchObjective(gap, goalContext ?? {}, stepContext ?? {});
      let lastErrors = [];

      for (let attempt = 1; attempt <= objective.maxAttempts; attempt++) {
        objective.currentAttempt = attempt;
        let parsed = null;
        let validation = { valid: false, errors: ['No response from reason()'] };

        try {
          const raw = await this.reason(
            this._buildPrompt(activation, 'research', {
              identity: this.identity,
              gap,
              goalContext: goalContext ? {
                id: goalContext.id ?? null,
                description: goalContext.description ?? '',
              } : null,
              stepContext: stepContext ? {
                id: stepContext.id ?? null,
                description: stepContext.description ?? '',
                skillRequired: stepContext.skillRequired ?? null,
                toolsRequired: stepContext.toolsRequired ?? [],
              } : null,
              objective,
              availableSkills: this.skills.list(),
              availableTools: this.tools.list(),
              instructions: `RESEARCH mode.
Return ONLY JSON matching this schema exactly:
{
  "gapId": "string",
  "gapType": "knowledge|procedural|tool|authority|ambiguity",
  "status": "resolved|partial|failed",
  "findings": "string",
  "confidence": 0.0,
  "proposedSkill": null or {
    "id": "string",
    "name": "string",
    "description": "string",
    "triggerConditions": ["string"],
    "procedure": ["string"],
    "requiredTools": ["string"],
    "estimatedConfidence": 0.0
  },
  "proposedPattern": null or {
    "id": "string",
    "description": "string",
    "conditions": [ {} ],
    "expectedOutcome": "string",
    "confidence": 0.0
  },
  "proposedTool": null or {
    "id": "string",
    "name": "string",
    "description": "string",
    "executeTemplate": "string",
    "requiresInstallation": false
  },
  "evidence": ["string"],
  "requiresHumanApproval": false
}`,
            }),
          );

          parsed = parseLlmJson(raw);
          validation = validateResearchResult(parsed);
        } catch (err) {
          lastErrors = [`reason() failed: ${err?.message ?? 'unknown error'}`];
          await this.memory.saveResearchResult({
            gapId: gap.id,
            gapType: gap.gapType,
            status: 'failed',
            findings: `Research attempt ${attempt} failed before validation.`,
            confidence: 0,
            proposedSkill: null,
            proposedPattern: null,
            proposedTool: null,
            evidence: [],
            requiresHumanApproval: false,
            validationErrors: lastErrors,
            attempt,
            createdAt: new Date().toISOString(),
          });
          continue;
        }

        if (!validation.valid) {
          lastErrors = validation.errors;
          await this.memory.saveResearchResult({
            gapId: gap.id,
            gapType: gap.gapType,
            status: 'failed',
            findings: `Research attempt ${attempt} returned invalid schema.`,
            confidence: 0,
            proposedSkill: null,
            proposedPattern: null,
            proposedTool: null,
            evidence: [],
            requiresHumanApproval: false,
            validationErrors: validation.errors,
            attempt,
            createdAt: new Date().toISOString(),
          });
          continue;
        }

        const normalized = {
          ...parsed,
          gapId: gap.id,
          gapType: gap.gapType,
          confidence: Number(parsed.confidence ?? 0),
        };

        if (normalized.confidence < 0.4 && normalized.status === 'resolved') {
          normalized.status = 'partial';
        }

        const persisted = {
          ...normalized,
          attempt,
          createdAt: new Date().toISOString(),
        };
        await this.memory.saveResearchResult(persisted);

        if (normalized.findings) {
          await this.memory.addKnowledge({
            topic: objective.topic,
            content: normalized.findings,
            confidence: normalized.confidence,
            source: 'self-research',
          });
        }

        return {
          success: normalized.status !== 'failed',
          type: 'research',
          attempts: attempt,
          ...normalized,
          humanApprovalRequired: normalized.requiresHumanApproval === true,
        };
      }

      const failure = {
        success: false,
        type: 'research',
        gapId: gap.id,
        gapType: gap.gapType,
        status: 'failed',
        findings: 'Research failed after validation retries.',
        confidence: 0,
        proposedSkill: null,
        proposedPattern: null,
        proposedTool: null,
        evidence: [],
        requiresHumanApproval: false,
        validationErrors: lastErrors,
        attempts: objective.maxAttempts,
      };
      await this.memory.emit('warning', 'research_failed', failure);
      return failure;
    } catch (err) {
      await this.memory.emit('warning', 'research_failed', { gapId: gap?.id, error: err.message, source: 'outer_catch' });
      return {
        success: false,
        type: 'research',
        gapId: gap?.id ?? null,
        gapType: gap?.gapType ?? null,
        status: 'failed',
        findings: `Research failed unexpectedly: ${err?.message ?? 'unknown error'}`,
        confidence: 0,
        proposedSkill: null,
        proposedPattern: null,
        proposedTool: null,
        evidence: [],
        requiresHumanApproval: false,
        attempts: 0,
      };
    }
  }

  async _processAcquisitionResult(researchResult, gap, goalContext = null, stepContext = null) {
    try {
      if (!researchResult || researchResult.status !== 'resolved') return;

      const coProposedToolIds = researchResult.proposedTool?.id ? [researchResult.proposedTool.id] : [];
      const skillValidation = researchResult.proposedSkill
        ? validateProposedSkill(researchResult.proposedSkill, {
          has: (id) => this.skills.has(id),
          hasTool: (id) => this.tools.has(id),
          coProposedToolIds,
        })
        : null;

      if (researchResult.proposedSkill && skillValidation?.valid) {
        const simulation = await sandboxTest(
          researchResult.proposedSkill,
          goalContext ?? {},
          stepContext ?? {},
          this.reason,
        );
        if (simulation.passed) {
          const skill = {
            ...researchResult.proposedSkill,
            source: 'self-acquired',
            acquiredFromGapId: gap?.id ?? researchResult.gapId ?? null,
            acquiredAt: new Date().toISOString(),
          };
          this.skills.register(skill);
          await this.memory.addSkill(skill);
          const event = createCapabilityAcquiredEvent('skill', skill, gap ?? researchResult);
          await this.memory.saveAcquisitionEvent(event);
          await this.memory.recordEpisode({
            type: 'capability_acquired',
            event: 'skill',
            data: event,
            goalId: goalContext?.id ?? gap?.goalId ?? null,
          });
        } else {
          await this.memory.emit('warning', 'acquisition_rejected', {
            capabilityType: 'skill',
            capabilityId: researchResult.proposedSkill.id,
            reason: simulation.reason ?? 'sandbox test failed',
          });
        }
      } else if (researchResult.proposedSkill) {
        await this.memory.emit('warning', 'acquisition_rejected', {
          capabilityType: 'skill',
          capabilityId: researchResult.proposedSkill.id ?? null,
          errors: skillValidation?.errors ?? ['invalid proposed skill'],
        });
      }

      if (researchResult.proposedPattern) {
        const existingPatterns = await this.memory.getPatterns();
        const patternValidation = validateProposedPattern(researchResult.proposedPattern, {
          has: (id) => existingPatterns.some((p) => p.id === id),
        });
        if (patternValidation.valid) {
          const pattern = {
            ...researchResult.proposedPattern,
            source: 'self-acquired',
            acquiredFromGapId: gap?.id ?? researchResult.gapId ?? null,
            acquiredAt: new Date().toISOString(),
          };
          await this.memory.upsertPattern(pattern);
          const event = createCapabilityAcquiredEvent('pattern', pattern, gap ?? researchResult);
          await this.memory.saveAcquisitionEvent(event);
          await this.memory.recordEpisode({
            type: 'capability_acquired',
            event: 'pattern',
            data: event,
            goalId: goalContext?.id ?? gap?.goalId ?? null,
          });
        } else {
          await this.memory.emit('warning', 'acquisition_rejected', {
            capabilityType: 'pattern',
            capabilityId: researchResult.proposedPattern.id ?? null,
            errors: patternValidation.errors,
          });
        }
      }

      if (researchResult.proposedTool) {
        const toolValidation = validateProposedTool(researchResult.proposedTool, {
          has: (id) => this.tools.has(id),
        });
        if (!toolValidation.valid) {
          await this.memory.emit('warning', 'acquisition_rejected', {
            capabilityType: 'tool',
            capabilityId: researchResult.proposedTool.id ?? null,
            errors: toolValidation.errors,
          });
          return;
        }

        if (toolValidation.requiresApproval) {
          const team = await this.memory.getTeamRoster();
          const humanId = team.find((m) => m.role === 'human')?.id ?? 'human';
          const approvalMessage = {
            id: `msg_tool_approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            from: this.identity?.name ?? 'kernel',
            to: humanId,
            goalId: goalContext?.id ?? gap?.goalId ?? null,
            stepId: stepContext?.id ?? gap?.stepId ?? null,
            content: `Approval required to install proposed tool "${researchResult.proposedTool.id}".`,
            metadata: {
              type: 'tool_install_approval',
              proposedTool: researchResult.proposedTool,
              gapId: gap?.id ?? researchResult.gapId ?? null,
            },
          };
          await this.memory.saveMessage(approvalMessage);
          await this.memory.emit('warning', 'acquisition_requires_approval', {
            capabilityType: 'tool',
            capabilityId: researchResult.proposedTool.id,
            messageId: approvalMessage.id,
          });
        } else {
          const tool = {
            ...researchResult.proposedTool,
            source: 'self-acquired',
            acquiredFromGapId: gap?.id ?? researchResult.gapId ?? null,
            acquiredAt: new Date().toISOString(),
            execute: async () => ({
              success: false,
              requiresImplementation: true,
              executeTemplate: researchResult.proposedTool.executeTemplate,
              message: 'Self-acquired tool registered from template; concrete execution binding is required.',
            }),
          };
          this.tools.register(tool);
          const event = createCapabilityAcquiredEvent('tool', tool, gap ?? researchResult);
          await this.memory.saveAcquisitionEvent(event);
          await this.memory.recordEpisode({
            type: 'capability_acquired',
            event: 'tool',
            data: event,
            goalId: goalContext?.id ?? gap?.goalId ?? null,
          });
        }
      }
    } catch (err) {
      await this.memory.emit('warning', 'acquisition_processing_failed', {
        gapId: gap?.id ?? researchResult?.gapId ?? null,
        error: err?.message ?? 'unknown error',
      });
    }
  }

  // ── Token Budget ──

  _countPromptTokens(text) {
    return Math.ceil(text.length / 4);
  }

  async _summariseEpisodes(episodes, maxTokens) {
    // Stub: if LLM is unavailable, just return the last 3 episodes
    if (!this.reason) return episodes.slice(-3);
    try {
      const summary = await this.reason(
        this._buildPrompt('summarise', {
          episodes,
          maxTokens,
          instructions: `Compress these episodes into fewer entries totalling approximately ${maxTokens} tokens.
Return JSON: { "summarised": [{ "id": "...", "text": "...", "tokens": N }] }`,
        }),
      );
      return summary.summarised ?? episodes.slice(-3);
    } catch {
      return episodes.slice(-3);
    }
  }

  _applyContextBudget(observation, budget) {
    let { recentEpisodes, storedKnowledge, matchedPatterns } = observation;
    let truncated = false;

    // Cut 1: Reduce episodes from 10 to last 5
    if (budget.over) {
      if (recentEpisodes.length > 5) {
        recentEpisodes = recentEpisodes.slice(-5);
        truncated = true;
      }
    }

    // Cut 2: Drop low-confidence knowledge
    if (budget.over && storedKnowledge.length > 0) {
      const filtered = storedKnowledge.filter((k) => (k.confidence ?? 0.5) >= 0.5);
      if (filtered.length < storedKnowledge.length) {
        storedKnowledge = filtered;
        truncated = true;
      }
    }

    // Cut 3: Limit patterns to top 5 by priority
    if (budget.over && matchedPatterns.length > 5) {
      matchedPatterns = [...matchedPatterns]
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .slice(0, 5);
      truncated = true;
    }

    return { ...observation, recentEpisodes, storedKnowledge, matchedPatterns, __TRUNCATED__: truncated };
  }

  // ── Goal Planning ──

  async _plan(activation, goal) {
    if (goal.steps && goal.steps.length > 0) return null;

    const planResult = await this.reason(
      this._buildPrompt(activation, 'plan', {
        identity: this.identity,
        goal: { id: goal.id, description: goal.description },
        instructions: `Decompose this goal into ordered steps. Return JSON:
{ "steps": [{ "id": "step_1", "description": "...", "dependencies": [], "status": "pending" }] }`,
      }),
    );

    const steps = planResult.steps ?? [];
    if (!steps.length) return null;

    const validation = DependencyResolver.validate(steps);
    if (!validation.valid) {
      throw new Error(`Plan validation failed: ${validation.errors.join('; ')}`);
    }

    goal.steps = steps;
    await this.memory.upsertGoal(goal);
    return steps;
  }

  // ── Helpers ──

  _getStepForDecision(decisionEnvelope) {
    const goalSteps = decisionEnvelope?.resolvedGoal?.steps ?? [];
    const nextStepId = decisionEnvelope?.decision?.nextStepId ?? null;
    if (nextStepId) {
      const byId = goalSteps.find((s) => s.id === nextStepId);
      if (byId) return byId;
    }
    const readySteps = decisionEnvelope?.readySteps ?? [];
    if (readySteps.length > 0) return readySteps[0];
    return null;
  }

  async _detectGap(activation, context = {}, forcedGapType = null) {
    const detectedBy = this.identity?.name ?? 'kernel';
    try {
      const classification = forcedGapType
        ? {
          gapType: forcedGapType,
          confidence: 0.95,
          reason: context.reason ?? `Forced gap type: ${forcedGapType}`,
        }
        : classifyGap({
          ...context,
          skillRegistry: this.skills.list().map((s) => s.id),
          toolRegistry: this.tools.list().map((t) => t.id),
        });
      const gapEvent = createGapEvent(classification, { ...context, detectedBy });
      if (this.memory.saveGap) await this.memory.saveGap(gapEvent);
      if (this.memory.emit) await this.memory.emit('warning', 'gap_detected', gapEvent);
      activation.working.lastGap = gapEvent;
      return gapEvent;
    } catch {
      const fallback = createGapEvent(
        { gapType: 'knowledge', confidence: 0.5, reason: 'Classifier fallback' },
        { ...context, detectedBy },
      );
      if (this.memory.saveGap) await this.memory.saveGap(fallback);
      if (this.memory.emit) await this.memory.emit('warning', 'gap_detected', fallback);
      activation.working.lastGap = fallback;
      return fallback;
    }
  }

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

    // Include all active goals' metadata for LLM reasoning across goals
    if (activeGoals.length > 0) {
      const sortedGoals = [...activeGoals].sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
      state['goals.all'] = JSON.stringify(sortedGoals.map(g => ({
        id: g.id,
        description: g.description,
        priority: g.priority ?? 1,
        status: g.status,
        progress: g.steps ? DependencyResolver.progress(g.steps).progress : 0,
      })));
      // Primary goal (highest priority)
      const goal = sortedGoals[0];
      state['goal.id'] = goal.id;
      state['goal.status'] = goal.status;
      state['goal.assignedBy'] = goal.assignedBy ?? '';
      state['goal.priority'] = String(goal.priority ?? 1);
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

  _buildPrompt(activation, phase, context) {
    if (typeof activation === 'string') {
      context = phase;
      phase = activation;
      activation = { id: 'activation_unknown' };
    }
    return JSON.stringify({
      phase,
      activationId: activation.id,
      agentIdentity: context.identity,
      ...context,
    });
  }

  _emit(activation, phase, input, output, durationMs) {
    this.onPhase({
      phase, activationId: activation.id, cycle: activation.cycleCount,
      timestamp: new Date().toISOString(), durationMs, input, output,
    });
  }
}

// ─────────────────────────────────────────────
// 9. IN-MEMORY STORE
// ─────────────────────────────────────────────

class InMemoryStore {
  constructor() {
    this.data = new Map();
    this.messages = new Map();
  }
  async get(key) {
    const val = this.data.get(key);
    return val !== undefined ? JSON.parse(JSON.stringify(val)) : null;
  }
  async set(key, value) { this.data.set(key, JSON.parse(JSON.stringify(value))); }
  async delete(key) { this.data.delete(key); }
  async list(prefix) { return [...this.data.keys()].filter((k) => k.startsWith(prefix ?? '')); }

  async saveMessage(msg) {
    const item = {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      content: msg.content,
      goalId: msg.goalId ?? null,
      stepId: msg.stepId ?? null,
      status: msg.status ?? 'pending',
      metadata: msg.metadata ?? {},
      createdAt: new Date().toISOString(),
      acknowledgedAt: null,
    };
    this.messages.set(item.id, item);
    return item;
  }

  async getMessage(id) {
    return this.messages.get(id) ?? null;
  }

  async getPendingMessages(toAgent) {
    return [...this.messages.values()].filter((m) => m.to === toAgent && m.status === 'pending');
  }

  async acknowledgeMessage(id) {
    const msg = this.messages.get(id);
    if (!msg) return null;
    msg.status = 'acknowledged';
    msg.acknowledgedAt = new Date().toISOString();
    return msg;
  }

  async saveGap(gap) {
    const gaps = (await this.get('gaps')) ?? [];
    gaps.push(JSON.parse(JSON.stringify(gap)));
    await this.set('gaps', gaps);
    return gap;
  }

  async getGapHistory(stepId) {
    if (!stepId) return [];
    const gaps = (await this.get('gaps')) ?? [];
    return gaps.filter((g) => g.stepId === stepId);
  }

  async getGapsByGoal(goalId) {
    if (!goalId) return [];
    const gaps = (await this.get('gaps')) ?? [];
    return gaps.filter((g) => g.goalId === goalId);
  }

  async saveResearchResult(result) {
    const results = (await this.get('research_results')) ?? [];
    results.push(JSON.parse(JSON.stringify(result)));
    await this.set('research_results', results);
    return result;
  }

  async getResearchHistory(gapId) {
    if (!gapId) return [];
    const results = (await this.get('research_results')) ?? [];
    return results.filter((r) => r.gapId === gapId);
  }

  async saveAcquisitionEvent(event) {
    const events = (await this.get('acquisition_events')) ?? [];
    events.push(JSON.parse(JSON.stringify(event)));
    await this.set('acquisition_events', events);
    return event;
  }

  async getAcquisitionHistory(goalId) {
    const events = (await this.get('acquisition_events')) ?? [];
    if (!goalId) return events;
    return events.filter((event) => event?.gapContext?.goalId === goalId);
  }

  // ── Episodes (atomic push + trim) ────────────────────
  async appendEpisode(episode) {
    const episodes = (await this.get('episodes')) ?? [];
    episodes.push(episode);
    if (episodes.length > 200) episodes.splice(0, episodes.length - 200);
    await this.set('episodes', episodes);
  }

  async getRecentEpisodes(n) {
    const episodes = (await this.get('episodes')) ?? [];
    return episodes.slice(-n);
  }

  // ── Patterns (atomic upsert) ──────────────────────────
  async upsertPattern(pattern) {
    const items = (await this.get('patterns')) ?? [];
    const idx = items.findIndex((p) => p.id === pattern.id);
    if (idx >= 0) items[idx] = pattern; else items.push(pattern);
    await this.set('patterns', items);
  }

  async listPatterns() {
    const items = (await this.get('patterns')) ?? [];
    return items;
  }

  // ── Skills (atomic upsert) ──────────────────────────
  async upsertSkill(skill) {
    const items = (await this.get('skills')) ?? [];
    const idx = items.findIndex((s) => s.id === skill.id);
    if (idx >= 0) items[idx] = skill; else items.push(skill);
    await this.set('skills', items);
  }

  async listSkills() {
    const items = (await this.get('skills')) ?? [];
    return items.map((s) => ({ id: s.id, data: JSON.stringify(s) }));
  }

  // ── Goals (atomic upsert) ──────────────────────────
  async upsertGoal(goal) {
    const items = (await this.get('goals')) ?? [];
    const idx = items.findIndex((g) => g.id === goal.id);
    if (idx >= 0) items[idx] = goal; else items.push(goal);
    await this.set('goals', items);
  }

  async listGoals() {
    const items = (await this.get('goals')) ?? [];
    return items.map((g) => ({ id: g.id, data: JSON.stringify(g) }));
  }

  // ── Knowledge (atomic push + eviction) ─────────────
  async upsertKnowledge(entry) {
    const items = (await this.get('knowledge')) ?? [];
    items.push({ ...entry, learnedAt: new Date().toISOString() });
    if (items.length > 1000) {
      items.sort((a, b) => (a.confidence ?? 0.5) - (b.confidence ?? 0.5));
      items.splice(0, items.length - 1000);
    }
    await this.set('knowledge', items);
  }

  async listKnowledge() {
    const items = (await this.get('knowledge')) ?? [];
    return items;
  }
}

// ─────────────────────────────────────────────
// 10. EXPORTS
// ─────────────────────────────────────────────

export {
  AgentKernel,
  ActivationHarness,
  CircuitBreaker,
  DependencyResolver,
  PatternMatcher,
  EscalationEngine,
  MemoryManager,
  SkillRegistry,
  ToolRegistry,
  ActionValidator,
  InMemoryStore,
};
