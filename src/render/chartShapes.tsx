/**
 * Analysis charts on sheets (see sheets/model.ts `chartOf`). Drawn as plain vector shapes — no
 * gradients or filters — so they stay crisp in PDF, SVG and DXF: sun path (polar, north up),
 * wind rose (16 sectors), colour legend (the analysis ramp in solid steps) and summary table.
 * Sizes are printed millimetres × the paper's scale.
 */
import type { ReactNode } from 'react';
import type { ArchaiDocument, Element, ElementTable } from '@/document';
import { FONT_FAMILY } from '@/geometry/text';
import { ramp } from '@/analysis/layer3d';
import { analysisOf, siteOf, type AnalysisMeta } from '@/analysis/model';
import { daySamples, localToUtc, sunPosition } from '@/analysis/sun';
import { chartOf, paperAncestor, paperScaleOf, type ChartMeta } from '@/sheets/model';

const INK = '#1f2024';
const MUTED = '#6b6d75';
const LIGHT = '#c9ccd2';
const SECTORS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

interface ChartProps {
  element: Element & { kind: 'rect' };
  chart: ChartMeta;
  meta: AnalysisMeta | null;
  doc: ArchaiDocument;
  s: number;
}

function Caption({ x, y, text, s, size = 2.6, anchor = 'middle', weight = 600, fill = INK }: { x: number; y: number; text: string; s: number; size?: number; anchor?: 'start' | 'middle' | 'end'; weight?: number; fill?: string }) {
  return (
    <text x={x} y={y} fontSize={size * s} fontFamily={FONT_FAMILY} fontWeight={weight} fill={fill} textAnchor={anchor} dominantBaseline="central">
      {text}
    </text>
  );
}

