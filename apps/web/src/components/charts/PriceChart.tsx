"use client";

/**
 * Market chart (IA v3.1 item 9; Uniswap token page): one series in the brand colour, a recessive axis, a crosshair with
 * the value in the header on hover or keyboard, and small switches: what to show (price, fixed rate, volume, locked
 * value), how (line or candles, price only) and the time range (1D / 1W / 1M / All). Inline SVG, no chart library;
 * colours are theme tokens, so both themes follow. Candles: OHLC of round prices per bucket (open = first round,
 * close = last, high / low = extremes), green when it closed at or above its open, red when below, with wicks; a
 * falling candle is also drawn hollow so the direction does not rest on colour alone. Volume is drawn as bars.
 *
 * Honest drawing rules:
 * - A price series with fewer than three different prices (a testnet book that clears at the same price every round)
 *   is drawn as its flat line with "Few trades yet"; candles are not offered for it.
 * - Points from several maturities are drawn as one price line per maturity, never chained into one line (each
 *   maturity's price converges to the buy-back price as it nears, which would read as a rise). Candles are offered
 *   for one maturity only. Rates, volume and locked value read across maturities as one series.
 *
 * The range can be controlled by the parent (`range` / `onRange`) so a Stats block can report the same window.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { bucketLabel, byPool, candleSize, candles, fewTrades, inRange, lockedSeries, rateKind, valueOf, volumeBars, RANGES, type HistPoint, type Metric, type RangeKey } from "@/lib/history";
import { fmtChip, fmtClock } from "@/lib/format";
import { Segmented } from "../ui/Choice";

const W0 = 640;
const H = 220;
const PAD = { l: 8, r: 56, t: 12, b: 26 };

const METRIC_LABEL: Record<Metric, string> = { price: "Price", rate: "Rate", volume: "Volume", locked: "Locked value" };

function compactNum(v: number): string {
  return v.toLocaleString("en-US", { notation: Math.abs(v) >= 100_000 ? "compact" : "standard", maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });
}

export function fmtValue(v: number, metric: Metric, quote: string): string {
  if (metric === "rate") return `${(v * 100).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
  if (metric === "volume" || metric === "locked") return `${compactNum(v)} ${quote}`;
  const digits = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) })} ${quote}`;
}

const tickTime = (ts: number, span: number) => (span > 2 * 86_400 ? fmtChip(ts).replace(/, \d\d:\d\d$/, "") : fmtClock(ts).replace(" UTC", ""));

/** Three to four round ticks between lo and hi. */
function ticks(lo: number, hi: number): number[] {
  if (hi <= lo) return [lo];
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

export function PriceChart({
  points,
  expiry,
  quote,
  now,
  buyBackPrice,
  title,
  scope,
  metrics = ["price", "rate", "volume", "locked"],
  range: rangeIn,
  onRange,
  flowPoints,
  focusPool,
  testId = "price-chart",
}: {
  points: HistPoint[];
  /** Maturity of the selected pool (picks APR vs return to maturity). */
  expiry: number;
  quote: string;
  now: number;
  /** Buy-back price as a float, drawn as a reference line on the price view (the price converges to it if repaid). */
  buyBackPrice?: number;
  title?: string;
  /** A one-line note under the chart (which maturities it covers). */
  scope?: ReactNode;
  /** Which metric switches to offer, in order (the first is the default). */
  metrics?: Metric[];
  range?: RangeKey;
  onRange?: (r: RangeKey) => void;
  /** Points for volume and locked value when they should cover more than the price line (every buy-back level). */
  flowPoints?: HistPoint[];
  /** With points from several maturities: the one drawn in full (the others are drawn lighter). */
  focusPool?: string;
  testId?: string;
}) {
  const [metric, setMetric] = useState<Metric>(metrics[0] ?? "price");
  const [style, setStyle] = useState<"line" | "candles">("line");
  const [rangeOwn, setRangeOwn] = useState<RangeKey>("all");
  const range = rangeIn ?? rangeOwn;
  const setRange = (r: RangeKey) => (onRange ? onRange(r) : setRangeOwn(r));
  const [hover, setHover] = useState<number>();
  const svg = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(W0);
  const id = useId();
  const kind = rateKind(points, expiry);
  const shown = useMemo(() => inRange(points, range, now), [points, range, now]);
  const flow = flowPoints ?? points;
  const flowShown = useMemo(() => inRange(flow, range, now), [flow, range, now]);
  const bucket = candleSize(metric === "volume" || metric === "locked" ? flowShown : shown);
  const few = shown.length > 0 && fewTrades(shown);
  const multi = new Set(shown.map((p) => p.pool)).size > 1;
  const candleOk = metric === "price" && !few && !multi;
  const candleMode = candleOk && style === "candles";
  type Pt = { ts: number; v: number; pool?: string; expiry?: number };
  const series = useMemo((): Pt[] => {
    if (metric === "volume") return volumeBars(flowShown, bucket).map((b) => ({ ts: b.t, v: b.v }));
    if (metric === "locked") {
      const from = flowShown[0]?.ts ?? Infinity;
      return lockedSeries(flow).filter((p) => p.ts >= from);
    }
    return shown.map((p) => ({ ts: p.ts, v: valueOf(p, metric, kind), pool: p.pool as string | undefined, expiry: p.expiry as number | undefined }));
  }, [shown, flow, flowShown, metric, kind, bucket]);
  // one price line per maturity (see the header comment); rates and flows are one series
  const perPool = metric === "price" && multi;
  const lines = useMemo(() => (perPool ? byPool(series) : [series]), [perPool, series]);
  const focus = focusPool ?? series[series.length - 1]?.pool;
  const focusSeries = perPool ? (lines.find((l) => l[0]?.pool === focus) ?? lines[lines.length - 1]!) : series;
  const bars = useMemo(() => (candleMode ? candles(series, bucket) : []), [candleMode, series, bucket]);
  const hasData = series.length > 0;
  // the drawing uses the real width so marks keep their shape (no stretched circles)
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const ro = new ResizeObserver(([e]) => {
      const w = e ? Math.round(e.contentRect.width) : 0;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setW((prev) => (w > 0 && Math.abs(prev - w) > 1 ? w : prev)));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [hasData]);
  const rateLabel = kind === "apr" ? "Fixed rate (APR)" : "Fixed return to maturity";
  const rangeName = range === "all" ? "all time" : RANGES.find((r) => r.key === range)!.label;
  const label = metric === "price" ? (title ?? "Price") : metric === "rate" ? rateLabel : metric === "volume" ? `Volume, ${rangeName}` : "Locked value (estimate)";
  const last = series[series.length - 1];
  const first = focusSeries[0];
  const lastOfFocus = focusSeries[focusSeries.length - 1];
  const total = metric === "volume" ? series.reduce((s, b) => s + b.v, 0) : undefined;
  const headValue = hover !== undefined && series[hover] ? fmtValue(series[hover]!.v, metric, quote) : total !== undefined ? fmtValue(total, metric, quote) : last ? fmtValue(last.v, metric, quote) : "—";
  const headNote =
    hover !== undefined && series[hover]
      ? `${fmtChip(series[hover]!.ts)} UTC`
      : metric === "volume"
        ? `${bucketLabel(bucket)} bars`
        : few && metric === "price" && last
          ? `Few trades yet. Last traded ${fmtChip(last.ts)} UTC`
          : lastOfFocus && first && focusSeries.length > 1
            ? changeText(first.v, lastOfFocus.v, metric) + (perPool ? ", this maturity" : "")
            : last
              ? `Last traded ${fmtChip(last.ts)} UTC`
              : "No trades yet";

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="text-caption text-ink-2">{label}</p>
        <p className="num text-amount font-semibold text-ink" data-testid={`${testId}-value`}>
          {headValue}
        </p>
        <p className="tabular-nums text-caption text-ink-3" data-testid={few && metric === "price" && hover === undefined ? `${testId}-few` : undefined}>
          {headNote}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {metrics.length > 1 && (
          <Segmented
            label="Show"
            value={metric}
            onChange={(m) => {
              setMetric(m);
              setHover(undefined);
            }}
            options={metrics.map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
          />
        )}
        {candleOk && <Segmented label="Chart style" value={style} onChange={setStyle} options={[{ value: "line", label: "Line" }, { value: "candles", label: "Candles" }]} />}
      </div>
    </div>
  );

  const footer = (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <div role="radiogroup" aria-label="Time range" className="flex gap-1">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            role="radio"
            aria-checked={range === r.key}
            onClick={() => setRange(r.key)}
            className={`h-8 min-w-11 rounded-full px-3 text-caption font-medium transition-colors ${range === r.key ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink"}`}
          >
            {r.label}
          </button>
        ))}
      </div>
      <p className="text-caption text-ink-3">
        {candleMode
          ? `${bucketLabel(bucket)} candles of round prices`
          : metric === "volume"
            ? "Traded per bar"
            : metric === "locked"
              ? "From fills; repayments not deducted"
              : perPool
                ? "One line per maturity; each point is one round's price"
                : "Each point is one round's price"}
        {scope ? <>. {scope}</> : null}
      </p>
    </div>
  );

  if (series.length === 0)
    return (
      <figure className="space-y-3" data-testid={testId}>
        {header}
        <div className="well flex h-[220px] items-center justify-center px-6 text-center text-body-sm text-ink-2" data-testid={`${testId}-empty`}>
          {(metric === "volume" || metric === "locked" ? flow : points).length === 0 ? "No trades yet. The chart starts with the first round that fills." : "No trades in this time range."}
        </div>
        {footer}
      </figure>
    );

  // scales
  const barMode = metric === "volume";
  const useBars = candleMode && bars.length > 0;
  const step = barMode || useBars ? bucket : 0;
  const t0 = useBars ? bars[0]!.t : Math.min(...series.map((s) => s.ts));
  const t1 = useBars ? bars[bars.length - 1]!.t + bucket : Math.max(...series.map((s) => s.ts), t0 + 60) + step;
  const vals = useBars ? bars.flatMap((b) => [b.h, b.l]) : series.map((s) => s.v);
  const withRef = metric === "price" && buyBackPrice ? [...vals, buyBackPrice] : vals;
  let lo = barMode || metric === "locked" ? 0 : Math.min(...withRef);
  let hi = Math.max(...withRef);
  if (hi - lo < Math.abs(hi) * 0.002 || hi === lo) {
    const m = Math.abs(hi) * 0.01 || 0.01;
    if (!(barMode || metric === "locked")) lo -= m;
    hi += m;
  }
  const padV = (hi - lo) * 0.08;
  if (!(barMode || metric === "locked")) lo -= padV;
  hi += padV;
  const span = t1 - t0;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, span)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const yt = ticks(lo, hi);
  const xt = series.length > 1 ? [t0, t0 + span / 2, t1] : [t0];
  const single = series.length === 1 && !barMode;
  const px = (ts: number) => (single ? W / 2 : barMode ? x(ts + bucket / 2) : x(ts));

  const pathOf = (xs: { ts: number; v: number }[]) => xs.map((s, i) => `${i ? "L" : "M"}${px(s.ts).toFixed(1)},${y(s.v).toFixed(1)}`).join(" ");
  const line = pathOf(series);
  const area = !single && !perPool ? `${line} L${px(series[series.length - 1]!.ts).toFixed(1)},${H - PAD.b} L${px(series[0]!.ts).toFixed(1)},${H - PAD.b} Z` : "";

  const nearest = (clientX: number) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return undefined;
    const at = ((clientX - r.left) / r.width) * W;
    let best = 0;
    let d = Infinity;
    series.forEach((s, i) => {
      const dd = Math.abs(px(s.ts) - at);
      if (dd < d) {
        d = dd;
        best = i;
      }
    });
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => setHover(nearest(e.clientX));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setHover((h) => {
      const cur = h ?? series.length - 1;
      return Math.max(0, Math.min(series.length - 1, cur + (e.key === "ArrowRight" ? 1 : -1)));
    });
  };
  const hp = hover !== undefined ? series[hover] : undefined;
  const cw = Math.max(3, Math.min(18, ((W - PAD.l - PAD.r) / Math.max(1, (t1 - t0) / bucket)) * 0.6));
  const axis = (v: number) =>
    metric === "rate" ? `${(v * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%` : metric === "price" ? v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : v >= 1 ? 2 : 4 }) : compactNum(v);

  return (
    <figure className="space-y-3" data-testid={testId}>
      {header}
      <div className="relative" ref={box}>
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          className="h-[220px] w-full touch-pan-y select-none outline-none focus-visible:rounded-[var(--radius-control)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
          preserveAspectRatio="none"
          role="img"
          tabIndex={0}
          aria-labelledby={`${id}-desc`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(undefined)}
          onBlur={() => setHover(undefined)}
          onKeyDown={onKey}
          data-testid={`${testId}-svg`}
        >
          <desc id={`${id}-desc`}>
            {label} over time, {series.length} point{series.length > 1 ? "s" : ""}, from {fmtValue(series[0]!.v, metric, quote)} to {fmtValue(last!.v, metric, quote)}.
          </desc>
          {yt.map((v) => (
            <line key={v} x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 4" />
          ))}
          {metric === "price" && buyBackPrice && (
            <line x1={PAD.l} x2={W - PAD.r} y1={y(buyBackPrice)} y2={y(buyBackPrice)} stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" data-testid={`${testId}-buyback`} />
          )}
          {barMode ? (
            series.map((b, i) => (
              <rect
                key={b.ts}
                x={px(b.ts) - cw / 2}
                y={y(b.v)}
                width={cw}
                height={Math.max(1, H - PAD.b - y(b.v))}
                rx={2}
                fill="var(--chart-line)"
                fillOpacity={hover === undefined || hover === i ? 0.85 : 0.4}
                data-testid={`${testId}-bar`}
              />
            ))
          ) : useBars ? (
            bars.map((b) => {
              const cx = x(b.t + bucket / 2);
              const up = b.c >= b.o;
              const col = up ? "var(--good)" : "var(--bad)";
              const top = y(Math.max(b.o, b.c));
              const h = Math.max(2, Math.abs(y(b.o) - y(b.c)));
              return (
                <g key={b.t} data-testid={`${testId}-candle`} data-dir={up ? "up" : "down"}>
                  <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <rect x={cx - cw / 2} y={top} width={cw} height={h} rx={1.5} fill={col} fillOpacity={up ? 0.9 : 0.25} stroke={col} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                </g>
              );
            })
          ) : (
            <>
              {area && <path d={area} fill="var(--chart-line)" fillOpacity={0.08} stroke="none" />}
              {perPool ? (
                lines.map((l) => {
                  const on = l === focusSeries;
                  return (
                    <path
                      key={l[0]?.pool ?? ""}
                      d={pathOf(l)}
                      fill="none"
                      stroke="var(--chart-line)"
                      strokeOpacity={on ? 1 : 0.4}
                      strokeWidth={on ? 2 : 1.5}
                      vectorEffect="non-scaling-stroke"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      data-testid={on ? `${testId}-line` : `${testId}-line-other`}
                    />
                  );
                })
              ) : (
                <path d={line} fill="none" stroke="var(--chart-line)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" data-testid={`${testId}-line`} />
              )}
              {(single || series.length <= 8) &&
                series.map((s, i) => <circle key={i} cx={px(s.ts)} cy={y(s.v)} r={4} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
            </>
          )}
          {hp && !barMode && (
            <g aria-hidden>
              <line x1={px(hp.ts)} x2={px(hp.ts)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle cx={px(hp.ts)} cy={y(hp.v)} r={5} fill="var(--chart-line)" stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </svg>
        {/* axis labels as HTML so they keep their size when the SVG stretches */}
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {yt.map((v) => (
            <span key={v} className="num absolute right-0 -translate-y-1/2 text-label text-ink-3" style={{ top: `${(y(v) / H) * 100}%` }}>
              {axis(v)}
            </span>
          ))}
          {xt.map((t, i) => (
            <span key={i} className={`num absolute bottom-0 text-label text-ink-3 ${i === 0 ? "" : i === xt.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: `${((single ? W / 2 : x(t)) / W) * 100}%` }}>
              {tickTime(t, span)}
            </span>
          ))}
          {metric === "price" && buyBackPrice && (
            <span className="num absolute left-2 -translate-y-full pb-0.5 text-label text-ink-3" style={{ top: `${(y(buyBackPrice) / H) * 100}%` }}>
              Buy-back {buyBackPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}
            </span>
          )}
        </div>
      </div>
      {footer}
    </figure>
  );
}

function changeText(a: number, b: number, metric: Metric): string {
  if (metric === "rate") {
    const d = (b - a) * 100;
    return `${d >= 0 ? "+" : ""}${d.toFixed(2)} points over the range`;
  }
  const d = a ? (b - a) / a : 0;
  return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(2)}% over the range`;
}
