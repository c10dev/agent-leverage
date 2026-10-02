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
  days: { date: string; agents: Record<string, Metrics>; allActiveMinutes?: number }[];
};

export type MetricKey = "activeHours" | "agentHours" | "prompts" | "sessions" | "tokens";

type MetricInfo = {
  label: string;
  unit: string; // spelled-out unit for the hero number
  hint: string;
  /** what the hero number is, in a few words */
  kicker: string;
};

export const METRICS: Record<MetricKey, MetricInfo> = {
  activeHours: {
    label: "활성 시간",
    unit: "시간",
    hint: "에이전트가 실제로 일한 시간. 동시에 돈 세션은 한 번만 세고, 5분 넘는 공백은 뺍니다.",
    kicker: "에이전트가 일한 시간",
  },
  agentHours: {
    label: "에이전트 가동",
    unit: "시간",
    hint: "세션마다 일한 시간을 모두 더한 값. 병렬 세션·서브에이전트가 겹쳐 쌓입니다.",
    kicker: "모든 세션의 가동 시간 합",
  },
  prompts: {
    label: "프롬프트",
    unit: "회",
    hint: "사람이 직접 보낸 요청 수",
    kicker: "내가 보낸 요청",
  },
  sessions: {
    label: "세션",
    unit: "개",
    hint: "하루에 열린 대화 세션 수",
    kicker: "새로 연 세션",
  },
  tokens: {
    label: "토큰",
    unit: "토큰",
    hint: "입력 + 출력 토큰 (캐시 읽기 제외)",
    kicker: "주고받은 토큰",
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

// --- change copy ---

export type Change = { dir: "up" | "down" | "flat" | "new" | "none"; short: string; phrase: string };

/** How `cur` compares with `prev`, as a short badge and a sentence fragment. */
export function describeChange(cur: number, prev: number): Change {
  if (prev === 0) return cur > 0 ? { dir: "new", short: "신규", phrase: "새로 시작했어요" } : { dir: "none", short: "–", phrase: "기록이 없어요" };
  const ratio = cur / prev;
  const pct = Math.round((ratio - 1) * 100);
  // direction is carried by the arrow next to `short`, so no sign here
  if (Math.abs(pct) < 3) return { dir: "flat", short: "비슷", phrase: "비슷해요" };
  if (ratio >= 2) {
    const x = ratio >= 10 ? Math.round(ratio).toLocaleString("ko-KR") : ratio.toFixed(1);
    return { dir: "up", short: `${x}배`, phrase: `${x}배로 늘었어요` };
  }
  return pct > 0
    ? { dir: "up", short: `${pct}%`, phrase: `${pct}% 늘었어요` }
    : { dir: "down", short: `${-pct}%`, phrase: `${-pct}% 줄었어요` };
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

/** Number and unit split for display type: { num: "270.2", unit: "시간" }. */
export function fmtParts(v: number, key: MetricKey): { num: string; unit: string } {
  if (isHours(key)) return { num: plain1.format(v), unit: "시간" };
  if (v >= 10000) {
    const m = compact.format(v).match(/^([\d.,]+)(.*)$/);
    if (m) return { num: m[1], unit: `${m[2]}${key === "tokens" ? " 토큰" : METRICS[key].unit}` };
  }
  return { num: plain0.format(v), unit: METRICS[key].unit };
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function fmtDate(s: string, opts: { weekday?: boolean; long?: boolean } = {}): string {
  const d = parseDay(s);
  const base = opts.long ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getMonth() + 1}/${d.getDate()}`;
  return opts.weekday ? `${base} (${WEEKDAYS[d.getDay()]})` : base;
}
