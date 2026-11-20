#!/usr/bin/env node
// Scans AI agent logs on this machine (and optionally on SSH hosts) and writes a per-day usage summary.
//   node scripts/collect.mjs [--out public/usage.json] [--remote <ssh-host>]... [--no-local]
// SSH hosts can also be listed in remotes.txt.
// Days and hours use the local time zone; set TZ (e.g. TZ=Asia/Seoul) to change it.
// Sources: Claude Code (~/.claude/projects, ~/.claude-*/projects, $CLAUDE_CONFIG_DIR), Codex (~/.codex/sessions, ~/.codex-*/sessions, $CODEX_HOME).
// Also: ~/.hermes/codex*/sessions (Hermes Agent), and Codex token totals from a tokscale cache (~/.config/tokscale) for hours the logs no longer cover.
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
// "My" working time, estimated from when I sent prompts: each prompt counts the few minutes
// spent reading and typing before it, and prompts this close together count as one stretch of work.
const PROMPT_LEAD_MS = 2 * 60 * 1000;
const PROMPT_JOIN_MS = 15 * 60 * 1000;
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

const emptySource = () => ({ msgs: {}, prompts: {}, files: {}, compacts: {}, accounts: 0 });

// Existing log folders of every account of one agent: the default folder, sibling folders named <defaultDir>-<name>, and the env var folder.
function accountRoots(defaultDir, envVar, sub) {
  const home = os.homedir();
  const candidates = [path.join(home, defaultDir, sub)];
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (e.name.startsWith(`${defaultDir}-`) && (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(home, e.name)).isDirectory())))
        candidates.push(path.join(home, e.name, sub));
    }
  } catch {
    // unreadable home folder
  }
  if (process.env[envVar]) candidates.push(path.join(path.resolve(process.env[envVar]), sub));
  const roots = new Set();
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      if (fs.statSync(real).isDirectory()) roots.add(real);
    } catch {
      // missing or unreadable
    }
  }
  return [...roots].sort();
}

// msgs[id] = [ts, input, output, cacheRead, model, w5m, w1h, stream, speed, geo, proxied, version]
//   input = input_tokens + cache_creation; w5m + w1h = cache_creation split by TTL; stream = one request chain
//   (session id, or session:agent for subagents); proxied = 1 when the record has no requestId. Codex stops at model.
// prompts[id] = ts; files[key] = { sid, main, runs }; compacts[key] = [sessionId, ts]

async function scanClaude(src) {
  for (const root of accountRoots(".claude", "CLAUDE_CONFIG_DIR", "projects")) {
    let found = false;
    for (const file of walk(root)) {
      found = true;
      const stamps = [];
      let sid = null;
      let main = true;
      for await (const rec of lines(file)) {
        if (rec.type === "system" && rec.subtype === "compact_boundary" && !rec.isSidechain && rec.sessionId) {
          const at = Date.parse(rec.timestamp);
          if (!Number.isNaN(at)) src.compacts[`${rec.sessionId}|${rec.timestamp}`] = [rec.sessionId, at];
        }
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
          const created = u.cache_creation_input_tokens ?? 0;
          const w1h = Math.min(created, u.cache_creation?.ephemeral_1h_input_tokens || 0);
          const stream = rec.isSidechain ? `${rec.sessionId}:${rec.agentId ?? path.basename(file, ".jsonl")}` : rec.sessionId;
          src.msgs[msg.id] ??= [
            ts,
            (u.input_tokens ?? 0) + created,
            u.output_tokens ?? 0,
            u.cache_read_input_tokens ?? 0,
            msg.model,
            created - w1h,
            w1h,
            stream ?? null,
            u.speed ?? null,
            u.inference_geo ?? null,
            rec.requestId ? 0 : 1,
            rec.version ?? null,
          ];
        }
      }
      // key by session + file name so the desktop app's local mirror of an SSH session collapses with the server copy
      if (sid && stamps.length) src.files[`${sid}/${path.basename(file)}`] = { sid, main, runs: toRuns(stamps) };
    }
    if (found) src.accounts++;
  }
}

// Codex log folders that Hermes Agent writes: ~/.hermes/codex*/sessions.
function hermesCodexRoots() {
  const base = path.join(os.homedir(), ".hermes");
  const roots = [];
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.name.startsWith("codex")) continue;
      try {
        const real = fs.realpathSync(path.join(base, e.name, "sessions"));
        if (fs.statSync(real).isDirectory()) roots.push(real);
      } catch {
        // no sessions folder
      }
    }
  } catch {
    // no ~/.hermes
  }
  return roots;
}

