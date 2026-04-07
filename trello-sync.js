/**
 * Trello Sync Adapter
 *
 * Bidirectional sync between OODA kernel (SQLite) and Trello board.
 *
 * Mapping:
 *   - Goal → Card on "Goals" list (or list named after goal priority)
 *   - Step → Checklist item on goal card
 *   - Step status → checklist item checked/unchecked
 *   - Gap/Research → Card comment
 *   - Escalation → Card label + comment
 *
 * Environment:
 *   TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID
 *   Or: pass as constructor options
 */

const TRELLO_BASE = 'https://api.trello.com/1';

async function trelloFetch(path, options = {}) {
  // Inject key/token as query params (Trello personal token auth)
  const sep = path.includes('?') ? '&' : '?';
  const authPath = `${path}${sep}key=${this?.apiKey}&token=${this?.token}`;
  const url = `${TRELLO_BASE}${authPath}`;
  const defaults = {
    headers: { 'Content-Type': 'application/json' },
  };
  const opts = { ...defaults, ...options };
  const response = await fetch(url, opts);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Trello ${response.status}: ${err}`);
  }
  return response.json();
}

export class TrelloSyncAdapter {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.TRELLO_API_KEY;
    this.token = options.token ?? process.env.TRELLO_TOKEN;
    this.boardId = options.boardId ?? process.env.TRELLO_BOARD_ID;
    this.listNameGoals = options.listNameGoals ?? 'Goals';
    this.listNameDone = options.listNameDone ?? 'Done';
    this.syncIntervalMs = options.syncIntervalMs ?? 30000;
    this._running = false;
    this._intervalId = null;
    this._trelloFetch = trelloFetch.bind({ apiKey: this.apiKey, token: this.token });

    if (!this.apiKey || !this.token || !this.boardId) {
      console.warn('[trello-sync] Missing TRELLO_API_KEY, TRELLO_TOKEN, or TRELLO_BOARD_ID — adapter disabled');
      this.disabled = true;
    }
  }

  async _getLists() {
    const lists = await this._trelloFetch(`/boards/${this.boardId}/lists?fields=id,name`);
    return lists;
  }

  async _getOrCreateList(name) {
    console.log(`[trello-sync] _getOrCreateList: ${name}`);
    const lists = await this._getLists();
    console.log(`[trello-sync] Found lists:`, lists.map(l => l.name));
    let list = lists.find((l) => l.name === name);
    if (!list) {
      console.log(`[trello-sync] Creating list: ${name}`);
      list = await this._trelloFetch(`/boards/${this.boardId}/lists`, {
        method: 'POST',
        body: JSON.stringify({ name, pos: 'bottom' }),
      });
      console.log(`[trello-sync] Created list:`, list);
    }
    return list;
  }

  async _getCards(listId) {
    const path = `/lists/${listId}/cards?fields=id,name,desc,idList,labels`;
    console.log(`[trello-sync] _getCards: listId=${listId}, path=${path}`);
    console.log(`[trello-sync] _getCards: boardId=${this.boardId}, apiKey=${this.apiKey?.slice(0,8)}`);
    return this._trelloFetch(path);
  }

  async _createCard(listId, name, desc = '') {
    console.log(`[trello-sync] _createCard: listId=${listId}, name=${name}`);
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
      body: JSON.stringify({ state }), // 'complete' or 'incomplete'
    });
  }

  // ─────────────────────────────────────────────────
  // Sync: OODA → Trello
  // ─────────────────────────────────────────────────

  /**
   * Sync all goals from the store to Trello.
   * @param {Object} store - SqliteStore or InMemoryStore
   */
  async syncGoalsToTrello(store) {
    if (this.disabled) return;

    const goalsList = await this._getOrCreateList(this.listNameGoals);
    const doneList = await this._getOrCreateList(this.listNameDone);

    const goals = await store.listGoals();
    const existingCards = await this._getCards(goalsList.id);
    const existingCardByGoalId = new Map();
    for (const card of existingCards) {
      // Extract goal ID from card description (stored as JSON)
      try {
        const desc = JSON.parse(card.desc);
        if (desc.goalId) existingCardByGoalId.set(desc.goalId, card);
      } catch {
        // Not a goal card
      }
    }

    for (const row of goals) {
      const goal = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (!goal) continue;

      let card = existingCardByGoalId.get(goal.id);
      const goalData = JSON.stringify({ goalId: goal.id, status: goal.status, progress: 0 });
      const cardName = `${goal.description?.slice(0, 60) ?? 'Untitled Goal'}`;

      if (!card) {
        // Create new card
        card = await this._createCard(goalsList.id, cardName, goalData);
      } else if (card.name !== cardName) {
        // Update card name if changed
        await this._updateCard(card.id, { name: cardName, desc: goalData });
      }

      // Move to Done list if goal is complete
      if (goal.status === 'done' && card.idList !== doneList.id) {
        await this._updateCard(card.id, { idList: doneList.id });
      } else if (goal.status !== 'done' && card.idList !== goalsList.id) {
        await this._updateCard(card.id, { idList: goalsList.id });
      }

      // Sync steps as checklist items
      await this._syncStepsToCard(card.id, goal);
    }
  }

  async _syncStepsToCard(cardId, goal) {
    const checklists = await this._getChecklists(cardId);
    let stepsChecklist = checklists.find((c) => c.name === 'Steps');

    if (!goal.steps || goal.steps.length === 0) return;

    if (!stepsChecklist) {
      stepsChecklist = await this._addChecklist(cardId, 'Steps');
    }

    // Get existing check items
    const existingItems = new Map();
    for (const item of stepsChecklist.checkItems) {
      existingItems.set(item.name, item);
    }

    // Upsert steps
    for (const step of goal.steps) {
      const itemName = step.description?.slice(0, 100) ?? step.id;
      const item = existingItems.get(itemName);

      if (!item) {
        // Create new check item
        await this._addChecklist(stepsChecklist.id, itemName);
      } else {
        // Update state if changed
        const expectedState = step.status === 'done' ? 'complete' : 'incomplete';
        if (item.state !== expectedState) {
          await this._updateCheckItem(cardId, item.id, expectedState);
        }
      }
    }
  }

  /**
   * Post a gap detection or research result as a comment.
   */
  async postGapComment(store, gap) {
    if (this.disabled) return;

    // Find the goal card
    const goalsList = await this._getOrCreateList(this.listNameGoals);
    const cards = await this._getCards(goalsList.id);

    const goalCard = cards.find((c) => {
      try {
        const desc = JSON.parse(c.desc);
        return desc.goalId === gap.goalId;
      } catch {
        return false;
      }
    });

    if (!goalCard) return;

    const comment = `[GAP] ${gap.gapType}: ${gap.description?.slice(0, 100) ?? 'Unknown gap'}`;
    await this._addComment(goalCard.id, comment);
  }

  /**
   * Post an escalation as a labeled comment.
   */
  async postEscalationComment(store, message) {
    if (this.disabled) return;

    // Find the goal card
    const goalsList = await this._getOrCreateList(this.listNameGoals);
    const cards = await this._getCards(goalsList.id);

    const goalCard = cards.find((c) => {
      try {
        const desc = JSON.parse(c.desc);
        return desc.goalId === message.goalId;
      } catch {
        return false;
      }
    });

    if (!goalCard) return;

    const comment = `[ESCALATE] ${message.content?.slice(0, 200) ?? 'Escalation'}`;
    await this._addComment(goalCard.id, comment);
  }

  // ─────────────────────────────────────────────────
  // Sync: Trello → OODA (human moves card)
  // ─────────────────────────────────────────────────

  /**
   * Pull changes from Trello: check for manual card moves or check item toggles.
   * Returns updates to apply to the store.
   */
  async syncFromTrello(store) {
    if (this.disabled) return { goals: [], steps: [] };

    const updates = { goals: [], steps: [] };
    const goalsList = await this._getOrCreateList(this.listNameGoals);
    const cards = await this._getCards(goalsList.id);

    for (const card of cards) {
      try {
        const meta = JSON.parse(card.desc);
        if (!meta.goalId) continue;

        const goals = await store.listGoals();
        const goalRow = goals.find((g) => g.id === meta.goalId);
        if (!goalRow) continue;

        const goal = typeof goalRow.data === 'string' ? JSON.parse(goalRow.data) : goalRow.data;

        // Check if manually moved to Done
        if (card.idList === 'done' && goal.status !== 'done') {
          updates.goals.push({ id: goal.id, status: 'done' });
        }

        // Check step completion from checklist
        const checklists = await this._getChecklists(card.id);
        const stepsChecklist = checklists.find((c) => c.name === 'Steps');
        if (stepsChecklist && goal.steps) {
          for (const item of stepsChecklist.checkItems) {
            const step = goal.steps.find((s) => (s.description?.slice(0, 100) ?? s.id) === item.name);
            if (step) {
              const expectedStatus = item.state === 'complete' ? 'done' : 'pending';
              if (step.status !== expectedStatus) {
                updates.steps.push({ goalId: goal.id, stepId: step.id, status: expectedStatus });
              }
            }
          }
        }
      } catch {
        // Not a goal card or parse error
      }
    }

    return updates;
  }

  // ─────────────────────────────────────────────────
  // Auto-sync loop
  // ─────────────────────────────────────────────────

  /**
   * Start periodic sync.
   * @param {Function} onTrelloChange - callback(updates) when Trello has human changes
   */
  start(store, onTrelloChange) {
    if (this.disabled) return;
    if (this._running) return;

    this._running = true;
    console.log('[trello-sync] Starting sync loop');

    this._intervalId = setInterval(async () => {
      try {
        // Push OODA changes to Trello
        await this.syncGoalsToTrello(store);

        // Pull Trello changes back to OODA
        const updates = await this.syncFromTrello(store);
        if ((updates.goals.length > 0 || updates.steps.length > 0) && onTrelloChange) {
          onTrelloChange(updates);
        }
      } catch (err) {
        console.error('[trello-sync] Sync error:', err.message);
      }
    }, this.syncIntervalMs);
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