function rgb([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

function SunPath({ element, meta, doc, s }: ChartProps) {
  const size = Math.min(element.width, element.height - 10 * s);
  const R = size / 2 - 6 * s;
  const cx = element.width / 2;
  const cy = size / 2;
  const point = (altitudeDeg: number, azimuthDeg: number) => {
    const r = R * (1 - Math.max(0, altitudeDeg) / 90);
    const a = (azimuthDeg * Math.PI) / 180;
    return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
  };
  if (!meta) return <Caption x={cx} y={cy} text="Analysis origin deleted" s={s} weight={400} fill={MUTED} />;
  const site = siteOf(doc, meta);
  const year = (meta.date || '2026-06-21').slice(0, 4);
  const days = [
    { date: `${year}-06-21`, label: '21 Jun', color: '#f59e0b' },
    { date: `${year}-03-20`, label: '20 Mar / 22 Sep', color: '#10b981' },
    { date: `${year}-12-21`, label: '21 Dec', color: '#3b82f6' },
    // A study on a reference date is drawn once, as the study.
  ].filter((day) => day.date !== meta.date);
  const study = { date: meta.date, label: meta.date, color: '#e11d48' };
  const pathFor = (date: string) => {
    const parts: string[] = [];
    let open = false;
    for (let minute = 0; minute < 24 * 60; minute += 10) {
      const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      const p = sunPosition(localToUtc(date, time, site.utcOffset), site.lat, site.lon);
      const alt = (p.altitude * 180) / Math.PI;
      if (alt <= 0) {
        open = false;
        continue;
      }
      const q = point(alt, (p.azimuth * 180) / Math.PI);
      parts.push(`${open ? 'L' : 'M'}${q.x} ${q.y}`);
      open = true;
    }
    return parts.join(' ');
  };
  const hours = Array.from({ length: 24 }, (_, h) => h).flatMap((h) => {
    const p = sunPosition(localToUtc(meta.date, `${String(h).padStart(2, '0')}:00`, site.utcOffset), site.lat, site.lon);
    const alt = (p.altitude * 180) / Math.PI;
    return alt > 0 ? [{ h, ...point(alt, (p.azimuth * 180) / Math.PI) }] : [];
  });
  return (
    <g>
      {[0, 30, 60].map((alt) => (
        <circle key={alt} cx={cx} cy={cy} r={R * (1 - alt / 90)} fill="none" stroke={alt === 0 ? INK : LIGHT} strokeWidth={(alt === 0 ? 0.35 : 0.18) * s} />
      ))}
      {Array.from({ length: 12 }, (_, i) => i * 30).map((az) => {
        const outer = point(0, az);
        return <line key={az} x1={cx} y1={cy} x2={outer.x} y2={outer.y} stroke={LIGHT} strokeWidth={0.15 * s} />;
      })}
      {[30, 60].map((alt) => <Caption key={alt} x={cx + 1 * s} y={cy - R * (1 - alt / 90) - 1.4 * s} text={`${alt}°`} s={s} size={1.8} anchor="start" weight={400} fill={MUTED} />)}
      {(['N', 'E', 'S', 'W'] as const).map((label, i) => {
        const p = point(-8, i * 90);
        const q = { x: cx + (p.x - cx) * 1.09, y: cy + (p.y - cy) * 1.09 };
        return <Caption key={label} x={q.x} y={q.y} text={label} s={s} size={2.6} />;
      })}
      {days.map((day) => <path key={day.date} d={pathFor(day.date)} fill="none" stroke={day.color} strokeWidth={0.35 * s} strokeDasharray={`${1.2 * s} ${0.8 * s}`} />)}
      <path d={pathFor(study.date)} fill="none" stroke={study.color} strokeWidth={0.6 * s} />
      {hours.map((hour) => (
        <g key={hour.h}>
          <circle cx={hour.x} cy={hour.y} r={0.7 * s} fill={study.color} />
          {hour.h % 3 === 0 && <Caption x={hour.x} y={hour.y - 2.4 * s} text={String(hour.h)} s={s} size={1.9} weight={500} />}
        </g>
      ))}
      <g transform={`translate(0 ${size + 1 * s})`}>
        {[study, ...days].map((day, i) => (
          <g key={day.label + i} transform={`translate(${(i % 2) * element.width * 0.5} ${Math.floor(i / 2) * 3.4 * s})`}>
            <line x1={2 * s} y1={0} x2={7 * s} y2={0} stroke={day.color} strokeWidth={(i === 0 ? 0.6 : 0.35) * s} />
            <Caption x={8.5 * s} y={0} text={i === 0 ? `${day.label} (study)` : day.label} s={s} size={2} anchor="start" weight={400} />
          </g>
        ))}
      </g>
    </g>
  );
}

function WindRose({ element, meta, s }: ChartProps) {
  const size = Math.min(element.width, element.height - 8 * s);
  const R = size / 2 - 6 * s;
  const cx = element.width / 2;
  const cy = size / 2;
  if (!meta) return <Caption x={cx} y={cy} text="Analysis origin deleted" s={s} weight={400} fill={MUTED} />;
  const polar = (r: number, bearing: number) => ({ x: cx + r * Math.sin((bearing * Math.PI) / 180), y: cy - r * Math.cos((bearing * Math.PI) / 180) });
  const rose = meta.windData?.rose;
  const max = rose ? Math.max(...rose, 0.0001) : 1;
  const petals = rose
    ? rose.map((share, i) => {
        const r = (R * share) / max;
        const a = polar(r, i * 22.5 - 9);
        const b = polar(r, i * 22.5 + 9);
        const [cr, cg, cb] = ramp(share / max);
        return <path key={i} d={`M${cx} ${cy} L${a.x} ${a.y} A${r} ${r} 0 0 1 ${b.x} ${b.y} Z`} fill={rgb([cr, cg, cb])} fillOpacity={0.85} stroke={INK} strokeWidth={0.12 * s} />;
      })
    : (() => {
        // Only the study wind: one arrow blowing from its direction.
        const from = polar(R, meta.direction);
        const to = polar(R * 0.15, meta.direction);
        return [<line key="arrow" x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#e11d48" strokeWidth={0.8 * s} />, <circle key="dot" cx={from.x} cy={from.y} r={1.2 * s} fill="#e11d48" />];
      })();
  const caption = meta.windData ? `Mean ${meta.windData.meanSpeed.toFixed(1)} m/s · prevailing ${SECTORS[Math.round(meta.windData.prevailing / 22.5) % 16]} · ${meta.windData.from.slice(0, 4)}–${meta.windData.to.slice(0, 4)}` : `Study wind ${meta.speed.toFixed(1)} m/s from ${Math.round(meta.direction)}°`;
  return (
    <g>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <circle key={f} cx={cx} cy={cy} r={R * f} fill="none" stroke={f === 1 ? INK : LIGHT} strokeWidth={(f === 1 ? 0.3 : 0.15) * s} />
      ))}
      {rose && <Caption x={cx + 1 * s} y={cy - R - 1.5 * s} text={`${Math.round(max * 100)}%`} s={s} size={1.8} anchor="start" weight={400} fill={MUTED} />}
      {petals}
      {(['N', 'E', 'S', 'W'] as const).map((label, i) => {
        const p = polar(R + 3.2 * s, i * 90);
        return <Caption key={label} x={p.x} y={p.y} text={label} s={s} size={2.6} />;
      })}
      <Caption x={cx} y={size + 2.5 * s} text={caption} s={s} size={2.1} weight={400} />
    </g>
  );
}

