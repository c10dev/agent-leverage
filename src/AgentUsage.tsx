import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarHeatmap, TodayChart, TrendChart } from "./charts";
import {
  METRICS,
  METRIC_KEYS,
  addDays,
  dailySeries,
  dayKey,
  dayTotal,
  describeChange,
  fmt,
  fmtClock,
  fmtDate,
  fmtRatio,
  hourlySeries,
  sum,
  valueUntil,
  type Change,
  type MetricKey,
  type UsageData,
} from "./usage";
import "./AgentUsage.css";

/** 1 = today, compared with yesterday up to the same time */
const RANGES = [1, 7, 30, 90] as const;
type Range = (typeof RANGES)[number];

// Color follows the agent, never its rank. Unknown agents take the remaining slots in order.
const AGENT_SLOTS: Record<string, string> = { "claude-code": "--series-claude", codex: "--series-codex" };
const SPARE_SLOTS = ["--series-3", "--series-4"];

export type AgentUsageProps = {
  data: UsageData;
  /** Last day of the "current" window. Defaults to the day the data was collected. */
  endDate?: string;
  defaultRange?: Range;
  defaultMetric?: MetricKey;
};

/** The two windows being compared, and how to talk about them. */
type View = {
  today: boolean;
  /** hours elapsed on `end` when it's still in progress, else 24 */
  until: number;
  live: boolean;
  end: string;
  curStart: string;
  prevStart: string;
  range: number;
  curLabel: string; // "최근 30일" / "오늘"
  prevLabel: string; // "이전 30일" / "어제"
  prevShort: string; // "이전" / "어제" — for small captions
  prevPhrase: string; // "이전 30일엔" / "어제 이 시간까지는"
};

function makeView(data: UsageData, range: Range, endDate?: string): View {
  const collected = new Date(data.generatedAt);
  const end = endDate ?? dayKey(collected);
  const live = end === dayKey(collected);
  const until = live ? collected.getHours() + collected.getMinutes() / 60 : 24;
  const curStart = addDays(end, -(range - 1));
  const today = range === 1;
  return {
    today,
    until: today ? until : 24,
    live,
    end,
    curStart,
    prevStart: addDays(curStart, -range),
    range,
    curLabel: today ? "오늘" : `최근 ${range}일`,
    prevLabel: today ? "어제" : `이전 ${range}일`,
    prevShort: today ? "어제" : "이전",
    prevPhrase: today ? (live ? "어제 이 시간까지는" : "어제는") : `이전 ${range}일엔`,
  };
}

/** Current and previous totals for some agents. Today is cut at the same clock time as yesterday. */
function compare(data: UsageData, v: View, agents: string[], key: MetricKey) {
  if (v.today)
    return {
      cur: valueUntil(hourlySeries(data, agents, key, v.end).total, v.until),
      prev: valueUntil(hourlySeries(data, agents, key, v.prevStart).total, v.until),
    };
  return {
    cur: sum(dailySeries(data, agents, key, v.curStart, v.range)),
    prev: sum(dailySeries(data, agents, key, v.prevStart, v.range)),
  };
}