async function scanCodex(src) {
  const roots = [...new Set([...accountRoots(".codex", "CODEX_HOME", "sessions"), ...hermesCodexRoots()])].sort();
  for (const root of roots) {
    let found = false;
    for (const file of walk(root)) {
      found = true;
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
    if (found) src.accounts++;
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
    // non-interactive SSH shells often miss Homebrew's bin folders (macOS), so add them to PATH
    const cmd = 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" node --input-type=module - --raw';
    const ssh = spawn("ssh", ["-C", "-o", "BatchMode=yes", host, cmd]);
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

/** Split [s, e] at local hour boundaries → [date, hour, ms]. */
function* byHour(s, e) {
  for (let a = s; a < e; ) {
    const d = new Date(a);
    const next = new Date(a);
    next.setMinutes(60, 0, 0);
    const b = Math.min(e, next.getTime());
    yield [dayKey(a), d.getHours(), b - a];
    a = b;
  }
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------- pricing and cache leaks (local driver only; remote hosts just send the raw fields) ----------

const MTOK = 1e6;
const MISS_SHARE = 0.05; // a miss re-processes more than 5% of what the cache held ...
const MISS_MIN_TOKENS = 2000; // ... and at least this many tokens
const TTL_5M = 5 * 60_000;
const TTL_1H = 60 * 60_000;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

const priceTable = JSON.parse(fs.readFileSync(new URL("./prices.json", import.meta.url), "utf8"));

/** Model key equal to a table key, or a table key plus -YYYYMMDD. No fuzzy matching. */
function modelPrice(table, model) {
  if (!model) return null;
  const exact = table.models?.[model];
  if (exact) return exact;
  const dated = /^(.*)-\d{8}$/.exec(model);
  return dated ? (table.models?.[dated[1]] ?? null) : null;
}

/** Per-token rate for one request, or null when it has no price (unpriced). */
function rateOf(table, { model, speed, geo, promptTokens = 0 }) {
  const p = modelPrice(table, model);
  if (!p || !Number.isFinite(table.writeMult?.["5m"]) || !Number.isFinite(table.writeMult?.["1h"])) return null;
  let mult = 1;
  if (speed && speed !== "standard") {
    const m = p.multipliers?.[`speed:${speed}`] ?? table.multipliers?.[`speed:${speed}`];
    if (m === undefined) return null;
    mult *= m;
  }
  if (geo) mult *= p.multipliers?.[`inferenceGeo:${geo}`] ?? table.multipliers?.[`inferenceGeo:${geo}`] ?? 1;
  if (p.longContext && promptTokens > p.longContext.over) mult *= p.longContext.mult;
  return { pIn: (p.in * mult) / MTOK, pOut: (p.out * mult) / MTOK, readMult: p.readMult, write5m: table.writeMult["5m"], write1h: table.writeMult["1h"] };
}

/** Read a message tuple into named fields. Codex tuples stop at model, so the tail defaults. */
function reqOf(t) {
  const [ts, input, output, cacheRead, model, w5m = 0, w1h = 0, stream = null, speed = null, geo = null, proxied = 0, version = null] = t;
  const inputRaw = input - w5m - w1h;
  return { ts, inputRaw, w5m, w1h, cacheRead, output, model, stream, speed, geo, proxied, version, prompt: inputRaw + w5m + w1h + cacheRead };
}

const cachedOf = (r) => r.w5m + r.w1h + r.cacheRead;

/** USD for one request at a given rate. */
const costOf = (r, rate) =>
  r.inputRaw * rate.pIn + r.w5m * rate.write5m * rate.pIn + r.w1h * rate.write1h * rate.pIn + r.cacheRead * rate.readMult * rate.pIn + r.output * rate.pOut;

/** Tokens of the previous request's cache that this request had to process again. 0 when it is not a miss. */
function rewrittenOf(prev, cur) {
  const cacheable = cachedOf(prev);
  const rewritten = Math.max(0, Math.min(cacheable, cur.prompt) - cur.cacheRead);
  return rewritten > cacheable * MISS_SHARE && rewritten >= MISS_MIN_TOKENS ? rewritten : 0;
}

/** Cache TTL after a request: 1h if it wrote 1h, 5m if it wrote 5m, else unchanged. */
const ttlAfter = (r, before) => (r.w1h > 0 ? TTL_1H : r.w5m > 0 ? TTL_5M : before);

/** Compare each request in a stream with the one before it. cuts = compaction times (main streams only). */
function sessionLeaks(reqs, cuts, table) {
  const out = [];
  let ttl = null;
  for (let i = 0; i < reqs.length; i++) {
    const cur = reqs[i];
    if (i > 0) {
      const prev = reqs[i - 1];
      const rewritten = rewrittenOf(prev, cur);
      if (rewritten > 0) {
        const cold = cur.ts - prev.ts > (ttl ?? TTL_5M);
        let rule = "unexplained";
        if (cur.proxied) rule = "proxied";
        else if (cuts.some((c) => c > prev.ts && c <= cur.ts)) rule = cold ? "compaction" : "expectedRebuild";
        else if (cur.model !== prev.model) rule = "modelSwitch";
        else if (cold) rule = "coldCache";
        else if (prev.version && cur.version && prev.version !== cur.version) rule = "upgrade";
        const rate = rateOf(table, { ...cur, promptTokens: cur.prompt });
        const usd = rate ? rewritten * ((cur.w1h > 0 ? rate.write1h : rate.write5m) - rate.readMult) * rate.pIn : 0;
        out.push({ ts: cur.ts, rule, rewritten, usd });
      }
    }
    ttl = ttlAfter(cur, ttl);
  }
  return out;
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

// merge by id — duplicates across machines collapse here. The first source (this machine) wins for
// records; for activity files the copy that covers more time wins, because a mirrored copy of a live
// session (e.g. the desktop app's ssh-* copy on another machine) can lag behind the original.
const covered = (f) => f.runs.reduce((t, [s, e]) => t + e - s, 0);
const merged = {};
for (const agent of Object.keys(AGENTS)) {
  merged[agent] = emptySource();
  const m = merged[agent];
  for (const s of sources) {
    for (const kind of ["msgs", "prompts", "compacts"]) for (const [k, v] of Object.entries(s[agent]?.[kind] ?? {})) m[kind][k] ??= v;
    for (const [k, f] of Object.entries(s[agent]?.files ?? {})) if (!m.files[k] || covered(f) > covered(m.files[k])) m.files[k] = f;
  }
}

// Codex token totals from a tokscale cache. Tokens only: no sessions, prompts, or active time.
function tokscaleTuples() {
  const none = { tuples: [], cachedAt: null };
  const dir = path.join(os.homedir(), ".config", "tokscale");
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(path.join(dir, "cache", "tui-data-cache.json"), "utf8"));
  } catch {
    return none;
  }
  const hourlyRows = cache?.data?.hourly;
  if (!Array.isArray(hourlyRows)) return none;
  let tz;
  try {
    tz = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"))?.scanner?.bucketTimezone;
  } catch {
    // no settings file: tokscale defaults to UTC
  }
  if (tz && tz !== "UTC" && tz !== "Etc/UTC") {
    console.error(`skipped tokscale cache: bucketTimezone is ${tz}, not UTC`);
    return none;
  }
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const tuples = [];
  for (const row of hourlyRows) {
    if (!row?.clients?.includes?.("codex")) continue;
    const ts = Date.parse(String(row.datetime).replace(" ", "T") + "Z") + 30 * 60_000;
    if (Number.isNaN(ts)) continue;
    const one = (t, model) => tuples.push([ts, num(t?.input), num(t?.output) + num(t?.reasoning), num(t?.cacheRead), model]);
    if (Array.isArray(row.models) && row.models.length) for (const [name, info] of row.models) one(info?.tokens, name);
    else one(row.tokens, null);
  }
  return { tuples, cachedAt: Number.isFinite(cache.timestamp) ? cache.timestamp : null };
}

let tokscaleHours = 0;
if (!process.argv.includes("--no-local")) {
  const { tuples } = tokscaleTuples();
  const hourKey = (ts) => Math.floor(ts / 3600_000);
  const logSum = {};
  const msgs = merged.codex.msgs;
  for (const [ts, input, output, cache] of Object.values(msgs)) logSum[hourKey(ts)] = (logSum[hourKey(ts)] ?? 0) + input + output + cache;
  const byHour = {};
  for (const t of tuples) (byHour[hourKey(t[0])] ??= []).push(t);
  for (const [h, list] of Object.entries(byHour)) {
    const sum = list.reduce((a, [, i, o, c]) => a + i + o + c, 0);
    if (sum <= (logSum[h] ?? 0)) continue;
    for (const [k, v] of Object.entries(msgs)) if (String(hourKey(v[0])) === h) delete msgs[k];
    list.forEach((t, i) => (msgs[`tokscale:${h}:${i}`] = t));
    tokscaleHours++;
  }
  if (tokscaleHours) labels.push("tokscale");
}

// daily[date][agent] -> metrics, hourly[date][agent] -> 24-slot arrays (for "today vs yesterday at this time")
const daily = {};
const hourly = {};
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
    humanMinutes: 0, // my time at the keyboard, from prompt times
    costUsd: 0, // list-price USD of requests that have a price
    unpricedTokens: 0, // tokens of requests with no price
  });
const slots = () => Array(24).fill(0);
const hourBucket = (date, agent) =>
  ((hourly[date] ??= {})[agent] ??= { activeMinutes: slots(), agentMinutes: slots(), humanMinutes: slots(), prompts: slots(), sessions: slots(), tokens: slots(), costUsd: slots() });
const hourOf = (ts) => new Date(ts).getHours();

/** Merge overlapping [start, end] runs and report the covered minutes per local day and hour. */
function unionByHour(runs, add) {
  runs.sort((a, b) => a[0] - b[0]);
  let cur = null;
  const flush = () => {
    if (cur) for (const [date, hour, ms] of byHour(cur[0], cur[1])) add(date, hour, ms / 60000);
  };
  for (const [s, e] of runs) {
    if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e);
    else {
      flush();
      cur = [s, e];
    }
  }
  flush();
}

