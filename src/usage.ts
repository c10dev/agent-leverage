// Data shape written by scripts/collect.mjs, plus the period math and copy the component needs.

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
  sources?: string[]; // where logs were read: "local" and/or SSH host names
  agents: Record<string, string>; // id -> display name
  models: Record<string, Record<string, number>>;
  /** allActiveMinutes: wall clock across every agent, overlaps counted once */
  days: { date: string; agents: Record<string, Metrics>; allActiveMinutes?: number; hourly?: DayHourly }[];
};

/** The same day split into 24 local hours. */
export type Hourly = { activeMinutes: number[]; agentMinutes: number[]; prompts: number[]; sessions: number[]; tokens: number[] };
export type DayHourly = { agents: Record<string, Hourly>; allActiveMinutes: number[] };

export type MetricKey = "activeHours" | "agentHours" | "prompts" | "sessions" | "tokens";

type MetricInfo = {
  label: string;
  unit: string; // spelled-out unit for the hero number
  hint: string;
};

export const METRICS: Record<MetricKey, MetricInfo> = {
  activeHours: {
    label: "활성 시간",
    unit: "시간",
    hint: "에이전트가 실제로 일한 시간. 동시에 돈 세션은 한 번만 세고, 5분 넘는 공백은 뺍니다.",
  },
  agentHours: {
    label: "에이전트 가동",
    unit: "시간",
    hint: "세션마다 일한 시간을 모두 더한 값. 병렬 세션·서브에이전트가 겹쳐 쌓입니다.",
  },
  prompts: {
    label: "프롬프트",
    unit: "회",
    hint: "사람이 직접 보낸 요청 수",
  },
  sessions: {
    label: "세션",
    unit: "개",
    hint: "하루에 열린 대화 세션 수",
  },
  tokens: {
    label: "토큰",
    unit: "토큰",
    hint: "입력 + 출력 토큰 (캐시 읽기 제외)",
  },
};

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

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

/** Monday of the week containing `s`. */
export function weekStart(s: string): string {
  const d = parseDay(s);
  return addDays(s, -((d.getDay() + 6) % 7));
}

// --- series ---

export type DayPoint = { date: string; byAgent: Record<string, number>; total: number };

type Day = UsageData["days"][number];

/** One day's value for the selected agents. */
export function dayTotal(data: UsageData, day: Day | undefined, agents: string[], key: MetricKey): number {
  if (!day) return 0;
  // wall clock isn't additive: two agents busy in the same hour is still one hour
  if (key === "activeHours" && day.allActiveMinutes != null && agents.length === Object.keys(data.agents).length)
    return day.allActiveMinutes / 60;
  return agents.reduce((s, a) => s + metricValue(day.agents[a], key), 0);
}

/** Daily values for [start, start+len), zero-filled, for the selected agents. */
export function dailySeries(data: UsageData, agents: string[], key: MetricKey, start: string, len: number): DayPoint[] {
  const index = new Map(data.days.map((d) => [d.date, d]));
  return Array.from({ length: len }, (_, i) => {
    const date = addDays(start, i);
    const day = index.get(date);
    const byAgent = Object.fromEntries(agents.map((a) => [a, metricValue(day?.agents[a], key)]));
    return { date, byAgent, total: dayTotal(data, day, agents, key) };
  });
}

export const sum = (pts: DayPoint[]) => pts.reduce((s, p) => s + p.total, 0);

function hourValue(h: Hourly | undefined, key: MetricKey, i: number): number {
  if (!h) return 0;
  switch (key) {
    case "activeHours":
      return h.activeMinutes[i] / 60;
    case "agentHours":
      return h.agentMinutes[i] / 60;
    default:
      return h[key][i];
  }
}

export type HourSeries = { total: number[]; byAgent: Record<string, number[]> };

/** One day's 24 hourly values for the selected agents (zeros if the data has no hourly split). */
export function hourlySeries(data: UsageData, agents: string[], key: MetricKey, date: string): HourSeries {
  const h = data.days.find((d) => d.date === date)?.hourly;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const byAgent = Object.fromEntries(agents.map((a) => [a, hours.map((i) => hourValue(h?.agents[a], key, i))]));
  const all = key === "activeHours" && h && agents.length === Object.keys(data.agents).length;
  const total = all ? h.allActiveMinutes.map((m) => m / 60) : hours.map((i) => agents.reduce((s, a) => s + byAgent[a][i], 0));
  return { total, byAgent };
}

/** Running total through `until` hours (fractional: 14.5 = up to 14:30). */
export function valueUntil(hours: number[], until: number): number {
  let v = 0;
  for (let i = 0; i < 24 && i < until; i++) v += hours[i] * Math.min(1, until - i);
  return v;
}

/** Cumulative curve: point i = total through hour i (i = 0…24). */
export function cumulative(hours: number[]): number[] {
  const out = [0];
  for (const v of hours) out.push(out[out.length - 1] + v);
  return out;
}

// --- change copy ---

export type Change = {
  dir: "up" | "down" | "flat" | "new" | "none";
  /** small badge text; the arrow beside it carries the direction */
  short: string;
  /** hero: big figure + the words after it, e.g. "1.9배" + "늘었어요" */
  big: string;
  suffix: string;
};

/** How `cur` compares with `prev`. */
export function describeChange(cur: number, prev: number): Change {
  if (prev === 0)
    return cur > 0
      ? { dir: "new", short: "신규", big: "처음", suffix: "써봤어요" }
      : { dir: "none", short: "–", big: "–", suffix: "기록이 없어요" };
  const ratio = cur / prev;
  const pct = Math.round((ratio - 1) * 100);
  if (pct === 0) return { dir: "flat", short: "0%", big: "0%", suffix: "그대로예요" };
  if (ratio >= 2) {
    const x = ratio >= 10 ? Math.round(ratio).toLocaleString("ko-KR") : ratio.toFixed(1);
    return { dir: "up", short: `${x}배`, big: `${x}배`, suffix: "늘었어요" };
  }
  const dir = Math.abs(pct) < 3 ? "flat" : pct > 0 ? "up" : "down";
  return { dir, short: `${Math.abs(pct)}%`, big: `${Math.abs(pct)}%`, suffix: pct > 0 ? "늘었어요" : "줄었어요" };
}

// --- formatting ---

const compact = new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 });
const plain1 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const plain0 = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

const isHours = (key: MetricKey) => key === "activeHours" || key === "agentHours";

/** Compact value for axes, chips and tooltips: "12.5h", "4,347", "7.7억". */
export function fmt(v: number, key: MetricKey): string {
  if (isHours(key)) return `${plain1.format(v)}h`;
  return v >= 10000 ? compact.format(v) : plain0.format(v);
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 14.5 → "오후 2:30" */
export function fmtClock(hours: number): string {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${String(m).padStart(2, "0")}`;
}

export function fmtDate(s: string, opts: { weekday?: boolean; long?: boolean } = {}): string {
  const d = parseDay(s);
  const base = opts.long ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getMonth() + 1}/${d.getDate()}`;
  return opts.weekday ? `${base} (${WEEKDAYS[d.getDay()]})` : base;
}
