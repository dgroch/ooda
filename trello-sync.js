/**
 * Trello Sync Adapter v2
 *
 * Full bidirectional sync with workflow:
 * - Draft -> Goals: triggers OODA activation
 * - Goals -> Doing: when kernel starts processing
 * - Kernel events: verbose comments on card
 * - Escalations: move to Escalations + @mention
 * - Complete: move to Done
 *
 * Lists: Draft, Goals, Doing, Escalations, Done
 */

const TRELLO_BASE = 'https://api.trello.com/1';

async function trelloFetch(path, options = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const authPath = `${path}${sep}key=${this?.apiKey}&token=${this?.token}`;
  const url = `${TRELLO_BASE}${authPath}`;
  const isWrite = options.method && options.method !== 'GET';
  const headers = isWrite ? { 'Content-Type': 'application/json' } : {};
  const opts = { ...options, headers: { ...headers, ...(options.headers ?? {}) } };
  console.log(`[trello-fetch] ${opts.method ?? 'GET'} ${url.replace(/key=[^&]+/, 'key=***').replace(/token=[^&]+/, 'token=***')}`);
  const response = await fetch(url, opts);
  if (!response.ok) {
    const err = await response.text();
    console.error(`[trello-fetch] ${response.status}: ${err}`);
    throw new Error(`Trello ${response.status}: ${err}`);
  }
  return response.json();
}

export class TrelloSyncAdapter {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.TRELLO_API_KEY;
    this.token = options.token ?? process.env.TRELLO_TOKEN;
    this.boardId = options.boardId ?? process.env.TRELLO_BOARD_ID;
    this.syncIntervalMs = options.syncIntervalMs ?? 30000;
    this._running = false;
    this._intervalId = null;
    this._trelloFetch = trelloFetch.bind({ apiKey: this.apiKey, token: this.token });

    // Store reference to server's fetch for triggering goals
    this._triggerGoalApi = options.triggerGoalApi ?? null;

