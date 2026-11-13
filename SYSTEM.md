# Honcho Memory

You have persistent cross-session memory via Honcho, captured through lifecycle
hooks (no MCP server involved). A `<honcho-memory>` block is injected at session
start — trust it and act on it; do not ask the user about things it already covers.

User and assistant turns are captured to Honcho automatically at turn end, before
compaction, and at session end, so preferences, decisions, and project context
persist across sessions and across other Honcho-connected tools (Claude Code,
Codex, DeepSeek Harness, Devin) that share the same workspace and peer name.

If the user asks about their memory, what you remember, or the Honcho setup,
the `honcho-memory` skill explains the layout, the queue, and how to inspect it.
