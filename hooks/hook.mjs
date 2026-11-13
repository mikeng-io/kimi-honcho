#!/usr/bin/env node
/**
 * hook.mjs — Honcho persistent memory for Kimi Code CLI, via hooks.
 *
 * A port of plastic-labs/codex-honcho (MIT) to Kimi Code CLI's hook events:
 *
 *   SessionStart     → recall    (materialize the Honcho session + peers, cache context)
 *   UserPromptSubmit → prompt    (inject <honcho-memory> once per session, or per-turn
 *                                 curated recall when hosts.kimi.injectPerPrompt = true)
 *   Stop/PreCompact  → writeback (parse the wire.jsonl delta, upload new turns to Honcho)
 *   SessionEnd       → flush     (final capture + drain)
 *
 * Reads ~/.honcho/config.json, the same file the Claude Code and Codex
 * integrations read; kimi-specific settings live under hosts.kimi, with
 * root-level fields as fallback (mirrors hosts.codex resolution).
 *
 * Capture is local-first: hooks append to a JSONL queue under
 * ~/.honcho/kimi/queue and upload at turn end; failed uploads stay queued.
 * Zero dependencies (Node >= 18). Fail-open everywhere: a broken hook never
 * blocks the session.
 *
 * Verbs: recall | prompt | writeback | flush | status
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const HOST = "kimi";
const verb = process.argv[2] || "status";
const KIMI_HOME = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
const STORE = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
const QUEUE_DIR = join(STORE, "kimi", "queue");
const CACHE_DIR = join(STORE, "kimi", "cache");
const CACHE_TTL_MS = 10 * 60 * 1000;
const HONCHO_GUI = "https://app.honcho.dev";

const HINT =
  "This is persistent cross-session memory about the user, maintained automatically " +
  "by Honcho. Trust it and act on it — do not ask the user about things it already covers.";

// ---------------------------------------------------------------- stdin ----

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let s = "";
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(s));
  });
}

// -------------------------------------------------------------- config ----

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(STORE, "config.json"), "utf8"));
  } catch {
    return null;
  }
  const host = raw.hosts?.[HOST] || {};
  const apiKey = process.env.HONCHO_API_KEY || host.apiKey || raw.apiKey;
  if (!apiKey) return null;

  const peerName =
    process.env.HONCHO_PEER_NAME || raw.peerName || process.env.USER || process.env.USERNAME || "user";
  const globalOverride = raw.globalOverride === true;
  const pick = (k, fb) => (globalOverride ? raw[k] ?? fb : host[k] ?? raw[k] ?? fb);
  const endpoint = globalOverride ? raw.endpoint : host.endpoint ?? raw.endpoint;

  let baseUrl =
    endpoint?.baseUrl ||
    (endpoint?.environment === "local" ? "http://localhost:8000" : "https://api.honcho.dev");
  if (!baseUrl.endsWith("/v3")) baseUrl = baseUrl.replace(/\/+$/, "") + "/v3";

  return {
    apiKey,
    peerName,
    workspace: pick("workspace", HOST),
    aiPeer: pick("aiPeer", HOST),
    enabled: (host.enabled ?? raw.enabled) !== false,
    saveMessages: (host.saveMessages ?? raw.saveMessages) !== false,
    injectPerPrompt: (host.injectPerPrompt ?? raw.injectPerPrompt) === true,
    sessionStrategy: pick("sessionStrategy", "per-directory"),
    sessions: raw.sessions || {},
    baseUrl,
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
const fkey = (k) => slug(String(k)).slice(0, 80) || "default";

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// Mirrors codex-honcho session naming so all tools land in the same sessions.
function sessionName(cfg, cwd, sessionId) {
  const override = cfg.sessions[cwd];
  if (override) return override;
  const repo = slug(basename(cwd));
  switch (cfg.sessionStrategy) {
    case "git-branch": {
      const branch = currentBranch(cwd);
      return branch ? `${repo}-${slug(branch)}` : repo;
    }
    case "chat-instance":
      return sessionId ? `${repo}-${slug(sessionId).slice(0, 8)}` : repo;
    case "per-directory":
    default:
      return repo;
  }
}

// ------------------------------------------------------------ honcho api ----

async function honcho(cfg, path, { method = "GET", body, query, timeoutMs = 8000 } = {}) {
  const url = new URL(`${cfg.baseUrl}/workspaces/${encodeURIComponent(cfg.workspace)}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} ${url.pathname} → HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Materialize peers + session and associate them (unified observation).
async function materialize(cfg, name) {
  await Promise.all([
    honcho(cfg, "/peers", { method: "POST", body: { id: cfg.peerName } }),
    honcho(cfg, "/peers", { method: "POST", body: { id: cfg.aiPeer } }),
    honcho(cfg, "/sessions", { method: "POST", body: { id: name } }),
  ]);
  await honcho(cfg, `/sessions/${encodeURIComponent(name)}/peers`, {
    method: "POST",
    body: { [cfg.peerName]: {}, [cfg.aiPeer]: {} },
  });
}

// ---------------------------------------------------------------- cache ----

function readCache(key) {
  try {
    return JSON.parse(readFileSync(join(CACHE_DIR, `${fkey(key)}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key, ctx) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${fkey(key)}.json`), JSON.stringify(ctx));
}

function renderContext(ctx, peerName, max = 8) {
  if (!ctx) return "";
  const parts = [];
  const rep = ctx.representation;
  if (typeof rep === "string" && rep.trim()) {
    const lines = rep
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .slice(0, max)
      .map((l) => l.replace(/^[-*]\s*/, "").replace(/^\[.*?\]\s*/, ""));
    if (lines.length) parts.push(lines.map((l) => `- ${l}`).join("\n"));
  }
  if (Array.isArray(ctx.peerCard) && ctx.peerCard.length) {
    parts.push(`Profile: ${ctx.peerCard.join("; ")}`);
  }
  if (!parts.length) return "";
  return `<honcho-memory peer="${peerName}">\n${parts.join("\n")}\n</honcho-memory>`;
}

