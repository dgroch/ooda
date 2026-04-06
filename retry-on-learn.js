const MAX_LEARN_RETRIES = Number(process.env.MAX_LEARN_RETRIES ?? 2);

function clampConfidence(value, fallback = 0.5) {
  const n = Number(value);
  if (Number.isFinite(n) === false) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normaliseText(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function capabilityMatchesGap(acquisitionEvent, gap) {
  const capabilityType = acquisitionEvent?.capabilityType ?? acquisitionEvent?.type ?? null;
  const capabilityId = acquisitionEvent?.capabilityId ?? acquisitionEvent?.capability?.id ?? null;
  if (Boolean(capabilityType) === false || Boolean(capabilityId) === false || Boolean(gap) === false) return false;

  const text = `${normaliseText(gap.description)} ${normaliseText(gap.reason)}`;

  if (capabilityType === 'skill') {
    if (gap.skillRequired && gap.skillRequired === capabilityId) return true;
    if (text.includes(normaliseText(capabilityId))) return true;
    return false;
  }

  if (capabilityType === 'tool') {
    const toolsRequired = Array.isArray(gap.toolsRequired) ? gap.toolsRequired : [];
    if (toolsRequired.includes(capabilityId)) return true;
    if (text.includes(normaliseText(capabilityId))) return true;
    return false;
  }

  if (capabilityType === 'pattern') {
    return Boolean(gap.stepId) && gap.stepId === acquisitionEvent?.gapContext?.stepId;
  }

  return false;
}

function shouldRetry(acquisitionEvent, goal, gapHistory) {
  try {
    if (Boolean(acquisitionEvent) === false || Boolean(goal) === false) {
      return { retry: false, reason: 'Missing acquisition event or goal' };
    }

    const stepId = acquisitionEvent?.gapContext?.stepId ?? null;
    const step = Array.isArray(goal?.steps)
      ? goal.steps.find((s) => s.id === stepId)
      : null;

    if (Boolean(step) === false) {
      return { retry: false, reason: 'Step no longer exists on goal' };
    }

    if (step.status === 'done' || step.status === 'removed') {
      return { retry: false, reason: `Step status ${step.status} is not retryable` };
    }

    if (step.status !== 'pending' && step.status !== 'blocked') {
      return { retry: false, reason: `Step status ${step.status} is not pending/blocked` };
    }

    const history = Array.isArray(gapHistory) ? gapHistory : [];
    const gapId = acquisitionEvent?.gapContext?.gapId ?? null;
    const gap = history.find((g) => g.id === gapId) ?? history[history.length - 1] ?? null;
    if (Boolean(gap) === false) {
      return { retry: false, reason: 'No matching gap found for retry' };
    }

    if (capabilityMatchesGap(acquisitionEvent, gap) === false) {
      return { retry: false, reason: 'Acquired capability does not match the gap requirements' };
    }

    const retryCount = Number(acquisitionEvent?.retryCount ?? acquisitionEvent?.gapContext?.retryCount ?? 0);
    if (retryCount >= MAX_LEARN_RETRIES) {
      return { retry: false, reason: `Retry limit reached (${MAX_LEARN_RETRIES})` };
    }

    return { retry: true, reason: 'Acquired capability matches gap and step is retryable' };
  } catch (err) {
    return { retry: false, reason: `Retry check failed: ${err?.message ?? 'unknown error'}` };
  }
}

function buildRetryContext(acquisitionEvent, gap, previousFailure = null) {
  const capability = acquisitionEvent?.capability ?? {};
  const capabilityName = capability.name ?? acquisitionEvent?.capabilityId ?? 'new capability';
  const gapDescription = gap?.description ?? 'a missing capability';

  return {
    acquiredCapability: {
      type: acquisitionEvent?.capabilityType ?? acquisitionEvent?.type ?? null,
      id: acquisitionEvent?.capabilityId ?? capability.id ?? null,
      name: capabilityName,
      description: capability.description ?? '',
    },
    previousGap: {
      gapType: gap?.gapType ?? null,
      description: gapDescription,
    },
    previousFailure: {
      error: previousFailure?.error ?? gap?.lastError ?? null,
      actionType: previousFailure?.actionType ?? null,
    },
    instruction: `You previously failed because ${gapDescription}. You have now acquired ${capabilityName}. Try again.`,
  };
}

async function updateSkillConfidence(memory, acquisitionEvent, delta) {
  try {
    const type = acquisitionEvent?.capabilityType ?? acquisitionEvent?.type ?? null;
    const skillId = acquisitionEvent?.capabilityId ?? acquisitionEvent?.capability?.id ?? null;
    if (type !== 'skill' || Boolean(skillId) === false || Boolean(memory?.getSkills) === false || Boolean(memory?.addSkill) === false) {
      return null;
    }

    const skills = await memory.getSkills();
    const existing = Array.isArray(skills) ? skills.find((s) => s.id === skillId) : null;
    const base = clampConfidence(existing?.confidence ?? acquisitionEvent?.capability?.confidence ?? 0.5);
    const updated = {
      ...(existing ?? acquisitionEvent?.capability ?? { id: skillId }),
      id: skillId,
      confidence: clampConfidence(base + delta),
      updatedAt: new Date().toISOString(),
    };
    await memory.addSkill(updated);
    return updated;
  } catch {
    return null;
  }
}

async function recordRetryOutcome(outcome, gap, acquisitionEvent, memory) {
  try {
    const success = outcome?.success === true;
    const stepId = acquisitionEvent?.gapContext?.stepId ?? gap?.stepId ?? null;

    if (success) {
      const resolvedGap = {
        ...(gap ?? {}),
        status: 'resolved',
        resolvedAt: new Date().toISOString(),
      };
      if (memory?.saveGap) await memory.saveGap(resolvedGap);
      await updateSkillConfidence(memory, acquisitionEvent, 0.1);
      if (memory?.resetRetryCount && stepId) await memory.resetRetryCount(stepId);

      if (memory?.recordEpisode) {
        await memory.recordEpisode({
          type: 'retry_on_learn',
          event: 'retry_succeeded',
          goalId: acquisitionEvent?.gapContext?.goalId ?? gap?.goalId ?? null,
          stepId,
          data: {
            gapId: gap?.id ?? acquisitionEvent?.gapContext?.gapId ?? null,
            capabilityType: acquisitionEvent?.capabilityType ?? acquisitionEvent?.type ?? null,
            capabilityId: acquisitionEvent?.capabilityId ?? null,
            outcome,
          },
        });
      }
      return { success: true, escalated: false };
    }

    const persistentGap = {
      ...(gap ?? {}),
      status: 'persistent',
      persistentAt: new Date().toISOString(),
      lastError: outcome?.error ?? null,
    };
    if (memory?.saveGap) await memory.saveGap(persistentGap);
    await updateSkillConfidence(memory, acquisitionEvent, -0.1);

    let retryCount = 0;
    if (memory?.getRetryCount && stepId) retryCount = await memory.getRetryCount(stepId);
    const escalated = retryCount >= MAX_LEARN_RETRIES;

    if (memory?.recordEpisode) {
      await memory.recordEpisode({
        type: 'retry_on_learn',
        event: escalated ? 'retry_failed_limit_reached' : 'retry_failed',
        goalId: acquisitionEvent?.gapContext?.goalId ?? gap?.goalId ?? null,
        stepId,
        data: {
          gapId: gap?.id ?? acquisitionEvent?.gapContext?.gapId ?? null,
          capabilityType: acquisitionEvent?.capabilityType ?? acquisitionEvent?.type ?? null,
          capabilityId: acquisitionEvent?.capabilityId ?? null,
          retryCount,
          maxRetries: MAX_LEARN_RETRIES,
          outcome,
        },
      });
    }

    return { success: false, escalated };
  } catch (err) {
    return {
      success: false,
      escalated: false,
      error: `recordRetryOutcome failed: ${err?.message ?? 'unknown error'}`,
    };
  }
}

export {
  MAX_LEARN_RETRIES,
  shouldRetry,
  buildRetryContext,
  recordRetryOutcome,
};
