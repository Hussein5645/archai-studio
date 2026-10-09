import type { Element, RectElement } from '@/document';
import { executionLinksOf, GRAPH_START, graphRuntimeOf, parametricGraphOf } from '@/commands/builtin/parametric';
import { FONT_FAMILY } from '@/geometry';
import { useAppState } from '@/app/context';

/** Board portal for a component's graph; all geometry is SVG so it also exports. */
export function GraphOrigin({ element, component }: { element: RectElement; component?: Element }) {
  const selection = useAppState((state) => state.ui.selection);
  const graph = parametricGraphOf(component?.meta?.['parametricGraph']);
  const runtime = graphRuntimeOf(component);
  const nodes = [{ id: GRAPH_START, label: 'Start', kind: 'start', x: graph?.startPosition?.x ?? 40, y: graph?.startPosition?.y ?? 20 }, ...(graph?.nodes ?? [])];
  const minX = Math.min(...nodes.map((node) => node.x)) - 40;
  const minY = Math.min(...nodes.map((node) => node.y)) - 40;
  const maxX = Math.max(...nodes.map((node) => node.x + 220)) + 40;
  const maxY = Math.max(...nodes.map((node) => node.y + 90)) + 40;
  const unit = element.width / 1200;
  const padding = 35 * unit;
  const header = 95 * unit;
  const links = [...(graph?.links ?? []).map((link) => ({ ...link, execution: false })), ...(graph ? executionLinksOf(graph).map((link) => ({ ...link, execution: true })) : [])];
  return <g data-graph-origin={component?.id}>
    <title>Graph origin · double-click to open the full-screen node graph</title>
    <rect width={element.width} height={element.height} rx={25 * unit} fill="#f7f9fd" stroke="#2563eb" strokeWidth={8 * unit} />
    <text x={padding} y={55 * unit} fontSize={34 * unit} fontFamily={FONT_FAMILY} fontWeight={600} fill="#1e40af">{(component?.name ?? 'Parametric component').slice(0, 48)} · Graph</text>
    <line x1={0} y1={header} x2={element.width} y2={header} stroke="#cbd5e1" strokeWidth={2 * unit} />
    <svg x={padding} y={header + padding / 2} width={element.width - padding * 2} height={Math.max(1, element.height - header - padding * 2)} viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}>
      {links.map((link, index) => {
        const from = nodes.find((node) => node.id === link.fromNode);
        const to = nodes.find((node) => node.id === link.toNode);
        if (!from || !to) return null;
        return <path key={index} d={`M ${from.x + 220} ${from.y + 45} C ${from.x + 280} ${from.y + 45}, ${to.x - 60} ${to.y + 45}, ${to.x} ${to.y + 45}`} fill="none" stroke={link.execution ? '#475569' : '#60a5fa'} strokeWidth={3} strokeDasharray={link.execution ? '10 5' : undefined} />;
      })}
      {nodes.map((node) => <g key={node.id} data-element-id={'elementId' in node ? node.elementId : undefined} data-selected={'elementId' in node && selection.includes(node.elementId ?? '') || undefined} transform={`translate(${node.x},${node.y})`}>
        <rect width={220} height={90} rx={9} fill={'elementId' in node && selection.includes(node.elementId ?? '') ? '#dbeafe' : '#fff'} stroke={node.kind === 'math' ? '#0f766e' : '#2563eb'} strokeWidth={'elementId' in node && selection.includes(node.elementId ?? '') ? 6 : 2} />
        <text x={12} y={30} fontFamily={FONT_FAMILY} fontSize={17} fontWeight={600} fill="#334155">{(node.kind === 'output' ? 'Finish' : node.label).slice(0, 22)}</text>
        <text x={12} y={63} fontFamily={FONT_FAMILY} fontSize={14} fill="#64748b">{node.kind === 'element' || node.kind === 'cai-model' ? 'Instance' : node.kind === 'math' ? 'Calculation' : node.kind === 'variable' ? 'Variable' : 'Execution'}</text>
      </g>)}
    </svg>
    <text x={padding} y={element.height - 16 * unit} fontFamily={FONT_FAMILY} fontSize={22 * unit} fill={runtime.status === 'running' ? '#047857' : runtime.status === 'error' ? '#b91c1c' : '#64748b'}>Double-click to open · {graph?.nodes.filter((node) => node.elementId).length ?? 0} instances · {runtime.status === 'running' ? 'Running' : runtime.status === 'error' ? 'Stopped — error' : 'Stopped'}</text>
  </g>;
}
