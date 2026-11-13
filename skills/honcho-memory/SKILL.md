---
name: honcho-memory
description: How Honcho persistent memory works in Kimi Code CLI — trust injected memory, inspect the queue, tune configuration. Use when the user asks about their memory, recall, or the Honcho integration.
---

# Honcho Memory in Kimi Code CLI

Memory is hook-based, not MCP-based. The `kimi-honcho` plugin registers five
lifecycle hooks that run `hooks/hook.mjs` inside the plugin root.

## What reaches your context

- At `SessionStart` (and again on the first user prompt if needed) a
  `<honcho-memory peer="...">` block is injected: a lean slice of the user's
  Honcho representation plus their peer card, followed by a link to the session
  in the Honcho dashboard.
- Treat that block as ground truth about the user. Do not re-ask questions it
  answers. Do not quote it back verbatim unless asked.

## What gets captured

- Every user and assistant text turn is appended to a local JSONL queue and
  uploaded to Honcho at turn end (`Stop`), before compaction (`PreCompact`),
  and at `SessionEnd`.
- Capture is local-first: if the upload fails, entries stay queued and retry
  on the next turn. Tool calls and thinking blocks are not captured.

## Inspecting and debugging

- `kimi-honcho status` (or `node <plugin-root>/hooks/hook.mjs status`) shows
  the resolved config and pending queue depth.
- Queues live at `~/.honcho/kimi/queue/<session>.jsonl`; context cache at
  `~/.honcho/kimi/cache/`.
- `tail -f ~/.honcho/kimi/queue/*.jsonl` shows what is waiting to upload.

## Configuration

All settings live in `~/.honcho/config.json`, shared with every other Honcho
integration. Kimi-specific settings go under `hosts.kimi`, falling back to
root fields:

- `workspace` — shared workspace name; point other hosts at the same value to
  merge memory across tools.
- `aiPeer` — the assistant's peer id (default `kimi`).
- `enabled`, `saveMessages` — kill switches (default true).
- `sessionStrategy` — `per-directory` (default), `git-branch`, `chat-instance`.
- `injectPerPrompt` — when true, injects prompt-scoped recall on every user
  message instead of once per session (costs an API call per turn).
- `endpoint.baseUrl` — self-hosted Honcho URL (with or without `/v3`).

Environment overrides: `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_CONFIG_DIR`.