/** My working stretches: [prompt - lead, prompt], chained when the next prompt comes soon enough. */
function humanSpans(stamps) {
  const spans = [];
  for (const t of [...stamps].sort((a, b) => a - b)) {
    const last = spans.at(-1);
    if (last && t - PROMPT_LEAD_MS - last[1] <= PROMPT_JOIN_MS) last[1] = t;
    else spans.push([t - PROMPT_LEAD_MS, t]);
  }
  return spans;
}

const everyRun = []; // across all agents, for "all agents" wall clock
const everyPrompt = []; // across all agents — I'm one person, prompting two agents at once is still my one hour
const unpriced = {}; // model -> tokens, all time
for (const [agent, src] of Object.entries(merged)) {
  const streams = {}; // Claude Code only: stream -> requests, for cache leaks
  for (const tuple of Object.values(src.msgs)) {
    const [ts, input, output, cache, model] = tuple;
    const date = dayKey(ts);
    const b = bucket(date, agent);
    b.turns++;
    b.inputTokens += input;
    b.outputTokens += output;
    b.cacheTokens += cache;
    hourBucket(date, agent).tokens[hourOf(ts)] += input + output;
    if (model && !model.startsWith("<")) (models[agent] ??= {})[model] = (models[agent][model] ?? 0) + 1;

    const r = reqOf(tuple);
    const rate = agent === "claude-code" ? rateOf(priceTable, { ...r, promptTokens: r.prompt }) : null;
    if (rate) {
      const usd = costOf(r, rate);
      b.costUsd += usd;
      hourBucket(date, agent).costUsd[hourOf(ts)] += usd;
    } else {
      const tokens = r.inputRaw + r.w5m + r.w1h + r.cacheRead + r.output;
      b.unpricedTokens += tokens;
      unpriced[model || "unknown"] = (unpriced[model || "unknown"] ?? 0) + tokens;
    }
    if (agent === "claude-code" && r.stream) (streams[r.stream] ??= []).push(r);
  }
  const cutsOf = {};
  for (const [sid, at] of Object.values(src.compacts)) (cutsOf[sid] ??= []).push(at);
  for (const [stream, reqs] of Object.entries(streams)) {
    reqs.sort((a, b) => a.ts - b.ts);
    for (const e of sessionLeaks(reqs, cutsOf[stream] ?? [], priceTable)) {
      const leaks = (bucket(dayKey(e.ts), agent).leaks ??= {});
      const l = (leaks[e.rule] ??= { count: 0, tokens: 0, usd: 0 });
      l.count++;
      l.tokens += e.rewritten;
      l.usd += e.usd;
    }
  }
  for (const ts of Object.values(src.prompts)) {
    bucket(dayKey(ts), agent).prompts++;
    hourBucket(dayKey(ts), agent).prompts[hourOf(ts)]++;
  }
  everyPrompt.push(...Object.values(src.prompts));
  for (const [s, e] of humanSpans(Object.values(src.prompts)))
    for (const [date, hour, ms] of byHour(s, e)) {
      bucket(date, agent).humanMinutes += ms / 60000;
      hourBucket(date, agent).humanMinutes[hour] += ms / 60000;
    }

  const sessionFirstSeen = new Map(); // "sid|date" -> earliest activity that day
  const seen = (sid, ts) => {
    const k = `${sid}|${dayKey(ts)}`;
    if (!(sessionFirstSeen.get(k) <= ts)) sessionFirstSeen.set(k, ts);
  };
  const runs = [];
  for (const f of Object.values(src.files)) {
    for (const [s, e] of f.runs) {
      runs.push([s, e]);
      for (const [date, hour, ms] of byHour(s, e)) {
        bucket(date, agent).agentMinutes += ms / 60000;
        hourBucket(date, agent).agentMinutes[hour] += ms / 60000;
      }
      if (f.main) {
        seen(f.sid, s);
        if (dayKey(e) !== dayKey(s)) seen(f.sid, startOfDay(e));
      }
    }
  }
  for (const [k, ts] of sessionFirstSeen) {
    const date = k.split("|")[1];
    bucket(date, agent).sessions++;
    hourBucket(date, agent).sessions[hourOf(ts)]++;
  }

  // wall clock: union of every run across sessions (and machines)
  everyRun.push(...runs);
  unionByHour(runs, (date, hour, min) => {
    bucket(date, agent).activeMinutes += min;
    hourBucket(date, agent).activeMinutes[hour] += min;
  });
}

