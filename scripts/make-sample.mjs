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
  };
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
  if (mins.length) days.push({ date: key(d), agents, allActiveMinutes });
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
