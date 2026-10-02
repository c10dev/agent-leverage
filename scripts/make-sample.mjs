#!/usr/bin/env node
// Writes public/usage.sample.json — synthetic data in the same shape collect.mjs produces,
// so the component can be developed and demoed without anyone's real logs.

import fs from "node:fs";

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);

const DAYS = 180;
const end = new Date(2026, 9, 2);
const p = (n) => String(n).padStart(2, "0");
const key = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

function day(scale) {
  const prompts = Math.round(scale * (40 + rand() * 60));
  const turns = prompts * Math.round(8 + rand() * 10);
  const activeMinutes = Math.min(900, Math.round(prompts * (2 + rand() * 2)));
  return {
    sessions: Math.max(1, Math.round(prompts / (6 + rand() * 6))),
    prompts,
    turns,
    inputTokens: turns * Math.round(3000 + rand() * 6000),
    outputTokens: turns * Math.round(300 + rand() * 500),
    cacheTokens: turns * Math.round(60000 + rand() * 80000),
    agentMinutes: Math.round(activeMinutes * (1.2 + rand())),
    activeMinutes,
    humanMinutes: Math.round(activeMinutes * (0.35 + rand() * 0.3)),
  };
}

// a working day: quiet overnight, ramping up from 9, busiest late afternoon and evening
const CURVE = [1, 0.5, 0.2, 0.1, 0.1, 0.1, 0.2, 0.4, 0.8, 2, 3, 3.4, 2.4, 3, 3.8, 4.2, 4, 3.6, 2.6, 2.8, 3.4, 3.2, 2.6, 1.8];

/** Split a daily total over 24 hours; whole numbers stay whole and still add up. */
function spread(total, whole) {
  const w = CURVE.map((c) => c * (0.6 + rand() * 0.8));
  const sumW = w.reduce((a, b) => a + b, 0);
  const out = w.map((x) => (total * x) / sumW);
  if (!whole) return out.map((v) => Math.round(v * 10) / 10);
  const floored = out.map(Math.floor);
  floored[16] += total - floored.reduce((a, b) => a + b, 0);
  return floored;
}

function hourlyFor(agents, allActiveMinutes, allHumanMinutes) {
  const byAgent = {};
  for (const [a, m] of Object.entries(agents))
    byAgent[a] = {
      activeMinutes: spread(m.activeMinutes, false),
      agentMinutes: spread(m.agentMinutes, false),
      humanMinutes: spread(m.humanMinutes, false),
      prompts: spread(m.prompts, true),
      sessions: spread(m.sessions, true),
      tokens: spread(m.inputTokens + m.outputTokens, true),
    };
  return { agents: byAgent, allActiveMinutes: spread(allActiveMinutes, false), allHumanMinutes: spread(allHumanMinutes, false) };
}

const days = [];
for (let i = DAYS - 1; i >= 0; i--) {
  const d = new Date(end);
  d.setDate(d.getDate() - i);
  const t = 1 - i / DAYS; // 0 → 1 over the window
  const weekend = d.getDay() === 0 || d.getDay() === 6 ? 0.45 : 1;
  const agents = {};
  // Codex used early on, Claude Code ramps up and takes over
  const codex = (1 - t) * 1.1 * weekend;
  const claude = (0.15 + t * t * 2.2) * weekend;
  if (rand() < 0.9 && codex > 0.08) agents.codex = day(codex);
  if (rand() < 0.95 && claude > 0.05) agents["claude-code"] = day(claude);
  const mins = Object.values(agents).map((m) => m.activeMinutes);
  const allActiveMinutes = Math.min(1440, Math.round(Math.max(0, ...mins) + 0.6 * (mins.reduce((a, b) => a + b, 0) - Math.max(0, ...mins))));
  const human = Object.values(agents).map((m) => m.humanMinutes);
  const allHumanMinutes = Math.round(Math.max(0, ...human) + 0.7 * (human.reduce((a, b) => a + b, 0) - Math.max(0, ...human)));
  if (mins.length)
    days.push({ date: key(d), agents, allActiveMinutes, allHumanMinutes, hourly: hourlyFor(agents, allActiveMinutes, allHumanMinutes) });
}

const out = {
  generatedAt: new Date(end.getTime() + 18 * 3600e3).toISOString(),
  sample: true,
  agents: { "claude-code": "Claude Code", codex: "Codex" },
  models: {
    "claude-code": { "claude-opus-5-5": 18200, "claude-sonnet-5-5": 4100, "claude-haiku-4-5": 900 },
    codex: { "gpt-5.5": 9800, "gpt-5.6-sol": 3100, "gpt-5.4": 1400 },
  },
  days,
};

fs.writeFileSync("public/usage.sample.json", JSON.stringify(out, null, 1));
console.log(`wrote public/usage.sample.json (${days.length} days)`);
