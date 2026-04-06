const RESEARCHABLE_GAP_TYPES = new Set(['knowledge', 'procedural', 'tool']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureString(errors, value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function ensureStringArray(errors, value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${path} must be an array of strings`);
  }
}

function ensureNumber(errors, value, path, min = null, max = null) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.push(`${path} must be a number`);
    return;
  }
  if (min !== null && value < min) errors.push(`${path} must be >= ${min}`);
  if (max !== null && value > max) errors.push(`${path} must be <= ${max}`);
}

function validateProposedSkill(errors, value, path) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object or null`);
    return;
  }
  ensureString(errors, value.id, `${path}.id`);
  ensureString(errors, value.name, `${path}.name`);
  ensureString(errors, value.description, `${path}.description`);
  ensureStringArray(errors, value.triggerConditions, `${path}.triggerConditions`);
  ensureStringArray(errors, value.procedure, `${path}.procedure`);
  ensureStringArray(errors, value.requiredTools, `${path}.requiredTools`);
  ensureNumber(errors, value.estimatedConfidence, `${path}.estimatedConfidence`);
}

function validateProposedPattern(errors, value, path) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object or null`);
    return;
  }
  ensureString(errors, value.id, `${path}.id`);
  ensureString(errors, value.description, `${path}.description`);
  if (!Array.isArray(value.conditions) || value.conditions.some((c) => !isPlainObject(c))) {
    errors.push(`${path}.conditions must be an array of objects`);
  }
  ensureString(errors, value.expectedOutcome, `${path}.expectedOutcome`);
  ensureNumber(errors, value.confidence, `${path}.confidence`);
}

function validateProposedTool(errors, value, path) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object or null`);
    return;
  }
  ensureString(errors, value.id, `${path}.id`);
  ensureString(errors, value.name, `${path}.name`);
  ensureString(errors, value.description, `${path}.description`);
  ensureString(errors, value.executeTemplate, `${path}.executeTemplate`);
  if (typeof value.requiresInstallation !== 'boolean') {
    errors.push(`${path}.requiresInstallation must be a boolean`);
  }
}

function deriveApproach(gapType, topic, stepDescription = '') {
  switch (gapType) {
    case 'procedural':
      return `Derive a repeatable procedure for "${topic}" and map it to step "${stepDescription}".`;
    case 'tool':
      return `Identify tooling options for "${topic}" and provide a safe execution template.`;
    default:
      return `Research verified facts and practical guidance for "${topic}".`;
  }
}

function createResearchObjective(gap, goalContext = {}, stepContext = {}) {
  const topic = gap?.context?.skillRequired
    ?? stepContext.skillRequired
    ?? stepContext.description
    ?? gap?.description
    ?? 'unknown topic';
  return {
    gapId: gap?.id ?? `gap_${Date.now()}`,
    gapType: gap?.gapType ?? 'knowledge',
    goalId: gap?.goalId ?? goalContext.id ?? 'unknown_goal',
    stepId: gap?.stepId ?? stepContext.id ?? 'unknown_step',
    topic,
    approach: deriveApproach(gap?.gapType, topic, stepContext?.description ?? gap?.context?.stepDescription ?? ''),
    successCriteria: `Return a valid ResearchResult that addresses gap "${gap?.id ?? 'unknown_gap'}" with actionable findings.`,
    maxAttempts: 3,
    currentAttempt: 1,
  };
}

function validateResearchResult(result) {
  const errors = [];
  if (!isPlainObject(result)) {
    return { valid: false, errors: ['result must be an object'] };
  }

  ensureString(errors, result.gapId, 'gapId');
  ensureString(errors, result.gapType, 'gapType');
  if (!['resolved', 'partial', 'failed'].includes(result.status)) {
    errors.push(`status must be one of: resolved, partial, failed`);
  }
  ensureString(errors, result.findings, 'findings');
  ensureNumber(errors, result.confidence, 'confidence', 0, 1);
  validateProposedSkill(errors, result.proposedSkill, 'proposedSkill');
  validateProposedPattern(errors, result.proposedPattern, 'proposedPattern');
  validateProposedTool(errors, result.proposedTool, 'proposedTool');
  ensureStringArray(errors, result.evidence, 'evidence');
  if (typeof result.requiresHumanApproval !== 'boolean') {
    errors.push('requiresHumanApproval must be a boolean');
  }

  return { valid: errors.length === 0, errors };
}

function shouldTriggerResearch(gap, gapHistory = []) {
  if (!gap || !RESEARCHABLE_GAP_TYPES.has(gap.gapType)) return false;
  const resolvedPreviously = gapHistory.some((entry) => entry?.status === 'resolved');
  return !resolvedPreviously;
}

export {
  createResearchObjective,
  validateResearchResult,
  shouldTriggerResearch,
};
