/**
 * Live Bridge source colours on the board (toggled in the Live Bridge panel): every element that
 * came from a connected app outlined and lightly tinted in that app's colour.
 */
import { useAppState } from '@/app/context';
import { useBridgeColours } from '@/bridge/view';
import { orientedCorners, worldToScreen } from '@/geometry';
import { boardDoc } from '@/store';
import styles from './Workboard.module.css';

export function BridgeOverlay() {
  const show = useBridgeColours();
  const bridge = useAppState((s) => boardDoc(s).bridge);
  const elements = useAppState((s) => boardDoc(s).elements);
  const viewport = useAppState((s) => s.ui.viewport);
  if (!show || !bridge) return null;
  const shapes: { id: string; colour: string; points: string }[] = [];
  for (const [id, binding] of Object.entries(bridge.elements)) {
    const element = elements[id];
    if (!element || element.kind === 'group') continue;
    const origin = Object.entries(binding.refs).find(([, ref]) => ref.role === 'origin')?.[0];
    const colour = origin ? bridge.sources[origin]?.color : undefined;
    if (!colour) continue;
    const corners = orientedCorners(elements, element).map((c) => worldToScreen(viewport, c));
    shapes.push({ id, colour, points: corners.map((c) => `${c.x},${c.y}`).join(' ') });
  }
  return (
    <svg className={styles.overlay} data-testid="bridge-overlay" aria-hidden="true">
      {shapes.map((s) => (
        <polygon key={s.id} points={s.points} fill={s.colour} fillOpacity={0.12} stroke={s.colour} strokeWidth={1.5} opacity={0.9} />
      ))}
    </svg>
  );
}
