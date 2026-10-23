import type { AppServices } from '@/app/context';
import { getArchTool } from '@/assets/arch-tools';

export type PlacementPoint = { x: number; y: number; elevation: number; heading: number };
/** The same creation commands as the Board, fed by floor intersections in 3D. */
export function scenePlacement({
  store,
  executor,
  toasts,
}: Pick<AppServices, 'store' | 'executor' | 'toasts'>) {
  let tool = '';
  let points: PlacementPoint[] = [];
  const run = (command: string, input: unknown) =>
    void executor.dispatch(command, input).then((result) => {
      if (!result.ok && result.error.code !== 'cancelled')
        toasts.push({ kind: 'error', message: result.error.message });
    });
  const finish = () => {
    if (tool !== store.getState().ui.tool) {
      points = [];
      return;
    }
    const arch = tool.startsWith('arch:') ? getArchTool(tool.slice(5)) : null;
    const minimum = arch?.mode.kind === 'polyline' && arch.mode.closed ? 3 : 2;
    if (points.length < minimum) return;
    const path = points.map((p) => [p.x, p.y]);
    if (arch)
      run('create-arch-element', {
        tool: arch.id,
        points: path,
        meta: { instanceElevation: points[0]!.elevation },
      });
    else run('create-line', { points: path });
    points = [];
  };
  return {
    cancel: () => {
      points = [];
    },
    finish,
    place(point: PlacementPoint | null): boolean {
      const state = store.getState();
      // The caller is a 3D canvas. Board tools never call this handler, including split views.
      const next = state.ui.tool;
      if (next === 'arch:vr-stop') {
        if (point) run('create-vr-stop', { x: point.x, y: point.y, elevation: point.elevation, heading: point.heading });
        return true;
      }
      if (next.startsWith('arch:light-')) {
        if (tool !== next) { points = []; tool = next; }
        if (!point) return true;
        if (next === 'arch:light-spot') {
          points.push(point);
          if (points.length < 2) { toasts.push({ kind: 'info', message: 'Click the spotlight target' }); return true; }
          const source = points[0]!;
          run('create-light', { x: source.x, y: source.y, elevation: source.elevation + 2500, kind: 'spot', target: [point.x, point.y], targetElevation: point.elevation });
          points = [];
        } else run('create-light', { x: point.x, y: point.y, elevation: point.elevation + 2500, kind: next.slice(11) });
        return true;
      }
      const arch = next.startsWith('arch:') ? getArchTool(next.slice(5)) : null;
      if (!arch && !['rect', 'line', 'point', 'catalog', 'model', 'image', 'text'].includes(next))
        return false;
      if (tool !== next) {
        points = [];
        tool = next;
      }
      if (!point) {
        toasts.push({ kind: 'info', message: 'Click a floor or the ground to place the element' });
        return true;
      }
      const { x, y, elevation } = point;
      if (arch) {
        if (arch.mode.kind === 'polyline') {
          const previous = points.at(-1);
          if (!previous || Math.hypot(previous.x - x, previous.y - y) > 1) points.push(point);
          toasts.push({
            kind: 'info',
            message: 'Click more corners · Enter to finish · Esc to cancel',
          });
        } else if (arch.mode.kind === 'enclosure' || arch.mode.kind === 'level') {
          toasts.push({ kind: 'info', message: 'Create rooms and levels in the Board editor' });
        } else
          run('create-arch-element', {
            tool: arch.id,
            x,
            y,
            meta: { instanceElevation: elevation },
          });
      } else if (next === 'point') run('create-point', { x, y, elevation });
      else if (next === 'line') {
        points.push(point);
        if (points.length === 2) finish();
      } else if (next === 'rect') {
        points.push(point);
        if (points.length === 2) {
          const a = points[0]!;
          run('create-rect', {
            x: Math.min(x, a.x),
            y: Math.min(y, a.y),
            width: Math.max(1, Math.abs(x - a.x)),
            height: Math.max(1, Math.abs(y - a.y)),
            meta: { instanceElevation: a.elevation },
          });
          points = [];
        }
      } else if (next === 'catalog' && state.ui.placingAsset) {
        run('place-catalog-asset', { asset: state.ui.placingAsset, x, y, centered: true });
      } else if (next === 'model' || next === 'image') {
        run(next === 'model' ? 'import-3d-model' : 'import-image', { x, y });
        run('set-tool', { tool: 'select' });
      } else if (next === 'text') run('create-text', { x, y, text: 'Text' });
      return true;
    },
  };
}
