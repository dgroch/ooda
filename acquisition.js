function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractRegistryIds(registry, key) {
  if (!registry) return new Set();
  if (registry instanceof Set) return registry;
  if (Array.isArray(registry)) return new Set(registry.map((v) => (typeof v === 'string' ? v : v?.id)).filter(Boolean));
  if (typeof registry[key] === 'function') {
    const rows = registry[key]();
    if (Array.isArray(rows)) {
      return new Set(rows.map((v) => (typeof v === 'string' ? v : v?.id)).filter(Boolean));
    }
  }
  if (Array.isArray(registry.ids)) return new Set(registry.ids.filter((v) => typeof v === 'string'));
  if (Array.isArray(registry.items)) return new Set(registry.items.map((v) => (typeof v === 'string' ? v : v?.id)).filter(Boolean));
  return new Set();
}

function hasId(registry, id) {
  if (!registry || !id) return false;
  if (typeof registry.has === 'function') {
    try {
      return registry.has(id) === true;
    } catch {
      return false;
    }
  }
  const ids = extractRegistryIds(registry, 'list');
  return ids.has(id);
}

function hasToolId(skillRegistry, toolId) {
  if (!skillRegistry || !toolId) return false;
  if (typeof skillRegistry.hasTool === 'function') {
    try {
      return skillRegistry.hasTool(toolId) === true;
    } catch {
      return false;
    }
  }
  const registeredToolIds = extractRegistryIds(skillRegistry.registeredToolIds ?? skillRegistry.tools ?? skillRegistry, 'listTools');
  return registeredToolIds.has(toolId);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateProposedSkill(skill, skillRegistry) {
  try {
    const errors = [];
    if (!isPlainObject(skill)) {
      return { valid: false, errors: ['skill must be an object'] };
    }

    if (!nonEmptyString(skill.id)) errors.push('skill.id must be a non-empty string');
    if (nonEmptyString(skill.id) && hasId(skillRegistry, skill.id)) errors.push(`skill.id "${skill.id}" already exists`);
    if (!nonEmptyString(skill.description)) errors.push('skill.description must be a non-empty string');
    if (!Array.isArray(skill.procedure) || skill.procedure.length === 0) errors.push('skill.procedure must be a non-empty array');
    if (!Array.isArray(skill.triggerConditions) || skill.triggerConditions.length === 0) errors.push('skill.triggerConditions must be a non-empty array');

    const requiredTools = asArray(skill.requiredTools).filter((toolId) => typeof toolId === 'string' && toolId.trim().length > 0);
    const coProposedToolIds = new Set(asArray(skillRegistry?.coProposedToolIds).filter((toolId) => typeof toolId === 'string'));
    for (const toolId of requiredTools) {
      if (!hasToolId(skillRegistry, toolId) && !coProposedToolIds.has(toolId)) {
        errors.push(`skill.requiredTools contains unknown tool "${toolId}"`);
      }
    }

    return { valid: errors.length === 0, errors };
  } catch (err) {
    return { valid: false, errors: [`skill validation failed: ${err?.message ?? 'unknown error'}`] };
  }
}

function validateProposedPattern(pattern, patternStore) {
  try {
    const errors = [];
    if (!isPlainObject(pattern)) {
      return { valid: false, errors: ['pattern must be an object'] };
    }

    if (!nonEmptyString(pattern.id)) errors.push('pattern.id must be a non-empty string');
    if (nonEmptyString(pattern.id) && hasId(patternStore, pattern.id)) errors.push(`pattern.id "${pattern.id}" already exists`);
    if (!Array.isArray(pattern.conditions) || pattern.conditions.length === 0) errors.push('pattern.conditions must be a non-empty array');
    if (!nonEmptyString(pattern.expectedOutcome)) errors.push('pattern.expectedOutcome must be a non-empty string');

    const confidence = Number(pattern.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      errors.push('pattern.confidence must be a number between 0 and 1');
    }

    return { valid: errors.length === 0, errors };
  } catch (err) {
    return { valid: false, errors: [`pattern validation failed: ${err?.message ?? 'unknown error'}`] };
  }
}

function validateProposedTool(tool, toolRegistry) {
  try {
    const errors = [];
    if (!isPlainObject(tool)) {
      return { valid: false, errors: ['tool must be an object'], requiresApproval: false };
    }

    if (!nonEmptyString(tool.id)) errors.push('tool.id must be a non-empty string');
    if (nonEmptyString(tool.id) && hasId(toolRegistry, tool.id)) errors.push(`tool.id "${tool.id}" already exists`);
    if (!nonEmptyString(tool.executeTemplate)) errors.push('tool.executeTemplate must be a non-empty string');
    const requiresApproval = tool.requiresInstallation === true;
    return { valid: errors.length === 0, errors, requiresApproval };
  } catch (err) {
    return {
      valid: false,
      errors: [`tool validation failed: ${err?.message ?? 'unknown error'}`],
      requiresApproval: false,
    };
  }
}

function createCapabilityAcquiredEvent(type, capability, gapContext = {}) {
  const safeType = typeof type === 'string' && type.length > 0 ? type : 'unknown';
  const event = {
    id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: safeType,
    capabilityType: safeType,
    capability: capability ?? null,
    capabilityId: capability?.id ?? null,
    source: 'self-acquired',
    gapContext: {
      gapId: gapContext?.id ?? gapContext?.gapId ?? null,
      goalId: gapContext?.goalId ?? null,
      stepId: gapContext?.stepId ?? null,
      gapType: gapContext?.gapType ?? null,
    },
    timestamp: new Date().toISOString(),
  };
  return event;
}

async function executeAcquiredSkill(skill, context = {}) {
  try {
    const goal = context.goal?.description ?? context.goal?.id ?? context.goalId ?? 'current goal';
    const step = context.step?.description ?? context.step?.id ?? context.stepId ?? 'current step';
    const procedure = asArray(skill?.procedure).filter((line) => nonEmptyString(line));
    const prompt = JSON.stringify({
      phase: 'execute_acquired_skill',
      skill: {
        id: skill?.id ?? null,
        name: skill?.name ?? skill?.id ?? 'self-acquired skill',
        description: skill?.description ?? '',
        triggerConditions: asArray(skill?.triggerConditions),
        procedure,
      },
      context: {
        goal,
        step,
        params: context.params ?? {},
      },
      instructions: 'Execute this self-acquired skill procedure for the current step. Return JSON: { "summary": "string", "artifact": "string|object", "confidence": 0.0-1.0, "notes": ["string"] }',
    });

    const reason = typeof context.reason === 'function' ? context.reason : null;
    if (!reason) {
      return {
        summary: 'Cannot execute acquired skill: missing reason function.',
        artifact: null,
        confidence: 0,
        notes: ['reason function unavailable'],
      };
    }

    const result = await reason(prompt);
    const confidence = Number(result?.confidence);
    return {
      summary: nonEmptyString(result?.summary) ? result.summary : 'Executed self-acquired skill.',
      artifact: result?.artifact ?? null,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
      notes: Array.isArray(result?.notes) ? result.notes : [],
    };
  } catch (err) {
    return {
      summary: `Acquired skill execution failed: ${err?.message ?? 'unknown error'}`,
      artifact: null,
      confidence: 0,
      notes: ['execution failed'],
    };
  }
}

async function sandboxTest(skill, goalContext = {}, stepContext = {}, reasonFn) {
  try {
    if (typeof reasonFn !== 'function') {
      return { passed: false, reason: 'Sandbox test unavailable: reason function missing' };
    }

    const prompt = JSON.stringify({
      phase: 'sandbox_skill_test',
      skill: {
        id: skill?.id ?? null,
        description: skill?.description ?? '',
        triggerConditions: asArray(skill?.triggerConditions),
        procedure: asArray(skill?.procedure),
      },
      goalContext: {
        id: goalContext?.id ?? goalContext?.goalId ?? null,
        description: goalContext?.description ?? '',
      },
      stepContext: {
        id: stepContext?.id ?? stepContext?.stepId ?? null,
        description: stepContext?.description ?? '',
      },
      instructions: 'Simulate executing this procedure in a safe sandbox. Return JSON: { "predictedOutcome": "string", "confidence": 0.0-1.0, "satisfactory": true|false, "reason": "string" }',
    });

    const simulation = await reasonFn(prompt);
    const confidence = Number(simulation?.confidence ?? 0);
    const satisfactory = simulation?.satisfactory === true || confidence > 0.4;
    if (satisfactory && confidence > 0.4) {
      return { passed: true };
    }
    return {
      passed: false,
      reason: simulation?.reason ?? simulation?.predictedOutcome ?? 'Predicted outcome confidence too low',
    };
  } catch (err) {
    return { passed: false, reason: err?.message ?? 'sandbox test failed unexpectedly' };
  }
}

export {
  validateProposedSkill,
  validateProposedPattern,
  validateProposedTool,
  createCapabilityAcquiredEvent,
  executeAcquiredSkill,
  sandboxTest,
};
