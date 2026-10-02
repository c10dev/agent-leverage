import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  METRICS,
  addDays,
  change,
  dailySeries,
  fmt,
  fmtDate,
  sum,
  weeklySeries,
  dayKey,
  type DayPoint,
  type MetricKey,
  type UsageData,
} from "./usage";
import "./AgentUsage.css";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

// Categorical slots in fixed order — color follows the agent, not its rank.
const SLOT_VARS = ["--series-1", "--series-2", "--series-3", "--series-4"];

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
  const [agentFilter, setAgentFilter] = useState<string>("all");

  const allAgents = Object.keys(data.agents);
  const color = (a: string) => `var(${SLOT_VARS[allAgents.indexOf(a) % SLOT_VARS.length]})`;
  const agents = agentFilter === "all" ? allAgents : [agentFilter];

  const end = endDate ?? dayKey(new Date(data.generatedAt));
  const curStart = addDays(end, -(range - 1));
  const prevStart = addDays(curStart, -range);

  const kpis = useMemo(
    () =>
      (Object.keys(METRICS) as MetricKey[]).map((key) => {
        const cur = sum(dailySeries(data, agents, key, curStart, range));
        const prev = sum(dailySeries(data, agents, key, prevStart, range));
        return { key, cur, prev, delta: change(cur, prev) };
      }),
    [data, agents.join(), curStart, prevStart, range],
  );

  const cur = dailySeries(data, agents, metric, curStart, range);
  const prev = dailySeries(data, agents, metric, prevStart, range);
  const weekly = weeklySeries(data, agents, metric, end);
  const m = METRICS[metric];

  return (
    <section className="au-root" aria-label="AI 에이전트 사용량">
      <header className="au-head">
        <div>
          <h2>AI 에이전트 사용량</h2>
          <p className="au-sub">
            {fmtDate(curStart)} – {fmtDate(end)} · 이전 {range}일({fmtDate(prevStart)} – {fmtDate(addDays(curStart, -1))})과 비교
            {data.sample && <span className="au-badge">샘플 데이터</span>}
            {data.sources && (
              <span className="au-badge" title="로그를 읽은 곳">
                {data.sources.map((s) => (s === "local" ? "이 컴퓨터" : s)).join(" + ")}
              </span>
            )}
          </p>
        </div>
      </header>

      <div className="au-filters" role="toolbar" aria-label="필터">
        <Segmented
          label="기간"
          value={String(range)}
          options={RANGES.map((r) => ({ value: String(r), label: `${r}일` }))}
          onChange={(v) => setRange(Number(v) as Range)}
        />
        <Segmented
          label="에이전트"
          value={agentFilter}
          options={[{ value: "all", label: "전체" }, ...allAgents.map((a) => ({ value: a, label: data.agents[a] }))]}
          onChange={setAgentFilter}
        />
      </div>

      <div className="au-kpis" role="tablist" aria-label="지표">
        {kpis.map((k) => (
          <button
            key={k.key}
            role="tab"
            aria-selected={metric === k.key}
            className="au-kpi"
            onClick={() => setMetric(k.key)}
            title={METRICS[k.key].hint}
          >
            <span className="au-kpi-label">{METRICS[k.key].label}</span>
            <span className="au-kpi-value">{fmt(k.cur, k.key)}</span>
            <Delta value={k.delta} />
            <span className="au-kpi-prev">이전 {fmt(k.prev, k.key)}</span>
          </button>
        ))}
      </div>

      <div className="au-card">
        <div className="au-card-head">
          <h3>
            일별 {m.label} <span className="au-muted">· 최근 {range}일 vs 이전 {range}일</span>
          </h3>
          <Legend
            items={[
              { label: `최근 ${range}일`, style: "line", color: "var(--current)" },
              { label: `이전 ${range}일`, style: "dash", color: "var(--previous)" },
            ]}
          />
        </div>
        <CompareChart cur={cur} prev={prev} metric={metric} />
      </div>

      <div className="au-grid">
        <div className="au-card">
          <div className="au-card-head">
            <h3>에이전트별 {m.label}</h3>
          </div>
          <AgentBars data={data} metric={metric} curStart={curStart} prevStart={prevStart} range={range} color={color} />
        </div>
        <div className="au-card">
          <div className="au-card-head">
            <h3>
              모델 <span className="au-muted">· 응답 수, 전체 기간</span>
            </h3>
          </div>
          <ModelList data={data} agents={agents} color={color} />
        </div>
      </div>

      <div className="au-card">
        <div className="au-card-head">
          <h3>
            주간 {m.label} <span className="au-muted">· 전체 기록</span>
          </h3>
          {agents.length > 1 && (
            <Legend items={agents.map((a) => ({ label: data.agents[a], style: "box" as const, color: color(a) }))} />
          )}
        </div>
        <WeeklyChart weeks={weekly} agents={agents} names={data.agents} metric={metric} color={color} highlightFrom={curStart} />
      </div>

      <details className="au-table">
        <summary>표로 보기 (일별 {m.label})</summary>
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
                <td>{d.date}</td>
                {agents.map((a) => (
                  <td key={a}>{fmt(d.byAgent[a], metric)}</td>
                ))}
                <td>{fmt(d.total, metric)}</td>
                <td>{fmt(prev[i].total, metric)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

// ---------- pieces ----------

function Segmented(props: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="au-seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} role="radio" aria-checked={props.value === o.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="au-delta au-delta-flat">신규</span>;
  const r = Math.round(value);
  const dir = r > 0 ? "up" : r < 0 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "–";
  // past +1000% a percentage stops being readable; say how many times larger instead
  const text = r >= 1000 ? `×${Math.round(r / 100 + 1).toLocaleString("ko-KR")}` : `${r > 0 ? "+" : ""}${r.toLocaleString("ko-KR")}%`;
  return (
    <span className={`au-delta au-delta-${dir}`}>
      {arrow} {text}
    </span>
  );
}

function Legend({ items }: { items: { label: string; color: string; style: "line" | "dash" | "box" }[] }) {
  return (
    <ul className="au-legend">
      {items.map((it) => (
        <li key={it.label}>
          <svg width="16" height="10" aria-hidden>
            {it.style === "box" ? (
              <rect x="3" y="1" width="10" height="8" rx="2" fill={it.color} />
            ) : (
              <line x1="1" x2="15" y1="5" y2="5" stroke={it.color} strokeWidth="2" strokeDasharray={it.style === "dash" ? "3 2" : undefined} />
            )}
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Round the max up to a tidy number and return ~4 gridline values. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * pow).find((s) => s >= raw)!;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

const PAD = { top: 12, right: 12, bottom: 24, left: 44 };

function CompareChart({ cur, prev, metric }: { cur: DayPoint[]; prev: DayPoint[]; metric: MetricKey }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const n = cur.length;
  const ticks = niceTicks(Math.max(...cur.map((d) => d.total), ...prev.map((d) => d.total)));
  const yMax = ticks[ticks.length - 1];
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;
  const path = (pts: DayPoint[]) => pts.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.total).toFixed(1)}`).join("");
  const area = `${path(cur)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const labelEvery = Math.ceil(n / Math.max(2, Math.floor(iw / 56)));

  const onMove = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - PAD.left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className="au-chart" ref={ref}>
      <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="최근 기간과 이전 기간의 일별 비교">
        {ticks.map((t) => (
          <g key={t}>
            <line className="au-grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="au-axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {fmt(t, metric)}
            </text>
          </g>
        ))}
        {cur.map((d, i) =>
          (n - 1 - i) % labelEvery === 0 ? (
            <text key={d.date} className="au-axis" x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
              {fmtDate(d.date)}
            </text>
          ) : null,
        )}
        <path d={area} className="au-area" />
        <path d={path(prev)} className="au-line-prev" />
        <path d={path(cur)} className="au-line-cur" />
        {hover !== null && (
          <g>
            <line className="au-crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} />
            <circle className="au-dot-prev" cx={x(hover)} cy={y(prev[hover].total)} r="4" />
            <circle className="au-dot-cur" cx={x(hover)} cy={y(cur[hover].total)} r="4" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <Tooltip left={x(hover)} width={width}>
          <Row color="var(--current)" value={fmt(cur[hover].total, metric)} label={cur[hover].date} />
          <Row color="var(--previous)" dash value={fmt(prev[hover].total, metric)} label={prev[hover].date} />
        </Tooltip>
      )}
    </div>
  );
}

function Tooltip({ left, width, children }: { left: number; width: number; children: React.ReactNode }) {
  const flip = left > width - 180;
  return (
    <div className="au-tooltip" style={flip ? { right: width - left + 12 } : { left: left + 12 }}>
      {children}
    </div>
  );
}

function Row({ color, value, label, dash }: { color: string; value: string; label: string; dash?: boolean }) {
  return (
    <div className="au-tip-row">
      <svg width="14" height="8" aria-hidden>
        <line x1="1" x2="13" y1="4" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash ? "3 2" : undefined} />
      </svg>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AgentBars(props: {
  data: UsageData;
  metric: MetricKey;
  curStart: string;
  prevStart: string;
  range: number;
  color: (a: string) => string;
}) {
  const { data, metric, curStart, prevStart, range, color } = props;
  const rows = Object.keys(data.agents).map((a) => {
    const cur = sum(dailySeries(data, [a], metric, curStart, range));
    const prev = sum(dailySeries(data, [a], metric, prevStart, range));
    return { a, cur, prev, delta: change(cur, prev) };
  });
  const max = Math.max(...rows.flatMap((r) => [r.cur, r.prev]), 1e-9);
  const total = rows.reduce((s, r) => s + r.cur, 0);

  return (
    <ul className="au-bars">
      {rows.map((r) => (
        <li key={r.a}>
          <div className="au-bars-head">
            <span className="au-bars-name">{data.agents[r.a]}</span>
            <span className="au-bars-val">
              {fmt(r.cur, metric)}
              {total > 0 && <span className="au-muted"> · {Math.round((r.cur / total) * 100)}%</span>}
            </span>
            <Delta value={r.delta} />
          </div>
          <div className="au-bar-track" title={`최근 ${fmt(r.cur, metric)}`}>
            <div className="au-bar" style={{ width: `${(r.cur / max) * 100}%`, background: color(r.a) }} />
          </div>
          <div className="au-bar-track au-bar-track-prev" title={`이전 ${fmt(r.prev, metric)}`}>
            <div className="au-bar au-bar-prev" style={{ width: `${(r.prev / max) * 100}%` }} />
          </div>
          <span className="au-bars-prev">이전 {fmt(r.prev, metric)}</span>
        </li>
      ))}
    </ul>
  );
}

function ModelList({ data, agents, color }: { data: UsageData; agents: string[]; color: (a: string) => string }) {
  const rows = agents
    .flatMap((a) => Object.entries(data.models[a] ?? {}).map(([model, n]) => ({ a, model, n })))
    .sort((x, y) => y.n - x.n);
  const top = rows.slice(0, 6);
  const rest = rows.slice(6).reduce((s, r) => s + r.n, 0);
  const total = rows.reduce((s, r) => s + r.n, 0) || 1;

  return (
    <ul className="au-models">
      {top.map((r) => (
        <li key={`${r.a}/${r.model}`}>
          <span className="au-model-name">
            <i style={{ background: color(r.a) }} aria-hidden />
            {r.model}
          </span>
          <span className="au-model-bar">
            <span style={{ width: `${(r.n / top[0].n) * 100}%`, background: color(r.a) }} />
          </span>
          <span className="au-model-pct">{Math.round((r.n / total) * 100)}%</span>
        </li>
      ))}
      {rest > 0 && (
        <li className="au-muted">
          <span className="au-model-name">기타 {rows.length - top.length}개</span>
          <span />
          <span className="au-model-pct">{Math.round((rest / total) * 100)}%</span>
        </li>
      )}
    </ul>
  );
}

function WeeklyChart(props: {
  weeks: DayPoint[];
  agents: string[];
  names: Record<string, string>;
  metric: MetricKey;
  color: (a: string) => string;
  highlightFrom: string;
}) {
  const { weeks, agents, names, metric, color, highlightFrom } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 200;
  const ticks = niceTicks(Math.max(...weeks.map((w) => w.total)));
  const yMax = ticks[ticks.length - 1];
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const slot = iw / Math.max(1, weeks.length);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;
  const labelEvery = Math.ceil(weeks.length / Math.max(2, Math.floor(iw / 56)));

  return (
    <div className="au-chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="주간 사용량 추이">
        {ticks.map((t) => (
          <g key={t}>
            <line className="au-grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="au-axis" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {fmt(t, metric)}
            </text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const inRange = addDays(w.date, 6) >= highlightFrom;
          let acc = 0;
          const segs = agents
            .map((a) => {
              const v = w.byAgent[a];
              const top = y(acc + v);
              const h = y(acc) - top;
              acc += v;
              return { a, top, h };
            })
            .filter((s) => s.h > 0);
          return (
            <g
              key={w.date}
              className={`au-week${hover === i ? " is-hover" : ""}${inRange ? "" : " is-past"}`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              tabIndex={0}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={ih} fill="transparent" />
              {segs.map((s, j) => {
                // 2px surface gap between stacked segments; only the top segment gets rounded ends
                const gap = j < segs.length - 1 ? 2 : 0;
                const isTop = j === segs.length - 1;
                const r = isTop ? Math.min(4, bw / 2, s.h) : 0;
                const hh = Math.max(0, s.h - gap);
                return (
                  <path
                    key={s.a}
                    fill={color(s.a)}
                    d={roundedTop(cx - bw / 2, s.top + gap, bw, hh, r)}
                  />
                );
              })}
              {((weeks.length - 1 - i) % labelEvery === 0) && (
                <text className="au-axis" x={cx} y={height - 6} textAnchor="middle">
                  {fmtDate(w.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip left={PAD.left + slot * hover + slot / 2} width={width}>
          <div className="au-tip-title">
            {weeks[hover].date} 주 · 합계 <strong>{fmt(weeks[hover].total, metric)}</strong>
          </div>
          {agents.map((a) => (
            <div className="au-tip-row" key={a}>
              <svg width="14" height="8" aria-hidden>
                <line x1="1" x2="13" y1="4" y2="4" stroke={color(a)} strokeWidth="2" />
              </svg>
              <strong>{fmt(weeks[hover].byAgent[a], metric)}</strong>
              <span>{names[a]}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