    if (!this.apiKey || !this.token || !this.boardId) {
      console.warn('[trello-sync] Missing TRELLO_API_KEY, TRELLO_TOKEN, or TRELLO_BOARD_ID — adapter disabled');
      this.disabled = true;
    }
  }

  async _init() {
    const lists = await this._trelloFetch(`/boards/${this.boardId}/lists?fields=id,name`);
    this.listIds = {
      draft: lists.find(l => l.name === 'Draft')?.id,
      goals: lists.find(l => l.name === 'Goals')?.id,
      doing: lists.find(l => l.name === 'Doing')?.id,
      escalations: lists.find(l => l.name === 'Escalations')?.id,
      done: lists.find(l => l.name === 'Done')?.id,
    };
    console.log('[trello-sync] Lists:', this.listIds);
    // Get member ID for mentions
    const members = await this._trelloFetch(`/boards/${this.boardId}/members?fields=id,username`);
    this.danMember = members.find(m => m.username === 'danielgroch');
    console.log('[trello-sync] Dan member:', this.danMember);
  }

  async _getCards(listId) {
    return this._trelloFetch(`/lists/${listId}/cards?fields=id,name,desc,idList,checklists`);
  }

  async _createCard(listId, name, desc = '') {
    return this._trelloFetch(`/cards`, {
      method: 'POST',
      body: JSON.stringify({ idList: listId, name, desc }),
    });
  }

  async _updateCard(cardId, updates) {
    return this._trelloFetch(`/cards/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  async _addComment(cardId, text) {
    return this._trelloFetch(`/cards/${cardId}/actions/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  async _getChecklists(cardId) {
    return this._trelloFetch(`/cards/${cardId}/checklists?fields=id,name,checkItems`);
  }

  async _addChecklist(cardId, name) {
    return this._trelloFetch(`/cards/${cardId}/checklists`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async _addCheckItem(checklistId, name, pos = 'bottom') {
    return this._trelloFetch(`/checklists/${checklistId}/checkItems`, {
      method: 'POST',
      body: JSON.stringify({ name, pos }),
    });
  }

  async _updateCheckItem(cardId, checkItemId, state) {
    return this._trelloFetch(`/cards/${cardId}/checkItems/${checkItemId}`, {
      method: 'PUT',
      body: JSON.stringify({ state }),
    });
  }

  // ─────────────────────────────────────────────────
  // Sync: Trello → OODA (trigger new goals from Draft→Goals)
  // ─────────────────────────────────────────────────

  async syncTrelloToOODA(store) {
    if (this.disabled || !this.listIds.goals) return [];

    const goalsListCards = await this._getCards(this.listIds.goals);
    const doingListCards = this.listIds.doing ? await this._getCards(this.listIds.doing) : [];

    // Scan Goals list for new cards + Doing list for stuck cards (steps:[])
    const cardsToCheck = [
      ...goalsListCards,
      ...doingListCards.filter(c => {
        try { const m = JSON.parse(c.desc); return m.oodaManaged && Array.isArray(m.steps) && m.steps.length === 0; } catch { return false; }
      }),
    ];

    const triggeredGoals = [];

    for (const card of cardsToCheck) {
      let meta = {};
      try {
        meta = card.desc ? JSON.parse(card.desc) : {};
      } catch {
        // No valid JSON in desc, treat as new
      }

      // Trigger if: no OODA metadata, OR managed but steps were 0 and now there are steps
      const stepsAreMissing = meta.oodaManaged && Array.isArray(meta.steps) && meta.steps.length === 0;
      if (!meta.oodaManaged || stepsAreMissing) {
        console.log(`[trello-sync] NEW GOAL from Trello: "${card.name}"`);

        // Extract steps from ALL checklists on the card
        const checklists = await this._getChecklists(card.id);
        const allCheckItems = checklists.flatMap(c => c.checkItems ?? []);
        const steps = allCheckItems.map((item, idx) => ({
          id: `step_${idx + 1}`,
          description: item.name,
          status: item.state === 'complete' ? 'done' : 'pending',
        }));
        console.log(`[trello-sync] Found ${checklists.length} checklists, ${steps.length} steps:`, steps.map(s => s.description));

        // If still no steps, skip — wait for user to add them
        if (steps.length === 0) {
          console.log(`[trello-sync] No steps yet for "${card.name}" — waiting`);
          continue;
        }

        // Trigger OODA via API
        if (this._triggerGoalApi) {
          try {
            await this._triggerGoalApi({
              id: `trello_${card.id.slice(0, 8)}`,
              description: card.name,
              steps,
            });
            await this._addComment(card.id, `[🤖 OODA] Goal activated with ${steps.length} steps`);

            // Mark as OODA managed
            meta = { oodaManaged: true, goalId: card.id, steps: steps.map(s => s.id) };
            await this._updateCard(card.id, { desc: JSON.stringify(meta) });

            // Move to Doing
            if (this.listIds.doing) {
              await this._updateCard(card.id, { idList: this.listIds.doing });
              await this._addComment(card.id, `[🤖 OODA] Processing... moved to Doing`);
            }

            triggeredGoals.push({ cardId: card.id, goalId: meta.goalId, steps });
          } catch (err) {
            console.error('[trello-sync] Failed to trigger goal:', err.message);
            await this._addComment(card.id, `[❌ OODA] Failed to activate: ${err.message}`);
          }
        }
      }
    }

    return triggeredGoals;
  }

  // ─────────────────────────────────────────────────
  // Sync: OODA → Trello (update existing goals)
  // ─────────────────────────────────────────────────

  async syncOODAToTrello(store, kernelEvents = []) {
    if (this.disabled || !this.listIds.goals) return;

    const allListIds = [this.listIds.goals, this.listIds.doing, this.listIds.escalations];
    const allCards = [];
    for (const lid of allListIds) {
      if (lid) allCards.push(...await this._getCards(lid));
    }

    // Get all goals from OODA
    const oodaGoals = await store.listGoals();

    for (const card of allCards) {
      let meta = {};
      try {
        meta = card.desc ? JSON.parse(card.desc) : {};
      } catch {
        continue;
      }

      if (!meta.oodaManaged) continue;

      // Find corresponding OODA goal
      const oodaGoal = oodaGoals.find(g => {
        const gData = typeof g.data === 'string' ? JSON.parse(g.data) : g.data;
        return gData?.id === meta.goalId;
      });

      if (!oodaGoal) continue;

      const goal = typeof oodaGoal.data === 'string' ? JSON.parse(oodaGoal.data) : oodaGoal.data;

      // Sync step checklist
      const checklists = await this._getChecklists(card.id);
      let stepsChecklist = checklists.find(c => c.name === 'Steps');

      if (goal.steps?.length && !stepsChecklist) {
        stepsChecklist = await this._addChecklist(card.id, 'Steps');
      }

      if (stepsChecklist && goal.steps) {
        const existingItems = new Map();
        for (const item of stepsChecklist.checkItems) {
          existingItems.set(item.name, item);
        }

        for (const step of goal.steps) {
          const itemName = step.description?.slice(0, 100) ?? step.id;
          if (!existingItems.has(itemName)) {
            await this._addCheckItem(stepsChecklist.id, itemName);
          } else {
            const item = existingItems.get(itemName);
            const expectedState = step.status === 'done' ? 'complete' : 'incomplete';
            if (item.state !== expectedState) {
              await this._updateCheckItem(card.id, item.id, expectedState);
            }
          }
        }
      }

      // Handle kernel events (verbose logging)
      const recentEvents = kernelEvents.filter(e => e.goalId === meta.goalId);
      for (const event of recentEvents) {
        let comment = '';
        switch (event.type) {
          case 'phase':
            comment = `[🤖 OODA] ${event.phase} phase (cycle ${event.cycle}, ${event.durationMs}ms)`;
            break;
          case 'escalation':
            comment = `[⚠️ ESCALATION] ${event.message}`;
            // Move to Escalations
            if (this.listIds.escalations && card.idList !== this.listIds.escalations) {
              await this._updateCard(card.id, { idList: this.listIds.escalations });
              comment += ' - Moved to Escalations';
              if (this.danMember) {
                comment += ` @${this.danMember.username}`;
              }
            }
            break;
          case 'complete':
            comment = `[✅ COMPLETE] Goal finished with ${event.progress}% progress`;
            // Move to Done
            if (this.listIds.done && card.idList !== this.listIds.done) {
              await this._updateCard(card.id, { idList: this.listIds.done });
              comment += ' - Moved to Done';
            }
            break;
          case 'error':
            comment = `[❌ ERROR] ${event.message}`;
            break;
        }
        if (comment) {
          await this._addComment(card.id, comment);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────
  // Auto-sync loop
  // ─────────────────────────────────────────────────

  start(store, onKernelEvent, triggerGoalApi) {
    if (this.disabled) return;
    if (this._running) return;

    this._triggerGoalApi = triggerGoalApi;
    this._kernelEventBuffer = [];
    this._onKernelEvent = onKernelEvent;

    this._init().then(() => {
      this._running = true;
      console.log('[trello-sync] Starting sync loop v2');

      this._intervalId = setInterval(async () => {
        try {
          // Buffer kernel events
          if (this._onKernelEvent) {
            const events = this._onKernelEvent();
            if (events?.length) {
              this._kernelEventBuffer.push(...events);
              // Keep only last 20 events
              this._kernelEventBuffer = this._kernelEventBuffer.slice(-20);
            }
          }

          // 1. Trello -> OODA: check for new goals
          await this.syncTrelloToOODA(store);

          // 2. OODA -> Trello: update existing goals
          await this.syncOODAToTrello(store, this._kernelEventBuffer);

          // Clear consumed events
          this._kernelEventBuffer = [];
        } catch (err) {
          console.error('[trello-sync] Sync error:', err.message);
        }
      }, this.syncIntervalMs);
    });
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._running = false;
    console.log('[trello-sync] Stopped');
  }

  isRunning() {
    return this._running;
  }
}

export default TrelloSyncAdapter;