# kimi-honcho

Persistent memory for [Kimi Code CLI](https://www.kimi.com/code/docs/en/), powered by [Honcho](https://honcho.dev) from Plastic Labs.

A native Kimi Code CLI **plugin** — lifecycle hooks capture each session to Honcho and inject relevant context back at session start. No MCP server required. A sibling of [codex-honcho](https://github.com/plastic-labs/codex-honcho) and [claude-honcho](https://github.com/plastic-labs/claude-honcho), sharing the same `~/.honcho/config.json`.

## What You Get

- **Persistent Memory** — Kimi remembers your preferences, projects, and context across sessions
- **Survives Context Resets** — memory persists through compaction and restarts
- **Cross-Tool Context** — shares `~/.honcho/config.json` with the Claude Code, Codex, DeepSeek Harness, and Devin integrations; point them at the same `workspace` for one shared memory
- **Local-First Capture** — turns queue to disk instantly and upload at turn end; capture never blocks your turn mid-conversation
- **Zero Dependencies** — the hooks are plain Node (>= 18), no SDK install needed

## Prerequisites

- Kimi Code CLI with plugin + hook support
- Node >= 18 on your `PATH`
- A Honcho API key from [app.honcho.dev](https://app.honcho.dev), or a self-hosted Honcho

## Quick Start

### Step 1: Save your API key

Your key lives in `~/.honcho/config.json` — the single file every Honcho integration reads. Already using claude-honcho or codex-honcho? Nothing to do. Otherwise:

```
honcho init   # uv tool install honcho-cli if you don't have the CLI
```

### Step 2: Seed config and install the plugin

```
node bin/kimi-honcho.mjs install     # or `npx kimi-honcho install` once published
```

This seeds `hosts.kimi` in `~/.honcho/config.json`, removes any legacy manual hook block, and prints the install line. Then, inside Kimi Code CLI:

```
/plugins install /path/to/kimi-honcho
/reload
```

(From GitHub, once pushed: `/plugins install https://github.com/<owner>/kimi-honcho`.)

### Step 3: Start a new session

Memory loads into context at session start. Check `/kimi-honcho:status` any time for workspace, peer, and pending upload depth.

## Commands

| Command | Effect |
| - | - |
| `kimi-honcho install` | Seed `hosts.kimi`, migrate legacy hooks, print plugin install line |
| `kimi-honcho status` | Resolved config, managed-copy path, pending queue depth |
| `kimi-honcho remove` | Print plugin removal instructions |
| `/kimi-honcho:status` | Same, from inside a session |

## Configuration

All settings live in `~/.honcho/config.json`. Kimi-specific settings go under `hosts.kimi`, falling back to root fields (same resolution as `hosts.codex`):

| Field | Default | Meaning |
| - | - | - |
| `workspace` | `"kimi"` | Shared workspace; set the same value on other hosts to merge memory |
| `aiPeer` | `"kimi"` | Assistant peer id |
| `enabled` / `saveMessages` | `true` | Kill switches |
| `sessionStrategy` | `per-directory` | `per-directory`, `git-branch`, or `chat-instance` |
| `injectPerPrompt` | `false` | Inject prompt-scoped recall every turn (one API call per turn) |
| `endpoint.baseUrl` | Honcho cloud | Self-hosted URL, with or without `/v3` |

Environment overrides: `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_CONFIG_DIR`. An explicit `sessions[cwd]` mapping pins a directory to a session name.

## How It Works

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Kimi Code CLI                             │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart    │  UserPromptSubmit │  Stop / PreCompact │ SessionEnd│
│  ─────────────   │  ──────────────── │  ───────────────── │ ───────── │
│  recall:         │  prompt:          │  writeback:        │ flush:    │
│  materialize the │  inject the       │  capture new turns │ final     │
│  session, fetch  │  <honcho-memory>  │  from wire.jsonl   │ drain     │
│  peer context    │  block once       │  and upload        │           │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
          ~/.honcho/kimi/queue/<session>.jsonl  (append-only, local-first)
                              │
                              ▼
                       Honcho API  →  Persistent Memory
```

- **SessionStart** (`recall`) — creates/materializes the Honcho session and peers and caches the user's representation + peer card.
- **UserPromptSubmit** (`prompt`) — injects the `<honcho-memory>` block once per session (SessionStart stdout injection is not guaranteed by the CLI, so this is the reliable path). With `injectPerPrompt: true`, runs prompt-scoped recall every turn instead.
- **Stop / PreCompact** (`writeback`) — parses the new tail of the session's `wire.jsonl` transcript, dedupes resume replays, and uploads user + assistant turns to Honcho. Failed uploads stay queued.
- **SessionEnd** (`flush`) — final capture and drain.

Inspect the local queue with `tail -f ~/.honcho/kimi/queue/*.jsonl`; `kimi-honcho status` shows pending depth.

## What Install Writes

| Path | Change |
| - | - |
| `~/.honcho/config.json` | Seeds `hosts.kimi` (existing blocks untouched) |
| `~/.kimi-code/config.toml` | Removes legacy `honcho-kimi-hooks` block if present |
| `~/.kimi-code/plugins/managed/kimi-honcho/` | Managed copy, written by `/plugins install` |

`/plugins remove kimi-honcho` reverses the plugin; local queues stay until you delete `~/.honcho/kimi/`.

## Layout

```
kimi.plugin.json          manifest: hooks, skill, command, system prompt
SYSTEM.md                 always-on memory directives
hooks/hook.mjs            recall · prompt · writeback · flush · status (zero deps)
bin/kimi-honcho.mjs       CLI: install · status · remove · <hook verb>
skills/honcho-memory/     memory usage guidance for the model
commands/status.md        /kimi-honcho:status slash command
```

## License

MIT — see LICENSE. Adapted from [plastic-labs/codex-honcho](https://github.com/plastic-labs/codex-honcho) (MIT).

## Links

- **Honcho**: [honcho.dev](https://honcho.dev)
- **Kimi Code CLI plugins**: [docs](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
- **Kimi Code CLI hooks**: [docs](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
