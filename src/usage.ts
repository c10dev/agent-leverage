// Data shape written by scripts/collect.mjs, plus the period math the component needs.

export type Metrics = {
  sessions: number;
  prompts: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  agentMinutes: number;
  activeMinutes: number;
};

export type UsageData = {
  generatedAt: string;
  sample?: boolean;
  agents: Record<string, string>; // id -> display name
  models: Record<string, Record<string, number>>;
  days: { date: string; agents: Record<string, Metrics> }[];
};

export type MetricKey = "activeHours" | "prompts" | "sessions" | "tokens" | "agentHours";

export const METRICS: Record<MetricKey, { label: string; unit: string; hint: string }> = {
  activeHours: { label: "활성 시간", unit: "h", hint: "에이전트가 일하던 실제 시간 (동시 세션은 한 번만 셈, 5분 이상 공백 제외)" },
  agentHours: { label: "에이전트 가동", unit: "h", hint: "세션별 작업 시간의 합 (병렬 세션·서브에이전트 포함)" },
  prompts: { label: "프롬프트", unit: "회", hint: "사람이 직접 보낸 요청 수" },
  sessions: { label: "세션", unit: "개", hint: "하루에 열린 대화 세션 수" },
  tokens: { label: "토큰", unit: "", hint: "입력 + 출력 토큰 (캐시 읽기 제외)" },
};

export function metricValue(m: Metrics | undefined, key: MetricKey): number {
  if (!m) return 0;
  switch (key) {
    case "activeHours":
      return m.activeMinutes / 60;
    case "agentHours":
      return m.agentMinutes / 60;
    case "prompts":
      return m.prompts;
    case "sessions":
      return m.sessions;
    case "tokens":
      return m.inputTokens + m.outputTokens;
  }
}

// --- dates (local, YYYY-MM-DD) ---

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(s: string, n: number): string {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

// --- series ---

export type DayPoint = { date: string; byAgent: Record<string, number>; total: number };

/** Daily values for [start, start+len), zero-filled, for the selected agents. */
export function dailySeries(data: UsageData, agents: string[], key: MetricKey, start: string, len: number): DayPoint[] {
  const index = new Map(data.days.map((d) => [d.date, d.agents]));
  return Array.from({ length: len }, (_, i) => {
    const date = addDays(start, i);
    const day = index.get(date) ?? {};
    const byAgent = Object.fromEntries(agents.map((a) => [a, metricValue(day[a], key)]));
    return { date, byAgent, total: Object.values(byAgent).reduce((s, v) => s + v, 0) };
  });
}

/** Monday-start weekly buckets from the first recorded day through `end`. */
export function weeklySeries(data: UsageData, agents: string[], key: MetricKey, end: string, maxWeeks = 52): DayPoint[] {
  const endD = parseDay(end);
  const monday = (d: Date) => {
    const x = new Date(d);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return dayKey(x);
  };
  const lastWeek = monday(endD);
  const firstWeek = data.days.length ? monday(parseDay(data.days[0].date)) : lastWeek;
  const weeks: DayPoint[] = [];
  for (let w = firstWeek; w <= lastWeek; w = addDays(w, 7)) {
    const days = dailySeries(data, agents, key, w, 7).filter((d) => d.date <= end);
    const byAgent = Object.fromEntries(agents.map((a) => [a, days.reduce((s, d) => s + d.byAgent[a], 0)]));
    weeks.push({ date: w, byAgent, total: Object.values(byAgent).reduce((s, v) => s + v, 0) });
  }
  return weeks.slice(-maxWeeks);
}

export const sum = (pts: DayPoint[]) => pts.reduce((s, p) => s + p.total, 0);

/** Percent change, or null when there's no baseline to compare against. */
export function change(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

// --- formatting ---

const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

export function fmt(v: number, key: MetricKey): string {
  if (key === "activeHours" || key === "agentHours") return `${plain.format(v)}h`;
  return v >= 10000 ? compact.format(v) : plain.format(Math.round(v));
}

export function fmtDate(s: string): string {
  const d = parseDay(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
