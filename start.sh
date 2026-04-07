#!/bin/bash
cd /data/.openclaw/workspace/ooda
export PORT=3100
export AUTH_TOKEN=1c9bc7c87b612c57461a85d5788faab819934fdcc6caeef94c4d6c62057444dd
export DB_PATH=/data/.openclaw/workspace/ooda/agent-local.db
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_API_KEY=${OPENAI_API_KEY}
export LLM_MODEL=gpt-4o-mini
export LLM_MAX_TOKENS=4096
export LLM_TIMEOUT_MS=30000
export LLM_RETRY_MAX=3
export TRELLO_API_KEY=${TRELLO_API_KEY}
export TRELLO_TOKEN=${TRELLO_TOKEN}
export TRELLO_BOARD_ID=buuHSCC2
export TRELLO_SYNC_INTERVAL_MS=30000
export AGENT_NAME=OODA
export AGENT_ROLE=worker
export CONFIDENCE_THRESHOLD=0.4
export MAX_CYCLES=20
export GOAL_POLL_INTERVAL_MS=15000
export AUTO_RUN_GOALS=true

## exec node server.js
