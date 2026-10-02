import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarHeatmap, TrendChart } from "./charts";
import {
  METRICS,
  METRIC_KEYS,
  addDays,
  dailySeries,
  dayKey,
  describeChange,
  fmt,
  fmtDate,
  fmtParts,
  dayTotal,
  sum,
  type Change,
  type MetricKey,
  type UsageData,
} from "./usage";
import "./AgentUsage.css";

const RANGES = [7, 30, 90] as const;
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

  const end = endDate ?? dayKey(new Date(data.generatedAt));
  const curStart = addDays(end, -(range - 1));
  const prevStart = addDays(curStart, -range);

  const tabs = useMemo(
    () =>
      METRIC_KEYS.map((key) => {
        const cur = sum(dailySeries(data, agents, key, curStart, range));
        const prev = sum(dailySeries(data, agents, key, prevStart, range));
        return { key, cur, prev, change: describeChange(cur, prev) };
      }),
    [data, agentFilter, curStart, prevStart, range],
  );

  const cur = dailySeries(data, agents, metric, curStart, range);
  const prev = dailySeries(data, agents, metric, prevStart, range);
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
            <h1 className="au-title">최근 {range}일</h1>
            <p className="au-period">
              {fmtDate(curStart, { long: true })} – {fmtDate(end, { long: true })}
              <span className="au-sep" aria-hidden>
                ·
              </span>
              이전 {fmtDate(prevStart, { long: true })} – {fmtDate(addDays(curStart, -1), { long: true })}와 비교
            </p>
          </div>
          <div className="au-controls">
            <Segmented
              label="기간"
              value={String(range)}
              options={RANGES.map((r) => ({ value: String(r), label: `${r}일` }))}
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
                <span className="au-tab-value">{fmt(t.cur, t.key)}</span>
                <ChangeText change={t.change} />
              </button>
            ))}
          </div>

          <div className="au-hero-body">
            <div className="au-hero-main">
              <p className="au-kicker">{METRICS[metric].kicker}</p>
              <HeroNumber value={active.cur} metric={metric} />
              <p className="au-hero-sentence">
                <ChangePill change={active.change} />
                <span>
                  이전 {range}일 <b>{fmt(active.prev, metric)}</b>보다 {active.change.phrase}
                </span>
              </p>
            </div>
            <PeriodStats cur={cur} metric={metric} range={range} />
          </div>

          <div className="au-chart-head">
            <Legend
              items={[
                { label: `최근 ${range}일`, kind: "line" },
                { label: `이전 ${range}일`, kind: "dash" },
              ]}
            />
          </div>
          <TrendChart cur={cur} prev={prev} metric={metric} partialLast={end === dayKey(new Date(data.generatedAt))} />
        </div>

        <div className="au-grid">
          <ShareCard
            data={data}
            metric={metric}
            curStart={curStart}
            prevStart={prevStart}
            range={range}
            color={color}
            focus={agentFilter}
          />
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
          <CalendarHeatmap days={history} metric={metric} end={end} />
        </div>

        <details className="au-table">
          <summary>표로 보기</summary>
          <div className="au-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>날짜</th>
                  {agents.map((a) => (
                    <th key={a}>{data.agents[a]}</th>
                  ))}
                  <th>합계</th>
                  <th>이전 기간 같은 날</th>
                </tr>
              </thead>
              <tbody>
                {cur.map((d, i) => (
                  <tr key={d.date}>
                    <td>{fmtDate(d.date, { weekday: true })}</td>
                    {agents.map((a) => (
                      <td key={a}>{fmt(d.byAgent[a], metric)}</td>
                    ))}
                    <td>{fmt(d.total, metric)}</td>
                    <td>{fmt(prev[i].total, metric)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

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

function HeroNumber({ value, metric }: { value: number; metric: MetricKey }) {
  const shown = useAnimatedNumber(value);
  const { num, unit } = fmtParts(shown, metric);
  const final = fmtParts(value, metric);
  return (
    <p className="au-hero-number" aria-label={`${final.num}${final.unit}`}>
      <span aria-hidden>{num}</span>
      <span className="au-hero-unit" aria-hidden>
        {unit}
      </span>
    </p>
  );
}

function PeriodStats({ cur, metric, range }: { cur: { date: string; total: number }[]; metric: MetricKey; range: number }) {
  const total = cur.reduce((s, d) => s + d.total, 0);
  const peak = cur.reduce((best, d) => (d.total > best.total ? d : best), cur[0]);
  const activeDays = cur.filter((d) => d.total > 0).length;
  return (
    <dl className="au-stats">
      <div>
        <dt>하루 평균</dt>
        <dd>{fmt(total / range, metric)}</dd>
      </div>
      <div>
        <dt>가장 많았던 날</dt>
        <dd>
          {peak.total > 0 ? fmt(peak.total, metric) : "–"}
          {peak.total > 0 && <small>{fmtDate(peak.date, { weekday: true })}</small>}
        </dd>
      </div>
      <div>
        <dt>사용한 날</dt>
        <dd>
          {activeDays}
          <small>/ {range}일</small>
        </dd>
      </div>
    </dl>
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

function ChangeText({ change }: { change: Change }) {
  return (
    <span className={`au-change au-change-${change.dir}`}>
      {ARROW[change.dir]} {change.short}
    </span>
  );
}

function ChangePill({ change }: { change: Change }) {
  return (
    <span className={`au-pill au-change-${change.dir}`}>
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

// ---------- agent share: who did the work, now vs before ----------

function ShareCard(props: {
  data: UsageData;
  metric: MetricKey;
  curStart: string;
  prevStart: string;
  range: number;
  color: (a: string) => string;
  focus: string;
}) {
  const { data, metric, curStart, prevStart, range, color, focus } = props;
  const rows = Object.keys(data.agents).map((a) => {
    const cur = sum(dailySeries(data, [a], metric, curStart, range));
    const prev = sum(dailySeries(data, [a], metric, prevStart, range));
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
        {bar("이전", "prev", totPrev)}
        {bar("최근", "cur", totCur)}
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
              <small>이전 {fmt(r.prev, metric)}</small>
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
