# FEATURE: Token budget management for context assembly in _orient

**Labels:** enhancement, performance

## Problem
`_orient()` assembles a prompt from: trigger data, all active goals (full state), 10 recent episodes (full JSON), all matched patterns, predictions, stored knowledge (all items), and team roster. With a real deployment, this will exceed context windows silently — the LLM truncates the input and the agent makes bad decisions with no error signal.

No token counting, summarisation, or relevance filtering exists anywhere in the prompt assembly chain.

## Location
`kernel.js` — `_orient()` (~line 563-573), `_buildPrompt()`, `_buildFlatState()`

## Suggested Fix
1. Add a `MAX_CONTEXT_TOKENS` config (default ~60% of model context)
2. Before calling `_orient`, calculate approximate token count of assembled prompt
3. If over budget: summarise oldest episodes, drop lowest-confidence knowledge entries, and/or truncate pattern list
4. Add a `_summarise(episodes, budget)` method using the LLM to compress episode history

This prevents silent truncation failures in production.

## Priority
Critical


**Suggested labels:** enhancement, performance
