/** The diagram tools as toolbar entries (board toolbar menu and sheet toolbar). */
import { ArrowUpRight, GitCommitHorizontal, MessageSquareText, MoveHorizontal, SquareDashed, Tag, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolId } from '@/store';

export interface DiagramToolButton {
  tool: ToolId;
  command: string;
  label: string;
  icon: (size: number) => ReactNode;
  hint: string;
}

export const DIAGRAM_TOOLS: DiagramToolButton[] = [
  { tool: 'diagram:arrow', command: 'tool-diagram-arrow', label: 'Arrow', icon: (s) => <ArrowUpRight size={s} />, hint: 'Click points for an arrow · double-click or Enter to finish · Shift keeps 45°' },
  { tool: 'diagram:callout', command: 'tool-diagram-callout', label: 'Callout', icon: (s) => <MessageSquareText size={s} />, hint: 'Click what the note points at, then where the note goes · edit the text in the Inspector' },
  { tool: 'diagram:zone', command: 'tool-diagram-zone', label: 'Zone', icon: (s) => <SquareDashed size={s} />, hint: 'Drag a zone or bubble · name it in the Inspector; equal names share a colour' },
  { tool: 'diagram:tag', command: 'tool-diagram-tag', label: 'Tag', icon: (s) => <Tag size={s} />, hint: 'Click a room or element to tag it · the tag reads its name, area and level live' },
  { tool: 'diagram:dimension', command: 'tool-diagram-dimension', label: 'Dimension', icon: (s) => <MoveHorizontal size={s} />, hint: 'Click points along a wall for a chained dimension (snaps to wall ends and faces) · double-click to finish' },
  { tool: 'diagram:connector', command: 'tool-diagram-connector', label: 'Connector', icon: (s) => <Waypoints size={s} />, hint: 'Click one element, then another: the connector stays glued as they move' },
  { tool: 'diagram:adjacency', command: 'tool-diagram-adjacency', label: 'Adjacency', icon: (s) => <GitCommitHorizontal size={s} />, hint: 'Click two zones to link them in a bubble diagram · weight shows how strong the link is' },
];

export function diagramToolHint(tool: ToolId): string | null {
  return DIAGRAM_TOOLS.find((entry) => entry.tool === tool)?.hint ?? null;
}
