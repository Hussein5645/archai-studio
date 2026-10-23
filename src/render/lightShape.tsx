import type { Element } from '@/document';
import { MinScale } from './shapes';

/** Light plan symbols and editable source/aim endpoints use the element's own coordinates. */
export function lightShape(element: Element) {
  const light = element.meta?.['renderLight'] as { kind?: string; targetElevation?: number } | undefined;
  if (!light || (element.kind !== 'rect' && element.kind !== 'line')) return null;
  const start = element.kind === 'line' ? element.points[0]! : [element.width / 2, element.height / 2];
  const end = element.kind === 'line' ? element.points.at(-1)! : null;
  const x = start[0]!, y = start[1]!;
  const height = Number(element.meta?.['instanceElevation'] ?? 0);
  const stroke = '#d99b12';
  return <g stroke={stroke} fill="none" strokeWidth={12}>
    {light.kind === 'area' && element.kind === 'rect' && <>
      <rect width={element.width} height={element.height} fill="#fff0d0" fillOpacity={0.45} vectorEffect="non-scaling-stroke" strokeWidth={1.5} />
      <path d={`M0 0 L${element.width} ${element.height} M${element.width} 0 L0 ${element.height}`} vectorEffect="non-scaling-stroke" strokeWidth={1} />
    </>}
    {end && <>
      <path d={`M${x} ${y} L${end[0]} ${end[1]}`} strokeDasharray="60 40" vectorEffect="non-scaling-stroke" strokeWidth={1} />
      <MinScale x={end[0]} y={end[1]} size={200} px={16}>
        <circle cx={end[0]} cy={end[1]} r={65} fill="white" />
        <path d={`M${end[0] - 100} ${end[1]} h200 M${end[0]} ${end[1] - 100} v200`} />
        <text x={end[0] + 120} y={end[1]} fontSize={100} fill={stroke} stroke="white" strokeWidth={3} paintOrder="stroke">{Math.round(light.targetElevation ?? 0)}</text>
      </MinScale>
    </>}
    <MinScale x={x} y={y} size={240} px={22}>
      {light.kind === 'spot' ? <path d={`M${x - 75} ${y - 65} h150 v100 h-150 Z M${x - 60} ${y + 35} l-60 100 h240 l-60 -100`} fill="#fff0d0" /> : light.kind === 'area' ? <path d={`M${x - 100} ${y - 60} h200 v120 h-200 Z M${x - 60} ${y + 100} v60 M${x} ${y + 100} v60 M${x + 60} ${y + 100} v60`} fill="#fff0d0" /> : <>
        <circle cx={x} cy={y} r={60} fill="#fff0d0" />
        {Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4; return <line key={i} x1={x + Math.cos(a) * 85} y1={y + Math.sin(a) * 85} x2={x + Math.cos(a) * 120} y2={y + Math.sin(a) * 120} />; })}
      </>}
      <text x={x + 145} y={y - 80} fontSize={105} fill={stroke} stroke="white" strokeWidth={4} paintOrder="stroke">{Math.round(height)}</text>
    </MinScale>
  </g>;
}
