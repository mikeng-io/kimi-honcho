#!/usr/bin/env node
/**
 * kimi-honcho CLI: install · status · remove · recall | prompt | writeback | flush
 *
 * install seeds hosts.kimi in ~/.honcho/config.json (shared with the other
 * Honcho integrations), removes any legacy manually-registered
 * honcho-kimi-hooks block from config.toml, and prints the /plugins install
 * line. Hook verbs forward to hooks/hook.mjs with stdin attached.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "hook.mjs");
const KIMI_HOME = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
const HONCHO_DIR = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
const verb = process.argv[2] || "status";

if (["recall", "prompt", "writeback", "flush"].includes(verb)) {
  const r = spawnSync(process.execPath, [HOOK, verb], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

function honchoConfig() {
  const p = join(HONCHO_DIR, "config.json");
  let j = {};
  try {
    j = JSON.parse(readFileSync(p, "utf8"));
  } catch {}
  return { p, j };
}

if (verb === "install") {
  const { p, j } = honchoConfig();
  const key = process.env.HONCHO_API_KEY || j.apiKey || j.hosts?.kimi?.apiKey;
  if (!key) {
    console.error("No Honcho API key found. Run `honcho init` (uv tool install honcho-cli) first.");
    process.exit(1);
  }
  j.hosts = j.hosts || {};
  if (!j.hosts.kimi) {
    j.hosts.kimi = {
      workspace: j.hosts.codex?.workspace ?? j.hosts.claude_code?.workspace ?? j.workspace ?? "kimi",
      enabled: true,
      saveMessages: true,
      reasoningLevel: "low",
      ...(j.hosts.codex?.endpoint ?? j.endpoint ? { endpoint: j.hosts.codex?.endpoint ?? j.endpoint } : {}),
      aiPeer: "kimi",
      sessionStrategy: "per-directory",
      injectPerPrompt: false,
    };
    writeFileSync(p, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
    console.log(`Seeded hosts.kimi in ${p} (workspace=${j.hosts.kimi.workspace})`);
  }

  // Migrate away the legacy manual hook block, if present
  const tomlPath = join(KIMI_HOME, "config.toml");
  if (existsSync(tomlPath)) {
    const toml = readFileSync(tomlPath, "utf8");
    const cleaned = toml.replace(
      /\n?# >>> honcho-kimi-hooks[\s\S]*?# <<< honcho-kimi-hooks <<<\n?/g,
      "\n"
    );
    if (cleaned !== toml) {
      writeFileSync(tomlPath, cleaned);
      console.log("Removed legacy honcho-kimi-hooks block from config.toml");
    }
  }

  console.log(`\nIn Kimi Code CLI, run:\n\n  /plugins install ${ROOT}\n  /reload\n`);
  console.log("Memory loads on your next session start. Verify with /kimi-honcho:status.");
} else if (verb === "status") {
  const managed = join(KIMI_HOME, "plugins", "managed", "kimi-honcho");
  console.log(`plugin managed copy: ${existsSync(managed) ? managed : "not installed via /plugins"}`);
  const r = spawnSync(process.execPath, [HOOK, "status"], { stdio: "inherit" });
  process.exit(r.status ?? 0);
} else if (verb === "remove") {
  console.log("In Kimi Code CLI, run:\n\n  /plugins remove kimi-honcho\n  /reload\n");
  console.log("Local queues at ~/.honcho/kimi/ are kept; delete them manually if unwanted.");
} else {
  console.log("Usage: kimi-honcho install | status | remove | recall | prompt | writeback | flush");
  process.exit(verb === "help" || verb === "--help" ? 0 : 1);
}