// ------------------------------------------------------------- recall ------

async function verbRecall(p) {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled) return;
  const cwd = p.cwd || process.cwd();
  const name = sessionName(cfg, cwd, p.session_id);
  const key = p.session_id || name;

  await materialize(cfg, name);

  let ctx = readCache(key);
  if (!ctx || Date.now() - ctx.at > CACHE_TTL_MS) {
    const c = await honcho(cfg, `/peers/${encodeURIComponent(cfg.peerName)}/context`, {
      query: { max_conclusions: 8, include_most_frequent: true },
    });
    ctx = { representation: c?.representation ?? null, peerCard: c?.peer_card ?? null, at: Date.now() };
    writeCache(key, ctx);
  }

  const block = renderContext(ctx, cfg.peerName, 5);
  const link = `View this session in Honcho: ${HONCHO_GUI}/explore?workspace=${encodeURIComponent(
    cfg.workspace
  )}&view=sessions&session=${encodeURIComponent(name)}`;
  // stdout may be appended to context (and is shown to the user either way)
  console.log([block, block ? HINT : "", link].filter(Boolean).join("\n"));
}

// --------------------------------------------------------- user prompt ------

function textOf(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return "";
}

async function verbPrompt(p) {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled) return;
  const cwd = p.cwd || process.cwd();
  const key = p.session_id || sessionName(cfg, cwd, p.session_id);
  const promptText = (p.prompt || textOf(p.input) || "").trim();
  mkdirSync(CACHE_DIR, { recursive: true });
  const marker = join(CACHE_DIR, `.injected-${fkey(key)}`);

  if (cfg.injectPerPrompt) {
    // Optional per-turn curated recall (off by default — session-start block + cache covers most)
    if (!promptText) return;
    const c = await honcho(cfg, `/peers/${encodeURIComponent(cfg.peerName)}/context`, {
      timeoutMs: 4000,
      query: {
        max_conclusions: 15,
        search_query: promptText.slice(0, 500),
        search_top_k: 10,
        search_max_distance: 0.6,
      },
    });
    const block = renderContext({ representation: c?.representation ?? null, peerCard: c?.peer_card ?? null }, cfg.peerName, 8);
    if (block) console.log(block);
    return;
  }

  // Inject once per session: SessionStart hook output injection is not
  // guaranteed, so the first user prompt re-emits the cached block.
  if (existsSync(marker)) return;
  let ctx = readCache(key);
  if (!ctx || Date.now() - ctx.at > CACHE_TTL_MS) {
    try {
      const c = await honcho(cfg, `/peers/${encodeURIComponent(cfg.peerName)}/context`, {
        timeoutMs: 6000,
        query: { max_conclusions: 8, include_most_frequent: true },
      });
      ctx = { representation: c?.representation ?? null, peerCard: c?.peer_card ?? null, at: Date.now() };
      writeCache(key, ctx);
    } catch {
      ctx = null; // fail-open: no memory this session rather than a broken turn
    }
  }
  const block = ctx && renderContext(ctx, cfg.peerName, 5);
  if (block) console.log(`${block}\n${HINT}`);
  writeFileSync(marker, String(Date.now()));
}

// ------------------------------------------------------------- writeback ----

function findWire(sessionId) {
  if (!sessionId) return null;
  const index = join(KIMI_HOME, "session_index.jsonl");
  try {
    for (const line of readFileSync(index, "utf8").split("\n")) {
      try {
        const j = JSON.parse(line);
        if (j.sessionId === sessionId && j.sessionDir) {
          const wire = join(j.sessionDir, "agents", "main", "wire.jsonl");
          if (existsSync(wire)) return wire;
        }
      } catch {}
    }
  } catch {}
  // Fallback: scan the sessions tree
  const root = join(KIMI_HOME, "sessions");
  try {
    for (const ws of readdirSync(root)) {
      const wire = join(root, ws, sessionId, "agents", "main", "wire.jsonl");
      if (existsSync(wire)) return wire;
    }
  } catch {}
  return null;
}

