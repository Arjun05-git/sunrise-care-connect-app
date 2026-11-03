import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Small dependency-free SVG charts for the admin dashboard. Series colours are the validated categorical
 * tokens --viz-1…4 (fixed order, light and dark steps in index.css); text always uses text tokens. Every
 * chart has hover / focus tooltips and a table view (two light-mode hues are below 3:1 on white, so the
 * table and the legend carry identity, never colour alone).
 */
export interface Series { key: string; label: string; color: string }
export interface Column { label: string; full: string; values: Record<string, number> }

export function ChartCard({ title, legend, table, children, className }: { title: string; legend?: Series[]; table: ReactNode; children: ReactNode; className?: string }) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />}{asTable ? t('adm.chart.chart') : t('adm.chart.table')}
        </Button>
      </CardHeader>
      <CardContent>
        {legend && legend.length > 1 && !asTable && (
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t('adm.chart.legend')}>
            {legend.map((s) => <li key={s.key} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />{s.label}</li>)}
          </ul>
        )}
        {asTable ? <div className="max-h-72 overflow-auto">{table}</div> : children}
      </CardContent>
    </Card>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A round step (1, 2 or 5 × 10ⁿ) giving about four gridlines; never fractional for counts. */
const niceStep = (range: number) => {
  if (range <= 0) return 1;
  const raw = range / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  return Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((m) => m >= raw)!);
};

/** Stacked (or single-series) columns over time. Values may be negative for a single series (net revenue). */
export function ColumnChart({ columns, series, format = String, height = 220, label }: { columns: Column[]; series: Series[]; format?: (n: number) => string; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const pad = { l: 44, r: 8, t: 8, b: 24 };
  const totals = columns.map((c) => series.reduce((s, x) => s + Math.max(0, c.values[x.key] ?? 0), 0));
  const mins = columns.map((c) => Math.min(0, ...series.map((x) => c.values[x.key] ?? 0)));
  const hi = Math.max(1, ...totals);
  const lo = Math.min(0, ...mins);
  const stepV = niceStep(hi - lo);
  const top = Math.ceil(hi / stepV) * stepV;
  const bottom = Math.floor(lo / stepV) * stepV;
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const y = (v: number) => pad.t + ((top - v) / (top - bottom)) * plotH;
  const step = plotW / Math.max(columns.length, 1);
  const barW = Math.max(3, Math.min(28, step - Math.max(2, step * 0.3)));
  const ticks = Array.from({ length: Math.round((top - bottom) / stepV) + 1 }, (_, i) => bottom + i * stepV);
  const every = Math.ceil(columns.length / Math.max(2, Math.floor(plotW / 64)));
  const h = hover != null ? columns[hover] : null;

  return (
    <div ref={ref} className="relative w-full min-w-0" onMouseLeave={() => setHover(null)}>
      {/* a labelled group with a list of focusable columns (role="img" would hide the columns from screen readers) */}
      <svg width={width} height={height} role="group" aria-labelledby={`${id}-t`} className="block">
        <title id={`${id}-t`}>{label}</title>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} className={cn('stroke-border', v === 0 ? 'stroke-[1.5]' : 'stroke-1 [stroke-dasharray:2_4]')} />
            <text x={pad.l - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{format(v)}</text>
          </g>
        ))}
        <g role="list">
        {columns.map((c, i) => {
          const cx = pad.l + step * i + step / 2;
          let acc = 0;
          const segs = series.map((s) => ({ s, v: c.values[s.key] ?? 0 })).filter((x) => x.v !== 0);
          return (
            <g key={c.full} tabIndex={0} role="listitem" aria-label={`${c.full}: ${segs.map((x) => `${x.s.label} ${format(x.v)}`).join(', ') || format(0)}`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} className="outline-none focus-visible:[&>rect.hit]:fill-accent">
              <rect className="hit fill-transparent" x={cx - step / 2} y={pad.t} width={step} height={plotH} />
              {hover === i && <rect x={cx - step / 2} y={pad.t} width={step} height={plotH} className="fill-accent/60" />}
              {segs.map(({ s, v }, k) => {
                const neg = v < 0;
                const isTop = !neg && k === segs.length - 1;
                const gap = !neg && !isTop ? 2 : 0;   // 2 px surface gap above every segment that has another on top
                const y0 = (neg ? y(0) : y(acc + v)) + gap;
                const hgt = Math.max(1, Math.abs(y(0) - y(Math.abs(v))) - gap);
                if (!neg) acc += v;
                const r = Math.min(4, barW / 2, hgt);
                const x0 = cx - barW / 2;
                const path = neg
                  ? `M${x0},${y0} h${barW} v${hgt - r} a${r},${r} 0 0 1 ${-r},${r} h${-(barW - 2 * r)} a${r},${r} 0 0 1 ${-r},${-r} z`
                  : isTop
                    ? `M${x0},${y0 + hgt} v${-(hgt - r)} a${r},${r} 0 0 1 ${r},${-r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${hgt - r} z`
                    : `M${x0},${y0} h${barW} v${hgt} h${-barW} z`;
                return <path key={s.key} d={path} style={{ fill: s.color }} />;
              })}
              {i % every === 0 && <text x={cx} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">{c.label}</text>}
            </g>
          );
        })}
        </g>
      </svg>
      {h && hover != null && (
        <div role="tooltip" className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-xl border bg-popover p-2.5 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(0, pad.l + step * hover + step / 2 - 72), width - 150) }}>
          <p className="mb-1 font-semibold text-foreground">{h.full}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center justify-between gap-3 text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />{s.label}</span>
              <span className="font-semibold tabular-nums text-foreground">{format(h.values[s.key] ?? 0)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars with direct value labels (one series). */
export function RankBars({ rows, color, format = String, label }: { rows: { label: string; value: number }[]; color: string; format?: (n: number) => string; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2" aria-label={label}>
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm" title={`${r.label}: ${format(r.value)}`}>
          <span className="truncate text-muted-foreground">{r.label}</span>
          <span className="h-3 rounded-r" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: color }} aria-hidden />
          <span className="font-semibold tabular-nums">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b text-left text-xs text-muted-foreground">{head.map((h, i) => <th key={h} scope="col" className={cn('px-2 py-1.5 font-medium', i > 0 && 'text-right')}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-b last:border-0">{r.map((c, j) => <td key={j} className={cn('px-2 py-1.5', j > 0 && 'text-right tabular-nums')}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}
