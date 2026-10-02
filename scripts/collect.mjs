#!/usr/bin/env node
// Scans AI agent logs on this machine (and optionally on SSH hosts) and writes a per-day usage summary.
//   node scripts/collect.mjs [--out public/usage.json] [--remote <ssh-host>]... [--no-local]
// SSH hosts can also be listed in remotes.txt.
// Sources: Claude Code (~/.claude/projects), Codex (~/.codex/sessions).
//
// Remote hosts run this same script over SSH in --raw mode (needs `node` there) and send back
// de-duplicatable events: message ids, prompt ids, and per-file activity runs. That way a session
// the desktop app mirrors locally (~/.claude/projects/ssh-*) and that also lives on the server is
// counted once. Only aggregates reach the output — no prompt text, paths, or project names.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const IDLE_GAP_MS = 5 * 60 * 1000; // gaps longer than this end an activity run
const AGENTS = { "claude-code": "Claude Code", codex: "Codex" };

// ---------- scanning (runs locally and, in --raw mode, on remote hosts) ----------

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // partially-written line
    }
  }
}

/** Collapse event timestamps into [start, end] runs, splitting on idle gaps. */
function toRuns(stamps) {
  stamps.sort((a, b) => a - b);
  const runs = [];
  for (const t of stamps) {
    const last = runs.at(-1);
    if (last && t - last[1] <= IDLE_GAP_MS) last[1] = t;
    else runs.push([t, t]);
  }
  return runs;
}

function isHumanPrompt(rec) {
  if (rec.type !== "user" || rec.isSidechain || rec.isMeta) return false;
  if (rec.origin) return rec.origin.kind === "human";
  const c = rec.message?.content;
  if (typeof c === "string") return !c.startsWith("<");
  return Array.isArray(c) && c.some((b) => b.type === "text") && !c.some((b) => b.type === "tool_result");
}

const emptySource = () => ({ msgs: {}, prompts: {}, files: {} });

// msgs[id] = [ts, input, output, cacheRead, model]; prompts[id] = ts; files[key] = { sid, main, runs }

async function scanClaude(src) {
  const root = path.join(os.homedir(), ".claude", "projects");
  for (const file of walk(root)) {
    const stamps = [];
    let sid = null;
    let main = true;
    for await (const rec of lines(file)) {
      if (rec.type !== "user" && rec.type !== "assistant") continue;
      const ts = Date.parse(rec.timestamp);
      if (Number.isNaN(ts)) continue;
      stamps.push(ts);
      sid ??= rec.sessionId;
      if (rec.isSidechain) main = false;
      if (isHumanPrompt(rec) && rec.uuid) src.prompts[rec.uuid] = ts;
      const msg = rec.message;
      // one API response is split across several lines sharing an id; resumed sessions copy them too
      if (rec.type === "assistant" && msg?.usage && msg.id && msg.model !== "<synthetic>") {
        const u = msg.usage;
        src.msgs[msg.id] ??= [
          ts,
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          u.output_tokens ?? 0,
          u.cache_read_input_tokens ?? 0,
          msg.model,
        ];
      }
    }
    // key by session + file name so the desktop app's local mirror of an SSH session collapses with the server copy
    if (sid && stamps.length) src.files[`${sid}/${path.basename(file)}`] = { sid, main, runs: toRuns(stamps) };
  }
}

async function scanCodex(src) {
  const root = path.join(os.homedir(), ".codex", "sessions");
  for (const file of walk(root)) {
    const key = path.basename(file, ".jsonl");
    const stamps = [];
    let prev = null; // previous cumulative token totals
    let model = null;
    let main = true;
    let n = 0;
    for await (const rec of lines(file)) {
      const ts = Date.parse(rec.timestamp);
      if (Number.isNaN(ts)) continue;
      const p = rec.payload ?? {};
      n++;
      if (rec.type === "session_meta" && p.source?.subagent) main = false;
      if (rec.type === "turn_context" && p.model) model = p.model;
      if (rec.type === "response_item" || rec.type === "event_msg") stamps.push(ts);
      if (p.type === "task_started" && main) src.prompts[`${key}:${n}`] = ts;
      if (p.type === "token_count" && p.info?.total_token_usage) {
        const t = p.info.total_token_usage;
        // cumulative counter; the same snapshot is often re-emitted
        if (prev && t.total_tokens === prev.total_tokens) continue;
        const d = (k) => Math.max(0, (t[k] ?? 0) - (prev?.[k] ?? 0));
        src.msgs[`${key}:${n}`] = [ts, d("input_tokens") - d("cached_input_tokens"), d("output_tokens"), d("cached_input_tokens"), model];
        prev = t;
      }
    }
    if (stamps.length) src.files[key] = { sid: key, main, runs: toRuns(stamps) };
  }
}

async function scanAll() {
  const out = { "claude-code": emptySource(), codex: emptySource() };
  await scanClaude(out["claude-code"]);
  await scanCodex(out.codex);
  return out;
}

// ---------- raw mode: what a remote host sends back ----------

if (process.argv.includes("--raw")) {
  const json = JSON.stringify(await scanAll());
  // stdout to a pipe is async — wait for the flush before exiting
  await new Promise((resolve) => process.stdout.write(json, resolve));
  process.exit(0);
}

