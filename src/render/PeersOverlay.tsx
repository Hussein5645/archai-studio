/**
 * The others on an online project's board (src/cloud/live.ts), like a Miro board: everyone's
 * pointer with their name in their colour, gliding smoothly between updates, and an outline in
 * their colour around what they have selected. Also reports this pointer's board position so
 * they see yours. Nothing for local projects.
 *
 * Pointers are animated in board coordinates (so they stay put while you pan or zoom) and drawn
 * in screen space at a fixed size.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp, useAppState, useLiveState } from '@/app/context';
import type { Peer } from '@/cloud/live';
import { orientedCorners, screenToWorld, worldToScreen, type Vec2 } from '@/geometry';
import { boardDoc } from '@/store';
import styles from './Workboard.module.css';

/** Share of the remaining distance covered per frame (60 fps): smooth, but never far behind. */
const FOLLOW = 0.35;

export function PeersOverlay() {
  const live = useLiveState();
  return live ? <Peers /> : null;
}

/** Each peer's pointer, eased towards the last position they sent. */
function useGlidingCursors(peers: readonly Peer[]): Map<string, Vec2> {
  const [shown, setShown] = useState(() => new Map<string, Vec2>());
  const last = useRef(new Map<string, Vec2>());

  useEffect(() => {
    let raf = 0;
    const step = () => {
      raf = 0;
      let moving = false;
      const next = new Map<string, Vec2>();
      for (const peer of peers) {
        if (!peer.cursor) continue;
        const from = last.current.get(peer.sid);
        if (!from) {
          next.set(peer.sid, peer.cursor);
          continue;
        }
        const dx = peer.cursor.x - from.x;
        const dy = peer.cursor.y - from.y;
        if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) next.set(peer.sid, peer.cursor);
        else {
          next.set(peer.sid, { x: from.x + dx * FOLLOW, y: from.y + dy * FOLLOW });
          moving = true;
        }
      }
      last.current = next;
      setShown(next);
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [peers]);

  return shown;
}

function Peers() {
  const { cloud, store } = useApp();
  const live = useLiveState();
  const viewport = useAppState((s) => s.ui.viewport);
  const elements = useAppState((s) => boardDoc(s).elements);
  const ref = useRef<SVGSVGElement>(null);
  const peers = live?.peers ?? [];
  const cursors = useGlidingCursors(peers);

  // This pointer, in board mm, for the others.
  useEffect(() => {
    const board = ref.current?.parentElement;
    if (!board) return;
    const move = (event: PointerEvent) => {
      const rect = board.getBoundingClientRect();
      const world = screenToWorld(store.getState().ui.viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top });
      cloud.setCursor({ x: Math.round(world.x * 10) / 10, y: Math.round(world.y * 10) / 10 });
    };
    const leave = () => cloud.setCursor(null);
    board.addEventListener('pointermove', move, { passive: true });
    board.addEventListener('pointerleave', leave);
    return () => {
      board.removeEventListener('pointermove', move);
      board.removeEventListener('pointerleave', leave);
      cloud.setCursor(null);
    };
  }, [cloud, store]);

  return (
    <svg ref={ref} className={styles.overlay} data-testid="peers-overlay" aria-hidden="true">
      {peers.map((peer) =>
        peer.selection.map((id) => {
          const element = elements[id];
          if (!element) return null;
          const corners = orientedCorners(elements, element).map((c) => worldToScreen(viewport, c));
          return <polygon key={`${peer.sid}:${id}`} points={corners.map((c) => `${c.x},${c.y}`).join(' ')} fill="none" stroke={peer.colour} strokeWidth={2} strokeDasharray="6 3" opacity={0.85} />;
        }),
      )}
      {peers.map((peer) => {
        const cursor = cursors.get(peer.sid);
        if (!peer.cursor || !cursor) return null;
        const at = worldToScreen(viewport, cursor);
        const label = peer.name || 'Someone';
        return (
          <g key={peer.sid} transform={`translate(${at.x} ${at.y})`} data-testid={`peer-cursor-${peer.sid}`}>
            <path d="M0 0 L0 15 L4.2 11.2 L7.2 17.6 L9.6 16.5 L6.7 10.2 L12 10.2 Z" fill={peer.colour} stroke="#ffffff" strokeWidth={1.2} strokeLinejoin="round" />
            <rect x={13} y={14} width={label.length * 6.6 + 12} height={18} rx={9} fill={peer.colour} />
            <text x={19} y={26.5} fontSize={11} fontWeight={600} fill="#ffffff">
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
