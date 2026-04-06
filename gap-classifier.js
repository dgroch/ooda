const VAGUE_STEP_PATTERNS = [
  /^handle it$/i,
  /^do it$/i,
  /^tbd$/i,
  /^todo$/i,
  /^fix it$/i,
  /^stuff$/i,
];

function toSet(values) {
  if (!values) return new Set();
  if (values instanceof Set) return values;
  if (!Array.isArray(values)) return new Set();
  return new Set(
    values
      .map((item) => (typeof item === 'string' ? item : item?.id))
      .filter(Boolean),
  );
}

function isAuthorityReason(reason) {
  if (!reason || typeof reason !== 'string') return false;
  return /(authority|approval|permission|authorize|authorisation|budget sign-?off)/i.test(reason);
}

function isAmbiguousStep(stepDescription) {
  if (typeof stepDescription !== 'string') return false;
  const trimmed = stepDescription.trim();
  if (trimmed.length > 0 && trimmed.length < 10) return true;
  return VAGUE_STEP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Structural first-pass classifier.
 * Never throws: always returns a valid classification.
 */
function classifyGap(context = {}) {
  try {
    const skillRequired = typeof context.skillRequired === 'string' ? context.skillRequired.trim() : '';
    const toolsRequired = Array.isArray(context.toolsRequired) ? context.toolsRequired.filter(Boolean) : [];
    const skillRegistry = toSet(context.skillRegistry ?? context.availableSkills);
    const toolRegistry = toSet(context.toolRegistry ?? context.availableTools);

    if (skillRequired && !skillRegistry.has(skillRequired)) {
      return {
        gapType: 'procedural',
        confidence: 0.9,
        reason: `Required skill "${skillRequired}" is not registered`,
      };
    }

    const missingTools = toolsRequired.filter((toolId) => !toolRegistry.has(toolId));
    if (missingTools.length > 0) {
      return {
        gapType: 'tool',
        confidence: 0.9,
        reason: `Required tools missing: ${missingTools.join(', ')}`,
      };
    }

    if (isAuthorityReason(context.escalationReason ?? context.reason)) {
      return {
        gapType: 'authority',
        confidence: 0.85,
        reason: 'Escalation reason indicates approval or permission is required',
      };
    }

    if (isAmbiguousStep(context.stepDescription)) {
      return {
        gapType: 'ambiguity',
        confidence: 0.8,
        reason: 'Step description is too vague to execute safely',
      };
    }

    return {
      gapType: 'knowledge',
      confidence: 0.6,
      reason: 'Default fallback: insufficient information for a more specific gap type',
    };
  } catch (err) {
    return {
      gapType: 'knowledge',
      confidence: 0.5,
      reason: `Classifier fallback due to error: ${err?.message ?? 'unknown error'}`,
    };
  }
}

function createGapEvent(classification = {}, context = {}) {
  const safeType = ['knowledge', 'procedural', 'tool', 'authority', 'ambiguity'].includes(classification.gapType)
    ? classification.gapType
    : 'knowledge';
  const detectedAt = new Date().toISOString();

  return {
    id: context.id ?? `gap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    goalId: String(context.goalId ?? 'unknown_goal'),
    stepId: String(context.stepId ?? 'unknown_step'),
    gapType: safeType,
    description: context.description ?? classification.reason ?? 'Capability gap detected',
    confidence: Number.isFinite(classification.confidence) ? classification.confidence : 0.5,
    detectedAt,
    detectedBy: context.detectedBy ?? 'kernel',
    context: {
      stepDescription: context.stepDescription ?? '',
      skillRequired: context.skillRequired ?? null,
      toolsRequired: Array.isArray(context.toolsRequired) ? context.toolsRequired : [],
      priorAttempts: Number.isFinite(context.priorAttempts) ? context.priorAttempts : 0,
      lastError: context.lastError ?? null,
    },
  };
}

export { classifyGap, createGapEvent };
