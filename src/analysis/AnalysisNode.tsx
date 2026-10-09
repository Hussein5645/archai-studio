import { Sun, Volume2, Wind } from 'lucide-react';
import { memo, type CSSProperties } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import { isEffectivelyVisible, type ArchaiDocument, type Element } from '@/document';
import { worldMatrix } from '@/geometry';
import { boardDoc } from '@/store';
import { useI18n } from '@/ui/i18n';
import { analysisOf, emittersOf, siteOf, type AnalysisMeta } from './model';
import { BoardMap } from './MapView';
import { localToUtc, sunPosition } from './sun';
import styles from './AnalysisNode.module.css';

/** Cards and labels are laid out at a fixed design width and scaled with the board. */
const CARD_WIDTH = 360;

const KIND = {
  sun: { colour: '#d97706', soft: '#fef3c7', icon: Sun },
  wind: { colour: '#0284c7', soft: '#e0f2fe', icon: Wind },
  noise: { colour: '#dc2626', soft: '#fee2e2', icon: Volume2 },
} as const;

/** Sun, wind and noise origins and the project map, drawn over their board rects (noise emitters are plain board symbols, see render/shapes). */
export const AnalysisNode = memo(function AnalysisNode({ id }: { id: string }) {
  // The map subscribes only to its own element; cards need the document for their site facts.
  const isMap = useAppState((s) => Boolean(boardDoc(s).elements[id]?.meta?.['location']));
  return isMap ? <BoardMap id={id} /> : <CardNode id={id} />;
});

function CardNode({ id }: { id: string }) {
  const doc = useAppState((s) => boardDoc(s));
  const viewport = useAppState((s) => s.ui.viewport);
  const selected = useAppState((s) => s.ui.selection.includes(id));
  const element = doc.elements[id];
  if (!element || element.kind !== 'rect' || !isEffectivelyVisible(doc.elements, id)) return null;
  const matrix = worldMatrix(doc.elements, element);
  const analysis = analysisOf(element);
  const designWidth = CARD_WIDTH;
  const scale = (element.width * viewport.zoom) / designWidth;
  const style: CSSProperties = {
    left: matrix[4] * viewport.zoom + viewport.x,
    top: matrix[5] * viewport.zoom + viewport.y,
    width: element.width * viewport.zoom,
    height: element.height * viewport.zoom,
    transform: `rotate(${(Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI}deg)`,
  };
  const designHeight = (designWidth * element.height) / element.width;
  const inner: CSSProperties = { width: designWidth, height: designHeight, transform: `scale(${scale})` };
  return (
    <div className={styles.node} style={style} data-testid={`analysis-node-${id}`}>
      <div className={styles.scaled} style={inner}>
        {analysis && <OriginCard doc={doc} element={element} meta={analysis} selected={selected} />}
      </div>
    </div>
  );
}

function Dial({ northAngle, arrow, colour }: { northAngle: number; arrow: number | null; colour: string }) {
  return (
    <svg className={styles.dial} viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r={44} fill="#f6f8fa" stroke="#d0d7de" strokeWidth={3} />
      <g transform={`rotate(${northAngle})`}>
        <path d="M0 -40 L7 -22 L-7 -22 Z" fill="#1f2328" />
        <text y={-8} textAnchor="middle" fontSize={16} fontWeight={700} fill="#1f2328">N</text>
        {arrow !== null && (
          <g transform={`rotate(${arrow})`}>
            <line x1={0} y1={0} x2={0} y2={-34} stroke={colour} strokeWidth={6} strokeLinecap="round" />
            <circle cy={-36} r={8} fill={colour} />
          </g>
        )}
      </g>
    </svg>
  );
}

function OriginCard({ doc, element, meta, selected }: { doc: ArchaiDocument; element: Element; meta: AnalysisMeta; selected: boolean }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const kind = KIND[meta.kind];
  const Icon = kind.icon;
  const site = siteOf(doc, meta);
  const views = meta.views.filter((id) => doc.elements[id]?.meta?.['view3d']).length;
  let facts: [string, string][] = [];
  let arrow: number | null = null;
  if (meta.kind === 'sun') {
    const position = sunPosition(localToUtc(meta.date, meta.time, site.utcOffset), site.lat, site.lon);
    arrow = position.altitude > 0 ? (position.azimuth * 180) / Math.PI : null;
    facts = [
      [t('When'), meta.display === 'sun-hours' ? `${meta.date} · ${t('whole day')}` : `${meta.date} ${meta.time}`],
      [t('Sun'), position.altitude > 0 ? `${((position.altitude * 180) / Math.PI).toFixed(0)}° high · ${((position.azimuth * 180) / Math.PI).toFixed(0)}°` : t('below horizon')],
    ];
  } else if (meta.kind === 'wind') {
    arrow = (meta.direction + 180) % 360;
    facts = [
      [t('Wind'), `${meta.speed.toFixed(1)} m/s ${t('from')} ${Math.round(meta.direction)}°`],
      [t('Data'), meta.windData ? `ERA5 ${meta.windData.from.slice(0, 7)} → ${meta.windData.to.slice(0, 7)}` : t('manual')],
    ];
  } else {
    facts = [
      [t('Emitters'), String(emittersOf(doc, element.id).length)],
      [t('Scale'), `${meta.min}–${meta.max} dB(A)`],
    ];
  }
  facts.push([t('Site'), site.label], [t('Views'), String(views)]);
  const style = { '--kind': kind.colour, '--kind-soft': kind.soft } as CSSProperties;
  return (
    <div className={styles.card} style={style} data-selected={selected || undefined}>
      <div className={styles.head}>
        <span className={styles.icon}>
          <Icon size={28} />
        </span>
        <span className={styles.name}>{element.name}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.facts}>
          {facts.map(([label, value]) => (
            <span key={label} className={styles.fact}>
              {label}: <b>{value}</b>
            </span>
          ))}
        </div>
        {meta.kind !== 'noise' && <Dial northAngle={meta.northAngle} arrow={arrow} colour={kind.colour} />}
      </div>
      <div className={styles.foot}>
        <button
          type="button"
          className={styles.run}
          data-on={meta.active || undefined}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void dispatch(meta.active ? 'stop-analysis' : 'run-analysis', { id: element.id })}
        >
          {meta.active ? t('Stop') : t('Run')}
        </button>
        <span className={styles.badge} data-on={meta.active || undefined}>
          {meta.active ? t('Running') : t('Stopped')}
        </span>
      </div>
    </div>
  );
}