export function AgentUsage({ data, endDate, defaultRange = 30, defaultMetric = "activeHours" }: AgentUsageProps) {
  const [range, setRange] = useState<Range>(defaultRange);
  const [metric, setMetric] = useState<MetricKey>(defaultMetric);
  const [agentFilter, setAgentFilter] = useState("all");

  const allAgents = Object.keys(data.agents);
  const color = (a: string) => {
    const spare = allAgents.filter((x) => !AGENT_SLOTS[x]);
    return `var(${AGENT_SLOTS[a] ?? SPARE_SLOTS[spare.indexOf(a) % SPARE_SLOTS.length]})`;
  };
  const agents = agentFilter === "all" ? allAgents : [agentFilter];
  const view = makeView(data, range, endDate);

  const tabs = useMemo(
    () =>
      METRIC_KEYS.map((key) => {
        const { cur, prev } = compare(data, view, agents, key);
        return { key, cur, prev, change: describeChange(cur, prev) };
      }),
    [data, agentFilter, range, endDate],
  );
  const active = tabs.find((t) => t.key === metric)!;

  const history = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data.days) m.set(d.date, dayTotal(data, d, agents, metric));
    return m;
  }, [data, agentFilter, metric]);

  return (
    <section className="au-root" aria-label="AI 에이전트 사용량">
      <div className="au-inner">
        <header className="au-header">
          <div>
            <p className="au-eyebrow">AI 에이전트 사용량</p>
            <h1 className="au-title">{view.curLabel}</h1>
            <p className="au-period">
              {view.today ? (
                <>
                  {fmtDate(view.end, { long: true, weekday: true })}
                  {view.live && ` ${fmtClock(view.until)}까지`}
                  <span className="au-sep" aria-hidden>
                    ·
                  </span>
                  어제의 나와 {view.live ? "같은 시간까지" : "하루 전체를"} 비교
                </>
              ) : (
                <>
                  {fmtDate(view.curStart, { long: true })} – {fmtDate(view.end, { long: true })}
                  <span className="au-sep" aria-hidden>
                    ·
                  </span>
                  이전 {fmtDate(view.prevStart, { long: true })} – {fmtDate(addDays(view.curStart, -1), { long: true })}와 비교
                </>
              )}
            </p>
          </div>
          <div className="au-controls">
            <Segmented
              label="기간"
              value={String(range)}
              options={RANGES.map((r) => ({ value: String(r), label: r === 1 ? "오늘" : `${r}일` }))}
              onChange={(v) => setRange(Number(v) as Range)}
            />
            <Segmented
              label="에이전트"
              value={agentFilter}
              options={[
                { value: "all", label: "전체" },
                ...allAgents.map((a) => ({ value: a, label: data.agents[a], dot: color(a) })),
              ]}
              onChange={setAgentFilter}
            />
          </div>
        </header>

        {/* Each number has one home: values live in the tabs, the change lives in the hero,
            the previous value lives in the hero sentence. */}
        <div className="au-card au-hero">
          <div className="au-tabs" role="tablist" aria-label="지표">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={metric === t.key}
                className="au-tab"
                onClick={() => setMetric(t.key)}
                title={METRICS[t.key].hint}
              >
                <span className="au-tab-label">{METRICS[t.key].label}</span>
                <span className="au-tab-value">
                  {fmt(t.cur, t.key)}
                  <Arrow change={t.change} />
                </span>
              </button>
            ))}
          </div>

          <div className="au-hero-body">
            <div className="au-hero-main">
              <p className="au-kicker">
                {view.prevLabel}
                {view.today && view.live ? " 같은 시간" : ""} 대비 {METRICS[metric].label}
              </p>
              <HeroChange change={active.change} />
              <p className="au-hero-sentence">
                {view.prevPhrase} <b>{fmt(active.prev, metric)}</b>
              </p>
            </div>
            {view.today ? (
              <TodayStats data={data} view={view} agents={agents} metric={metric} />
            ) : (
              <PeriodStats data={data} view={view} agents={agents} metric={metric} />
            )}
          </div>

          <div className="au-chart-head">
            <Legend
              items={[
                { label: view.curLabel, kind: "line" },
                { label: view.prevLabel, kind: "dash" },
              ]}
            />
          </div>
          {view.today ? (
            <TodayChart
              today={hourlySeries(data, agents, metric, view.end).total}
              yesterday={hourlySeries(data, agents, metric, view.prevStart).total}
              until={view.until}
              metric={metric}
            />
          ) : (
            <TrendChart
              cur={dailySeries(data, agents, metric, view.curStart, range)}
              prev={dailySeries(data, agents, metric, view.prevStart, range)}
              metric={metric}
              partialLast={view.live}
            />
          )}
        </div>

        <LeverageCard data={data} view={view} agents={agents} color={color} single={agentFilter !== "all" ? agentFilter : null} />

        <div className="au-grid">
          <ShareCard data={data} view={view} metric={metric} color={color} focus={agentFilter} />
          <ModelsCard data={data} agents={agents} color={color} />
        </div>

        <div className="au-card">
          <div className="au-card-head">
            <div>
              <h2>활동 기록</h2>
              <p className="au-card-sub">하루하루의 {METRICS[metric].label} · 진할수록 많이 쓴 날</p>
            </div>
            <HeatLegend />
          </div>
          <CalendarHeatmap days={history} metric={metric} end={view.end} />
        </div>

        <DataTable data={data} view={view} agents={agents} metric={metric} />

        <footer className="au-footer">
          {data.sample ? "샘플 데이터" : data.sources?.map((s) => (s === "local" ? "이 컴퓨터" : s)).join(" + ")}
          <span className="au-sep" aria-hidden>
            ·
          </span>
          {new Date(data.generatedAt).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })} 수집
        </footer>
      </div>
    </section>
  );
}