// ---------- local driver ----------

function argList(flag) {
  const out = [];
  process.argv.forEach((a, i) => a === flag && process.argv[i + 1] && out.push(process.argv[i + 1]));
  return out;
}

const OUT = argList("--out").at(-1) ?? "public/usage.json";
// hosts from --remote, plus remotes.txt (one SSH host per line, gitignored)
const REMOTES = [
  ...new Set([
    ...argList("--remote"),
    ...(fs.existsSync("remotes.txt") ? fs.readFileSync("remotes.txt", "utf8").split("\n") : [])
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean),
  ]),
];

function scanRemote(host) {
  const script = fs.readFileSync(fileURLToPath(import.meta.url));
  return new Promise((resolve, reject) => {
    const ssh = spawn("ssh", ["-C", "-o", "BatchMode=yes", host, "node --input-type=module - --raw"]);
    const chunks = [];
    let err = "";
    ssh.stdout.on("data", (c) => chunks.push(c));
    ssh.stderr.on("data", (c) => (err += c));
    ssh.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${host}: ssh exited ${code}\n${err.trim()}`));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error(`${host}: couldn't parse output\n${err.trim()}`));
      }
    });
    ssh.stdin.end(script);
  });
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Split [s, e] at local midnights. */
function* byDay(s, e) {
  for (let a = s; a < e; ) {
    const next = new Date(a);
    next.setHours(24, 0, 0, 0);
    const b = Math.min(e, next.getTime());
    yield [dayKey(a), b - a];
    a = b;
  }
}

const started = Date.now();
const sources = [];
const labels = [];
const pending = [];
if (!process.argv.includes("--no-local")) pending.push(scanAll().then((s) => ["local", s]));
for (const host of REMOTES)
  pending.push(
    scanRemote(host).then(
      (s) => [host, s],
      (e) => (console.error(`skipped ${e.message}`), null),
    ),
  );
for (const r of await Promise.all(pending))
  if (r) {
    labels.push(r[0]);
    sources.push(r[1]);
  }

// merge by id — duplicates across machines collapse here
const merged = {};
for (const agent of Object.keys(AGENTS)) {
  merged[agent] = emptySource();
  for (const s of sources) {
    Object.assign(merged[agent].msgs, s[agent]?.msgs);
    Object.assign(merged[agent].prompts, s[agent]?.prompts);
    Object.assign(merged[agent].files, s[agent]?.files);
  }
}

// daily[date][agent] -> metrics
const daily = {};
const models = {};
const bucket = (date, agent) =>
  ((daily[date] ??= {})[agent] ??= {
    sessions: 0,
    prompts: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    agentMinutes: 0, // summed per session — parallel sessions and subagents stack
    activeMinutes: 0, // wall clock — overlapping sessions merged
  });

for (const [agent, src] of Object.entries(merged)) {
  for (const [ts, input, output, cache, model] of Object.values(src.msgs)) {
    const b = bucket(dayKey(ts), agent);
    b.turns++;
    b.inputTokens += input;
    b.outputTokens += output;
    b.cacheTokens += cache;
    if (model && !model.startsWith("<")) (models[agent] ??= {})[model] = (models[agent][model] ?? 0) + 1;
  }
  for (const ts of Object.values(src.prompts)) bucket(dayKey(ts), agent).prompts++;

  const sessionDays = new Set();
  const allRuns = [];
  for (const f of Object.values(src.files)) {
    for (const [s, e] of f.runs) {
      allRuns.push([s, e]);
      for (const [date, ms] of byDay(s, e)) bucket(date, agent).agentMinutes += ms / 60000;
      if (f.main) sessionDays.add(`${f.sid}|${dayKey(s)}`).add(`${f.sid}|${dayKey(e)}`);
    }
  }
  for (const k of sessionDays) bucket(k.split("|")[1], agent).sessions++;

  // wall clock: union of every run across sessions (and machines)
  allRuns.sort((a, b) => a[0] - b[0]);
  let cur = null;
  const flush = () => {
    if (cur) for (const [date, ms] of byDay(cur[0], cur[1])) bucket(date, agent).activeMinutes += ms / 60000;
  };
  for (const [s, e] of allRuns) {
    if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e);
    else {
      flush();
      cur = [s, e];
    }
  }
  flush();
}

for (const agents of Object.values(daily))
  for (const m of Object.values(agents)) {
    m.agentMinutes = Math.round(m.agentMinutes);
    m.activeMinutes = Math.round(m.activeMinutes);
  }

const days = Object.keys(daily).sort();
const out = {
  generatedAt: new Date().toISOString(),
  sources: labels,
  agents: AGENTS,
  models,
  days: days.map((date) => ({ date, agents: daily[date] })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const count = (a) => Object.keys(merged[a].files).length;
console.log(
  `sources: ${labels.join(", ")} · ${count("claude-code")} Claude Code + ${count("codex")} Codex logs (deduped)` +
    ` in ${((Date.now() - started) / 1000).toFixed(1)}s → ${OUT} (${days[0]} … ${days.at(-1)}, ${days.length} days)`,
);