function Legend({ element, chart, meta, doc, s }: ChartProps) {
  const w = element.width;
  const barY = 6.5 * s;
  const barH = 3.2 * s;
  if (!meta) return <Caption x={w / 2} y={barY} text="Analysis origin deleted" s={s} weight={400} fill={MUTED} />;
  let labels: [string, string, string] = ['', '', ''];
  let twoTone = false;
  if (meta.kind === 'sun') {
    if (meta.display === 'sun-hours') {
      const site = siteOf(doc, meta);
      const total = daySamples(meta.date, site.utcOffset, site.lat, site.lon, meta.northAngle, 60).reduce((sum, d) => sum + d.hours, 0);
      labels = ['0 h', `${(total / 2).toFixed(1)} h`, `${total.toFixed(1)} h`];
    } else {
      twoTone = true;
      labels = ['shade', '', 'direct sun'];
    }
  } else if (meta.kind === 'noise') labels = [`${meta.min} dB`, `${(meta.min + meta.max) / 2} dB`, `${meta.max} dB`];
  else labels = ['calm', `${(meta.speed * 0.75).toFixed(1)} m/s`, `${(meta.speed * 1.5).toFixed(1)} m/s`];
  const steps = 40;
  const stepW = w / steps;
  return (
    <g>
      <Caption x={0} y={2 * s} text={chart.title} s={s} size={2.6} anchor="start" />
      {twoTone ? (
        <>
          <rect x={0} y={barY} width={w / 2} height={barH} fill="#3d3f47" />
          <rect x={w / 2} y={barY} width={w / 2} height={barH} fill="#f2f0e8" stroke={LIGHT} strokeWidth={0.15 * s} />
        </>
      ) : (
        Array.from({ length: steps }, (_, i) => <rect key={i} x={i * stepW} y={barY} width={stepW + 0.02 * s} height={barH} fill={rgb(ramp((i + 0.5) / steps))} />)
      )}
      <rect x={0} y={barY} width={w} height={barH} fill="none" stroke={INK} strokeWidth={0.18 * s} />
      <Caption x={0} y={barY + barH + 2.4 * s} text={labels[0]} s={s} size={2.1} anchor="start" weight={400} />
      <Caption x={w / 2} y={barY + barH + 2.4 * s} text={labels[1]} s={s} size={2.1} weight={400} />
      <Caption x={w} y={barY + barH + 2.4 * s} text={labels[2]} s={s} size={2.1} anchor="end" weight={400} />
    </g>
  );
}

function Table({ element, chart, s }: ChartProps) {
  const w = element.width;
  const row = 6 * s;
  const cols = [0, 0.44, 0.58, 0.72, 0.86].map((f) => f * w);
  const unit = chart.unit ? ` ${chart.unit}` : '';
  const header = ['Area', 'Min', 'Mean', 'Max', `≥ ${chart.threshold}${unit}`];
  const top = 8 * s;
  return (
    <g>
      <Caption x={0} y={2.5 * s} text={chart.title} s={s} size={2.8} anchor="start" />
      <line x1={0} y1={top} x2={w} y2={top} stroke={INK} strokeWidth={0.35 * s} />
      {header.map((label, i) => <Caption key={label} x={i === 0 ? 0 : cols[i]! + (w * 0.13)} y={top + row / 2} text={label} s={s} size={2.1} anchor={i === 0 ? 'start' : 'end'} weight={600} fill={MUTED} />)}
      <line x1={0} y1={top + row} x2={w} y2={top + row} stroke={INK} strokeWidth={0.2 * s} />
      {chart.rows.map((r, index) => {
        const y = top + row * (index + 1.5);
        const cells = [r.name, r.min.toFixed(1), r.mean.toFixed(1), r.max.toFixed(1), `${Math.round(r.share * 100)}%`];
        return (
          <g key={`${r.name}-${index}`}>
            {cells.map((cell, i) => <Caption key={i} x={i === 0 ? 0 : cols[i]! + w * 0.13} y={y} text={i === 0 && r.kind !== 'surface' ? `${cell} (${r.kind})` : cell} s={s} size={2.2} anchor={i === 0 ? 'start' : 'end'} weight={i === 0 ? 500 : 400} />)}
            <line x1={0} y1={y + row / 2} x2={w} y2={y + row / 2} stroke={LIGHT} strokeWidth={0.12 * s} />
          </g>
        );
      })}
      {chart.rows.length === 0 && <Caption x={0} y={top + row * 1.5} text="No samples inside rooms or zones" s={s} size={2.2} anchor="start" weight={400} fill={MUTED} />}
    </g>
  );
}

/** The chart renderer for a sheet item, if it is one. */
export function chartShape(element: Element & { kind: 'rect' }, elements: ElementTable | undefined): ReactNode | undefined {
  const chart = chartOf(element);
  if (!chart) return undefined;
  const s = paperScaleOf(elements ? paperAncestor(elements, element) : null);
  const meta = chart.originId && elements ? analysisOf(elements[chart.originId]) : null;
  const doc = { elements: elements ?? {} } as ArchaiDocument;
  const props: ChartProps = { element, chart, meta, doc, s };
  if (chart.kind === 'sun-path') return <SunPath {...props} />;
  if (chart.kind === 'wind-rose') return <WindRose {...props} />;
  if (chart.kind === 'legend') return <Legend {...props} />;
  return <Table {...props} />;
}