function extractMessages(data) {
  const out = [];
  for (const line of data.split("\n")) {
    if (!line) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== "agent.message.appended") continue;
    const m = j.message?.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const texts = Array.isArray(m.content)
      ? m.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text)
      : typeof m.content === "string"
        ? [m.content]
        : [];
    const text = texts.join("\n").trim();
    if (text) out.push({ role: m.role, text, at: j.time || Date.now() });
  }
  return out;
}

const msgHash = (m) => createHash("sha1").update(m.role + "\0" + m.text).digest("hex");
const queuePath = (key) => join(QUEUE_DIR, `${fkey(key)}.jsonl`);
const cursorPath = (key) => join(QUEUE_DIR, `${fkey(key)}.cursor.json`);

// Local-first capture: read the wire.jsonl delta since the last run, drop
// replay duplicates, append to the queue. No network.
function capture(key, wirePath) {
  let data;
  try {
    data = readFileSync(wirePath, "utf8");
  } catch {
    return 0;
  }
  const size = Buffer.byteLength(data);
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(cursorPath(key), "utf8"));
  } catch {}
  const from = cur.offset > 0 && cur.offset <= size ? cur.offset : 0;

  // Walk lines with byte offsets so `from` always lands on a line boundary
  let pos = 0;
  let sliceStart = null;
  const lines = [];
  for (const line of data.split("\n")) {
    const len = Buffer.byteLength(line) + 1;
    if (sliceStart === null && pos + len > from) sliceStart = pos;
    if (sliceStart !== null) lines.push(line);
    pos += len;
  }
  const fresh = extractMessages(lines.join("\n"));

  // Replay dedupe: on session resume wire.jsonl may be re-appended; skip the
  // longest prefix of `fresh` that matches the tail of already-captured hashes.
  const hashes = Array.isArray(cur.hashes) ? cur.hashes : [];
  let skip = 0;
  const maxK = Math.min(fresh.length, hashes.length, 1000);
  outer: for (let k = maxK; k > 0; k--) {
    for (let i = 0; i < k; i++) {
      if (msgHash(fresh[i]) !== hashes[hashes.length - k + i]) continue outer;
    }
    skip = k;
    break;
  }
  const news = fresh.slice(skip);
  if (news.length) {
    mkdirSync(QUEUE_DIR, { recursive: true });
    appendFileSync(queuePath(key), news.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }
  writeFileSync(cursorPath(key), JSON.stringify({ offset: size, hashes: hashes.concat(news.map(msgHash)).slice(-1000) }));
  return news.length;
}

async function flush(cfg, key, name) {
  const qp = queuePath(key);
  if (!existsSync(qp)) return 0;
  const pending = readFileSync(qp, "utf8").split("\n").filter(Boolean);
  if (!pending.length) return 0;
  const messages = pending.map((l) => {
    const m = JSON.parse(l);
    return {
      content: m.text.slice(0, 25000),
      peer_id: m.role === "assistant" ? cfg.aiPeer : cfg.peerName,
      metadata: { source: "kimi-code-cli" },
      created_at: new Date(m.at).toISOString(),
    };
  });
  for (let i = 0; i < messages.length; i += 100) {
    await honcho(cfg, `/sessions/${encodeURIComponent(name)}/messages`, {
      method: "POST",
      body: { messages: messages.slice(i, i + 100) },
    });
  }
  writeFileSync(qp, "");
  return messages.length;
}

async function verbWriteback(p) {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled || !cfg.saveMessages) return;
  if (!p.session_id) return;
  const cwd = p.cwd || process.cwd();
  const name = sessionName(cfg, cwd, p.session_id);
  const key = p.session_id || name;
  const wire = findWire(p.session_id);
  if (wire) capture(key, wire);
  try {
    await flush(cfg, key, name); // failures leave the queue for the next turn
  } catch {}
  // No stdout: Stop-hook output must not extend the turn.
}

// -------------------------------------------------------------- status ------

function verbStatus() {
  const cfg = loadConfig();
  if (!cfg) {
    console.log("no honcho config (set apiKey in ~/.honcho/config.json)");
    return;
  }
  const redacted = { ...cfg, apiKey: cfg.apiKey.slice(0, 8) + "…" };
  console.log("config:", JSON.stringify(redacted, null, 2));
  mkdirSync(QUEUE_DIR, { recursive: true });
  const queues = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".jsonl"));
  for (const q of queues) {
    const depth = readFileSync(join(QUEUE_DIR, q), "utf8").split("\n").filter(Boolean).length;
    console.log(`queue ${q}: ${depth} pending`);
  }
  if (!queues.length) console.log("queues: empty");
}

// ---------------------------------------------------------------- main ------

const stdin = await readStdin();
let payload = {};
try {
  payload = JSON.parse(stdin);
} catch {}

try {
  if (verb === "recall") await verbRecall(payload);
  else if (verb === "prompt") await verbPrompt(payload);
  else if (verb === "writeback" || verb === "flush") await verbWriteback(payload);
  else if (verb === "status") verbStatus();
} catch (e) {
  process.stderr.write(`honcho:${verb}: ${e?.message || e}\n`);
}
process.exit(0);
