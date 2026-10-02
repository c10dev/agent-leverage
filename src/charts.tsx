import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { addDays, fmt, fmtDate, parseDay, weekStart, type DayPoint, type MetricKey } from "./usage";

// ---------- shared ----------

export function useWidth<T extends HTMLElement>(initial = 640) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setW(ref.current.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Tidy gridline values from 0 up past `max`, about `count` steps. */
function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * pow).find((s) => s >= raw)!;
  const out = [0];
  while (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

/** Monotone cubic (Fritsch–Carlson): smooth, but never overshoots below zero or above a peak. */
function smoothPath(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const slope = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / dx[i]);
  const m = pts.map((_, i) => {
    if (i === 0) return slope[0];
    if (i === n - 1) return slope[n - 2];
    if (slope[i - 1] * slope[i] <= 0) return 0;
    const w1 = 2 * dx[i] + dx[i - 1];
    const w2 = dx[i] + 2 * dx[i - 1];
    return (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
  });
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = dx[i] / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + m[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - m[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

export function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const flip = x > width - 200;
  return (
    <div className="au-tooltip" style={{ top: y, ...(flip ? { right: width - x + 14 } : { left: x + 14 }) }}>
      {children}
    </div>
  );
}

// ---------- trend: current period vs the one before ----------

const PAD = { top: 28, right: 8, bottom: 28, left: 40 };

/** `partialLast`: the last day is still in progress (data collected today), so its drop isn't real yet. */
export function TrendChart({ cur, prev, metric, partialLast = false }: { cur: DayPoint[]; prev: DayPoint[]; metric: MetricKey; partialLast?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId();
  const clipId = useId();
  const height = width < 520 ? 200 : 260;
  const n = cur.length;
  const ticks = niceTicks(Math.max(...cur.map((d) => d.total), ...prev.map((d) => d.total)));
  const yMax = ticks[ticks.length - 1];
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;
  const pts = (s: DayPoint[]) => s.map((d, i) => [x(i), y(d.total)] as [number, number]);
  const curLine = smoothPath(pts(cur));
  const area = `${curLine}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`;

  const peak = cur.reduce((best, d, i) => (d.total > cur[best].total ? i : best), 0);
  const showPeak = cur[peak].total > 0 && hover === null;
  const labelEvery = n <= 7 ? 1 : Math.ceil(n / Math.max(2, Math.floor(iw / 72)));

  const onMove = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - PAD.left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const h = hover !== null ? { c: cur[hover], p: prev[hover] } : null;

  return (
    <div className="au-chart" ref={ref}>
      <svg
        width={width}
        height={height}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="최근 기간과 이전 기간의 일별 비교"
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "au-baseline" : "au-gridline"} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="au-axis" x={PAD.left - 10} y={y(t)} dy="0.32em" textAnchor="end">
              {fmt(t, metric)}
            </text>
          </g>
        ))}
        {cur.map((d, i) =>
          (n - 1 - i) % labelEvery === 0 ? (
            <text key={d.date} className="au-axis" x={x(i)} y={height - 8} textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}>
              {n <= 7 ? fmtDate(d.date, { weekday: true }) : fmtDate(d.date)}
            </text>
          ) : null,
        )}

        <path d={area} fill={`url(#${gradId})`} className="au-fade" key={`a-${metric}-${n}`} />
        <path d={smoothPath(pts(prev))} className="au-line-prev" />
        {partialLast && n > 1 ? (
          <>
            {/* same curve, split at yesterday: solid up to it, dotted for today-so-far */}
            <clipPath id={`${clipId}-done`}>
              <rect x={0} y={0} width={x(n - 2)} height={height} />
            </clipPath>
            <clipPath id={`${clipId}-today`}>
              <rect x={x(n - 2)} y={0} width={width} height={height} />
            </clipPath>
            <g clipPath={`url(#${clipId}-done)`}>
              <path d={curLine} className="au-line-cur au-draw" pathLength={1} key={`l-${metric}-${n}`} />
            </g>
            <path d={curLine} className="au-line-today" clipPath={`url(#${clipId}-today)`} />
            <circle className="au-dot-today" cx={x(n - 1)} cy={y(cur[n - 1].total)} r="4" />
          </>
        ) : (
          <>
            <path d={curLine} className="au-line-cur au-draw" pathLength={1} key={`l-${metric}-${n}`} />
            {/* the end point anchors the eye on "now" */}
            <circle className="au-dot-cur" cx={x(n - 1)} cy={y(cur[n - 1].total)} r="4" />
          </>
        )}

        {showPeak && (
          <g className="au-peak">
            <circle cx={x(peak)} cy={y(cur[peak].total)} r="3" />
            <text x={x(peak)} y={y(cur[peak].total) - 12} textAnchor={peak < n * 0.15 ? "start" : peak > n * 0.85 ? "end" : "middle"}>
              최고 {fmt(cur[peak].total, metric)}
            </text>
          </g>
        )}

        {hover !== null && (
          <g>
            <line className="au-crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top - 8} y2={PAD.top + ih} />
            <circle className="au-dot-prev" cx={x(hover)} cy={y(prev[hover].total)} r="4" />
            <circle className="au-dot-cur" cx={x(hover)} cy={y(cur[hover].total)} r="5" />
          </g>
        )}
      </svg>
      {h && (
        <Tooltip x={x(hover!)} y={PAD.top - 8} width={width}>
          <div className="au-tip-date">
            {fmtDate(h.c.date, { long: true, weekday: true })}
            {partialLast && hover === n - 1 && <span className="au-tip-tag">진행 중</span>}
          </div>
          <div className="au-tip-row">
            <i className="au-key au-key-cur" />
            <strong>{fmt(h.c.total, metric)}</strong>
          </div>
          <div className="au-tip-row au-tip-prev">
            <i className="au-key au-key-prev" />
            <strong>{fmt(h.p.total, metric)}</strong>
            <span>{fmtDate(h.p.date, { weekday: true })}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

// ---------- calendar heatmap: every day on record ----------

const GAP = 3;
const LABEL_W = 22;

export function CalendarHeatmap({ days, metric, end }: { days: Map<string, number>; metric: MetricKey; end: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ date: string; x: number; y: number } | null>(null);

  // up to a year, as many weeks as fit at ≥10px, cells stretched to fill the width
  const weeks = Math.max(1, Math.min(53, Math.floor((width - LABEL_W) / (10 + GAP))));
  const cell = (width - LABEL_W) / weeks - GAP;
  const start = addDays(weekStart(end), -(weeks - 1) * 7);
  const height = 18 + 7 * (cell + GAP);

  // 4 levels by quartile of active days, so one huge day doesn't wash out the rest
  const nonzero = [...days.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((p) => nonzero[Math.floor(p * (nonzero.length - 1))] ?? 0);
  const level = (v: number) => (v <= 0 ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);

  const cells = [];
  const months = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const monday = addDays(start, w * 7);
    const m = parseDay(monday).getMonth();
    if (m !== lastMonth) {
      if (w < weeks - 1) months.push({ x: LABEL_W + w * (cell + GAP), label: `${m + 1}월` });
      lastMonth = m;
    }
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      if (date > end) continue;
      const v = days.get(date) ?? 0;
      const cx = LABEL_W + w * (cell + GAP);
      const cy = 18 + d * (cell + GAP);
      cells.push(
        <rect
          key={date}
          x={cx}
          y={cy}
          width={cell}
          height={cell}
          rx={Math.min(3, cell / 4)}
          className={`au-cell au-l${level(v)}${hover?.date === date ? " is-hover" : ""}`}
          onPointerEnter={() => setHover({ date, x: cx + cell / 2, y: cy })}
          onPointerLeave={() => setHover(null)}
        />,
      );
    }
  }

  return (
    <div className="au-chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="일별 활동 캘린더">
        {months.map((m) => (
          <text key={m.x} className="au-axis" x={m.x} y={10}>
            {m.label}
          </text>
        ))}
        {["월", "수", "금"].map((d, i) => (
          <text key={d} className="au-axis" x={0} y={18 + (i * 2) * (cell + GAP) + cell / 2} dy="0.32em">
            {d}
          </text>
        ))}
        {cells}
      </svg>
      {hover && (
        <Tooltip x={hover.x} y={hover.y - 6} width={width}>
          <div className="au-tip-date">{fmtDate(hover.date, { long: true, weekday: true })}</div>
          <div className="au-tip-row">
            <strong>{fmt(days.get(hover.date) ?? 0, metric)}</strong>
          </div>
        </Tooltip>
      )}
    </div>
  );
}