// same, across agents — Claude Code and Codex running at once count once
const allActive = {};
unionByHour(everyRun, (date, hour, min) => ((allActive[date] ??= slots())[hour] += min));
const allHuman = {};
for (const [s, e] of humanSpans(everyPrompt))
  for (const [date, hour, ms] of byHour(s, e)) (allHuman[date] ??= slots())[hour] += ms / 60000;

const round1 = (v) => Math.round(v * 10) / 10;
for (const agents of Object.values(daily))
  for (const m of Object.values(agents)) {
    m.agentMinutes = Math.round(m.agentMinutes);
    m.activeMinutes = Math.round(m.activeMinutes);
    m.humanMinutes = Math.round(m.humanMinutes);
    m.costUsd = r4(m.costUsd);
    for (const l of Object.values(m.leaks ?? {})) {
      l.tokens = Math.round(l.tokens);
      l.usd = r4(l.usd);
    }
  }
for (const agents of Object.values(hourly))
  for (const h of Object.values(agents)) {
    h.activeMinutes = h.activeMinutes.map(round1);
    h.agentMinutes = h.agentMinutes.map(round1);
    h.humanMinutes = h.humanMinutes.map(round1);
    h.costUsd = h.costUsd.map(r4);
  }

const days = Object.keys(daily).sort();
const sum24 = (a) => a.reduce((s, v) => s + v, 0);
const out = {
  generatedAt: new Date().toISOString(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  sources: labels,
  ...(labels[0] === "local" && { accounts: { "claude-code": sources[0]["claude-code"].accounts, codex: sources[0].codex.accounts } }),
  agents: AGENTS,
  models,
  pricing: { source: priceTable.source ?? null, unpriced },
  days: days.map((date) => ({
    date,
    agents: daily[date],
    allActiveMinutes: Math.round(sum24(allActive[date] ?? [])),
    allHumanMinutes: Math.round(sum24(allHuman[date] ?? [])),
    hourly: {
      agents: hourly[date] ?? {},
      allActiveMinutes: (allActive[date] ?? slots()).map(round1),
      allHumanMinutes: (allHuman[date] ?? slots()).map(round1),
    },
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const count = (a) => Object.keys(merged[a].files).length;
console.log(
  `sources: ${labels.join(", ")} · ${count("claude-code")} Claude Code + ${count("codex")} Codex logs (deduped)` +
    (tokscaleHours ? ` · tokscale: ${tokscaleHours} hours` : "") +
    (labels[0] === "local" ? ` · accounts: claude-code ${sources[0]["claude-code"].accounts}, codex ${sources[0].codex.accounts}` : "") +
    ` in ${((Date.now() - started) / 1000).toFixed(1)}s → ${OUT} (${days[0]} … ${days.at(-1)}, ${days.length} days)`,
);
