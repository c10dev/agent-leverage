#!/usr/bin/env node
// Scans local AI agent logs and writes a per-day usage summary.
//   node scripts/collect.mjs [--out public/usage.json]
// Sources: Claude Code (~/.claude/projects), Codex (~/.codex/sessions).
// Only aggregates leave this script — no prompt text, paths, or project names.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const HOME = os.homedir();
const IDLE_GAP_MS = 5 * 60 * 1000; // gaps longer than this don't count as active time

const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? process.argv[outArg + 1] : "public/usage.json";

// daily[date][agent] -> metrics
const daily = {};
const models = {}; // models[agent][model] -> turns

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bucket(date, agent) {
  daily[date] ??= {};
  return (daily[date][agent] ??= {
    sessions: 0,
    prompts: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    agentMinutes: 0, // summed per session — parallel sessions and subagents stack
    activeMinutes: 0, // wall clock — overlapping sessions merged
  });
}

function bumpModel(agent, model) {
  if (!model || model.startsWith("<")) return;
  models[agent] ??= {};
  models[agent][model] = (models[agent][model] ?? 0) + 1;
}

// Busy intervals: gaps between consecutive events in a session, ignoring idle gaps.
const intervals = {}; // intervals[agent] -> [start, end][]

function addActiveTime(agent, timestamps) {
  timestamps.sort((a, b) => a - b);
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap <= 0 || gap > IDLE_GAP_MS) continue;
    bucket(dayKey(timestamps[i]), agent).agentMinutes += gap / 60000;
    (intervals[agent] ??= []).push([timestamps[i - 1], timestamps[i]]);
  }
}

function mergeWallClock() {
  for (const [agent, list] of Object.entries(intervals)) {
    list.sort((a, b) => a[0] - b[0]);
    let [s, e] = list[0];
    const flush = () => {
      // split at local midnight so a run through the night counts toward both days
      for (let a = s; a < e; ) {
        const next = new Date(a);
        next.setHours(24, 0, 0, 0);
        const b = Math.min(e, next.getTime());
        bucket(dayKey(a), agent).activeMinutes += (b - a) / 60000;
        a = b;
      }
    };
    for (const [a, b] of list.slice(1)) {
      if (a <= e) e = Math.max(e, b);
      else {
        flush();
        [s, e] = [a, b];
      }
    }
    flush();
  }
}

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

function isHumanPrompt(rec) {
  if (rec.type !== "user" || rec.isSidechain || rec.isMeta) return false;
  if (rec.origin) return rec.origin.kind === "human";
  const c = rec.message?.content;
  if (typeof c === "string") return !c.startsWith("<");
  return Array.isArray(c) && c.some((b) => b.type === "text") && !c.some((b) => b.type === "tool_result");
}

async function collectClaude() {
  const root = path.join(HOME, ".claude", "projects");
  const seenMsg = new Set();
  const sessionDays = new Set();
  let files = 0;
  for (const file of walk(root)) {
    files++;
    const stamps = [];
    for await (const rec of lines(file)) {
      if (!rec.timestamp) continue;
      const ts = Date.parse(rec.timestamp);
      if (Number.isNaN(ts)) continue;
      const date = dayKey(ts);

      if (rec.type === "user" || rec.type === "assistant") {
        stamps.push(ts);
        if (rec.sessionId && !rec.isSidechain && !sessionDays.has(`${rec.sessionId}|${date}`)) {
          sessionDays.add(`${rec.sessionId}|${date}`);
          bucket(date, "claude-code").sessions++;
        }
      }
      if (isHumanPrompt(rec)) bucket(date, "claude-code").prompts++;

      const msg = rec.message;
      if (rec.type === "assistant" && msg?.usage && msg.id && !seenMsg.has(msg.id)) {
        // one API response is split across several lines sharing an id
        seenMsg.add(msg.id);
        if (msg.model === "<synthetic>") continue;
        const u = msg.usage;
        const b = bucket(date, "claude-code");
        b.turns++;
        b.inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        b.cacheTokens += u.cache_read_input_tokens ?? 0;
        b.outputTokens += u.output_tokens ?? 0;
        bumpModel("claude-code", msg.model);
      }
    }
    addActiveTime("claude-code", stamps);
  }
  return files;
}

async function collectCodex() {
  const root = path.join(HOME, ".codex", "sessions");
  let files = 0;
  for (const file of walk(root)) {
    files++;
    const stamps = [];
    let prev = null; // previous cumulative token totals
    let model = null;
    let subagent = false;
    const days = new Set();
    for await (const rec of lines(file)) {
      if (!rec.timestamp) continue;
      const ts = Date.parse(rec.timestamp);
      if (Number.isNaN(ts)) continue;
      const date = dayKey(ts);
      const p = rec.payload ?? {};

      if (rec.type === "session_meta") subagent = Boolean(p.source?.subagent);
      if (rec.type === "turn_context" && p.model) model = p.model;
      if (rec.type === "response_item" || rec.type === "event_msg") {
        stamps.push(ts);
        if (!subagent && !days.has(date)) {
          days.add(date);
          bucket(date, "codex").sessions++;
        }
      }
      if (p.type === "task_started" && !subagent) bucket(date, "codex").prompts++;
      if (p.type === "token_count" && p.info?.total_token_usage) {
        const t = p.info.total_token_usage;
        // cumulative counter; the same snapshot is often re-emitted
        if (prev && t.total_tokens === prev.total_tokens) continue;
        const d = (k) => Math.max(0, (t[k] ?? 0) - (prev?.[k] ?? 0));
        const b = bucket(date, "codex");
        b.turns++;
        b.inputTokens += d("input_tokens") - d("cached_input_tokens");
        b.cacheTokens += d("cached_input_tokens");
        b.outputTokens += d("output_tokens");
        bumpModel("codex", model);
        prev = t;
      }
    }
    addActiveTime("codex", stamps);
  }
  return files;
}

const started = Date.now();
const [claudeFiles, codexFiles] = [await collectClaude(), await collectCodex()];

mergeWallClock();
for (const agents of Object.values(daily))
  for (const m of Object.values(agents)) {
    m.agentMinutes = Math.round(m.agentMinutes);
    m.activeMinutes = Math.round(m.activeMinutes);
  }

const days = Object.keys(daily).sort();
const out = {
  generatedAt: new Date().toISOString(),
  agents: { "claude-code": "Claude Code", codex: "Codex" },
  models,
  days: days.map((date) => ({ date, agents: daily[date] })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(
  `scanned ${claudeFiles} Claude Code + ${codexFiles} Codex logs in ${((Date.now() - started) / 1000).toFixed(1)}s` +
    ` → ${OUT} (${days[0]} … ${days.at(-1)}, ${days.length} days)`,
);