// ---------- hero ----------

function useAnimatedNumber(target: number, ms = 650) {
  const [v, setV] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.current = target;
      setV(target);
      return;
    }
    // start from wherever the previous animation got to, so rapid clicks stay smooth
    const from = current.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const next = from + (target - from) * (1 - (1 - p) ** 3);
      current.current = next;
      setV(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

/** The change, big — "↑ 1.9배 늘었어요". Counts up when it's a number. */
function HeroChange({ change }: { change: Change }) {
  const m = change.big.match(/^([\d,.]+)(.*)$/);
  const target = m ? Number(m[1].replace(/,/g, "")) : 0;
  const shown = useAnimatedNumber(target);
  const decimals = m?.[1].includes(".") ? 1 : 0;
  const num = m
    ? shown.toLocaleString("ko-KR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + m[2]
    : change.big;
  return (
    <p className="au-hero-number" aria-label={`${change.big} ${change.suffix}`}>
      {(change.dir === "up" || change.dir === "down") && (
        <span className={`au-hero-arrow au-change-${change.dir}`} aria-hidden>
          {change.dir === "down" ? "↓" : "↑"}
        </span>
      )}
      <span aria-hidden>{num}</span>
      <span className="au-hero-unit" aria-hidden>
        {change.suffix}
      </span>
    </p>
  );
}

function Stats({ items }: { items: { label: string; value: string; note?: string }[] }) {
  return (
    <dl className="au-stats">
      {items.map((it) => (
        <div key={it.label}>
          <dt>{it.label}</dt>
          <dd>
            {it.value}
            {it.note && <small>{it.note}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PeriodStats({ data, view, agents, metric }: { data: UsageData; view: View; agents: string[]; metric: MetricKey }) {
  const cur = dailySeries(data, agents, metric, view.curStart, view.range);
  const peak = cur.reduce((best, d) => (d.total > best.total ? d : best), cur[0]);
  const activeDays = cur.filter((d) => d.total > 0).length;
  return (
    <Stats
      items={[
        { label: "하루 평균", value: fmt(sum(cur) / view.range, metric) },
        peak.total > 0
          ? { label: "가장 많았던 날", value: fmt(peak.total, metric), note: fmtDate(peak.date, { weekday: true }) }
          : { label: "가장 많았던 날", value: "–" },
        { label: "사용한 날", value: String(activeDays), note: `/ ${view.range}일` },
      ]}
    />
  );
}

function TodayStats({ data, view, agents, metric }: { data: UsageData; view: View; agents: string[]; metric: MetricKey }) {
  const today = hourlySeries(data, agents, metric, view.end).total;
  const yesterday = hourlySeries(data, agents, metric, view.prevStart).total;
  const elapsed = today.slice(0, Math.ceil(view.until));
  const peakHour = elapsed.reduce((best, v, i) => (v > elapsed[best] ? i : best), 0);
  const usedHours = elapsed.filter((v) => v > 0).length;
  return (
    <Stats
      items={[
        { label: "어제 하루 전체", value: fmt(valueUntil(yesterday, 24), metric) },
        elapsed[peakHour] > 0
          ? { label: "가장 바빴던 시간", value: `${peakHour}시`, note: fmt(elapsed[peakHour], metric) }
          : { label: "가장 바빴던 시간", value: "–" },
        { label: "사용한 시간대", value: String(usedHours), note: `/ ${elapsed.length}시간` },
      ]}
    />
  );
}

// ---------- small pieces ----------

function Segmented(props: {
  label: string;
  value: string;
  options: { value: string; label: string; dot?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="au-seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} role="radio" aria-checked={props.value === o.value} onClick={() => props.onChange(o.value)}>
          {o.dot && <i className="au-dot" style={{ background: o.dot }} aria-hidden />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ARROW: Record<Change["dir"], string> = { up: "↑", down: "↓", flat: "→", new: "↑", none: "" };

/** Direction only — how much it changed is told once, in the hero. */
function Arrow({ change }: { change: Change }) {
  if (change.dir === "none") return null;
  return (
    <span className={`au-arrow au-change-${change.dir}`} title={change.short} aria-label={change.short}>
      {ARROW[change.dir]}
    </span>
  );
}

function ChangeText({ change }: { change: Change }) {
  return (
    <span className={`au-change au-change-${change.dir}`}>
      {ARROW[change.dir]} {change.short}
    </span>
  );
}

function Legend({ items }: { items: { label: string; kind: "line" | "dash" }[] }) {
  return (
    <ul className="au-legend">
      {items.map((it) => (
        <li key={it.label}>
          <i className={`au-key au-key-${it.kind === "line" ? "cur" : "prev"}`} aria-hidden />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

function HeatLegend() {
  return (
    <div className="au-heat-legend" aria-hidden>
      적음
      {[0, 1, 2, 3, 4].map((l) => (
        <i key={l} className={`au-cell-key au-l${l}`} />
      ))}
      많음
    </div>
  );
}

// ---------- leverage: agent hours per hour of mine ----------

function LeverageCard(props: { data: UsageData; view: View; agents: string[]; color: (a: string) => string; single: string | null }) {
  const { data, view, agents, color, single } = props;
  const ratio = (sel: string[]) => {
    const agent = compare(data, view, sel, "agentHours");
    const human = compare(data, view, sel, "humanHours");
    return {
      agent: agent.cur,
      human: human.cur,
      cur: human.cur > 0 ? agent.cur / human.cur : null,
      prev: human.prev > 0 ? agent.prev / human.prev : null,
    };
  };
  const r = ratio(agents);
  const perAgent = single ? [] : Object.keys(data.agents).map((a) => ({ a, ...ratio([a]) }));
  const change = r.cur !== null && r.prev !== null ? describeChange(r.cur, r.prev) : null;
  const agentColor = single ? color(single) : "color-mix(in srgb, var(--ink) 32%, var(--surface))";

  // One bar of my time, then the agents' time drawn as that many copies of it.
  const scale = Math.max(r.agent, r.human) || 1;
  const copies = r.cur && r.cur >= 1 && r.cur <= 24 ? r.cur : null;

  return (
    <div className="au-card au-leverage">
      <div className="au-lev-head">
        <div>
          <h2>레버리지</h2>
          <p className="au-card-sub">내가 일한 1시간 동안 에이전트들이 일한 시간</p>
        </div>
        <div className="au-lev-figure">
          <p className="au-lev-ratio">
            {r.cur !== null ? (
              <>
                {fmtRatio(r.cur).replace("배", "")}
                <span className="au-hero-unit">배</span>
              </>
            ) : (
              "–"
            )}
          </p>
          <p className="au-lev-compare">
            {change && <Arrow change={change} />} {view.prevPhrase} <b>{r.prev !== null ? fmtRatio(r.prev) : "기록 없음"}</b>
          </p>
        </div>
      </div>

      {r.cur !== null && (
        <div className="au-lev-bars" key={`${view.range}-${single}`}>
          <span className="au-lev-label">나</span>
          <div className="au-lev-track">
            <span className="au-lev-me" style={{ width: `${(r.human / scale) * 100}%` }} />
          </div>
          <span className="au-lev-val">{fmt(r.human, "humanHours")}</span>

          <span className="au-lev-label">에이전트</span>
          <div className="au-lev-track">
            {copies ? (
              Array.from({ length: Math.ceil(copies) }, (_, i) => (
                <span
                  key={i}
                  className="au-lev-copy"
                  style={{
                    width: `calc(${((Math.min(1, copies - i) * r.human) / scale) * 100}% - 3px)`,
                    background: agentColor,
                    animationDelay: `${i * 60}ms`,
                  }}
                />
              ))
            ) : (
              <span className="au-lev-copy" style={{ width: `${(r.agent / scale) * 100}%`, background: agentColor }} />
            )}
          </div>
          <span className="au-lev-val">{fmt(r.agent, "agentHours")}</span>
        </div>
      )}

      <div className="au-lev-foot">
        {perAgent.length > 0 && (
          <ul className="au-lev-agents">
            {perAgent.map((p) => (
              <li key={p.a}>
                <i className="au-dot" style={{ background: color(p.a) }} aria-hidden />
                {data.agents[p.a]} <b>{p.cur !== null ? fmtRatio(p.cur) : "–"}</b>
              </li>
            ))}
          </ul>
        )}
        <p className="au-lev-note" title={METRICS.humanHours.hint}>
          내 작업 시간은 프롬프트를 보낸 시각으로 추정해요 · 프롬프트마다 2분, 15분 안에 이어지면 계속 일한 걸로
        </p>
      </div>
    </div>
  );
}

// ---------- agent share: who did the work, now vs before ----------

function ShareCard(props: { data: UsageData; view: View; metric: MetricKey; color: (a: string) => string; focus: string }) {
  const { data, view, metric, color, focus } = props;
  const rows = Object.keys(data.agents).map((a) => {
    const { cur, prev } = compare(data, view, [a], metric);
    return { a, cur, prev, change: describeChange(cur, prev) };
  });
  const totCur = rows.reduce((s, r) => s + r.cur, 0);
  const totPrev = rows.reduce((s, r) => s + r.prev, 0);
  const dim = (a: string) => focus !== "all" && focus !== a;

  const bar = (label: string, key: "cur" | "prev", total: number) => (
    <div className="au-share-row">
      <span className="au-share-label">{label}</span>
      <div className="au-share-bar">
        {total > 0 ? (
          rows
            .filter((r) => r[key] > 0)
            .map((r) => (
              <span
                key={r.a}
                className={dim(r.a) ? "is-dim" : ""}
                style={{ flexGrow: r[key], background: color(r.a) }}
                title={`${data.agents[r.a]} ${Math.round((r[key] / total) * 100)}%`}
              />
            ))
        ) : (
          <span className="au-share-empty">기록 없음</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="au-card">
      <div className="au-card-head">
        <div>
          <h2>에이전트 비중</h2>
          <p className="au-card-sub">{METRICS[metric].label} 기준, 누가 일을 했나</p>
        </div>
      </div>
      <div className="au-share">
        {bar(view.prevShort, "prev", totPrev)}
        {bar(view.today ? "오늘" : "최근", "cur", totCur)}
      </div>
      <ul className="au-agents">
        {rows.map((r) => (
          <li key={r.a} className={dim(r.a) ? "is-dim" : ""}>
            <span className="au-agent-name">
              <i className="au-dot" style={{ background: color(r.a) }} aria-hidden />
              {data.agents[r.a]}
            </span>
            <span className="au-agent-share">{totCur > 0 ? `${Math.round((r.cur / totCur) * 100)}%` : "–"}</span>
            <span className="au-agent-val">
              <b>{fmt(r.cur, metric)}</b>
              <small>
                {view.prevShort} {fmt(r.prev, metric)}
              </small>
            </span>
            <ChangeText change={r.change} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- models ----------

function ModelsCard({ data, agents, color }: { data: UsageData; agents: string[]; color: (a: string) => string }) {
  const rows = agents
    .flatMap((a) => Object.entries(data.models[a] ?? {}).map(([model, n]) => ({ a, model, n })))
    .sort((x, y) => y.n - x.n);
  const top = rows.slice(0, 6);
  const rest = rows.slice(6);
  const total = rows.reduce((s, r) => s + r.n, 0) || 1;
  const restN = rest.reduce((s, r) => s + r.n, 0);

  return (
    <div className="au-card">
      <div className="au-card-head">
        <div>
          <h2>모델</h2>
          <p className="au-card-sub">응답 수 기준 · 전체 기간</p>
        </div>
      </div>
      <ol className="au-models">
        {top.map((r) => (
          <li key={`${r.a}/${r.model}`}>
            <span className="au-model-name" title={`${data.agents[r.a]} · ${r.model}`}>
              <i className="au-dot" style={{ background: color(r.a) }} aria-hidden />
              {r.model}
            </span>
            <span className="au-model-pct">{Math.round((r.n / total) * 100)}%</span>
            <span className="au-model-track">
              <span style={{ width: `${(r.n / top[0].n) * 100}%`, background: color(r.a) }} />
            </span>
          </li>
        ))}
        {restN > 0 && (
          <li className="au-models-rest">
            <span className="au-model-name">그 외 {rest.length}개 모델</span>
            <span className="au-model-pct">{Math.round((restN / total) * 100)}%</span>
          </li>
        )}
      </ol>
    </div>
  );
}

// ---------- table view ----------

function DataTable({ data, view, agents, metric }: { data: UsageData; view: View; agents: string[]; metric: MetricKey }) {
  let rows: { key: string; label: string; byAgent: number[]; total: number; prev: number }[];
  if (view.today) {
    const t = hourlySeries(data, agents, metric, view.end);
    const y = hourlySeries(data, agents, metric, view.prevStart);
    rows = Array.from({ length: Math.ceil(view.until) }, (_, h) => ({
      key: String(h),
      label: `${h}시`,
      byAgent: agents.map((a) => t.byAgent[a][h]),
      total: t.total[h],
      prev: y.total[h],
    }));
  } else {
    const cur = dailySeries(data, agents, metric, view.curStart, view.range);
    const prev = dailySeries(data, agents, metric, view.prevStart, view.range);
    rows = cur.map((d, i) => ({
      key: d.date,
      label: fmtDate(d.date, { weekday: true }),
      byAgent: agents.map((a) => d.byAgent[a]),
      total: d.total,
      prev: prev[i].total,
    }));
  }

  return (
    <details className="au-table">
      <summary>표로 보기</summary>
      <div className="au-table-scroll">
        <table>
          <thead>
            <tr>
              <th>{view.today ? "시간" : "날짜"}</th>
              {agents.map((a) => (
                <th key={a}>{data.agents[a]}</th>
              ))}
              {agents.length > 1 && <th>합계</th>}
              <th>{view.today ? "어제 같은 시간" : "이전 기간 같은 날"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                {r.byAgent.map((v, i) => (
                  <td key={agents[i]}>{fmt(v, metric)}</td>
                ))}
                {agents.length > 1 && <td>{fmt(r.total, metric)}</td>}
                <td>{fmt(r.prev, metric)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
