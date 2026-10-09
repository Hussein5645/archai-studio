import { useAppState, useDispatch } from '@/app/context';
import { wallPathKind, wallPathParameters } from '@/assets/wall-path';
import type { CurvePath, LineElement } from '@/document';
import { applyToPoint, worldMatrix } from '@/geometry';
import { Field, FieldRow, NumberField, SelectField } from './primitives';

/** The same placement fields are editable in the inspector and locked in the type window. */
export function PathGeometryFields({ element, readOnly = false, controlled = new Set<string>() }: { element: LineElement; readOnly?: boolean; controlled?: Set<string> }) {
  const dispatch = useDispatch();
  const doc = useAppState((state) => state.doc);
  const matrix = worldMatrix(doc.elements, element);
  const kind = wallPathKind(element);
  const start = element.path?.start ?? element.points[0]!;
  const end = element.points.at(-1)!;
  const disabled = (key: string) => readOnly || element.locked || controlled.has(key) || controlled.has('x') || controlled.has('y');
  const pointFields = (label: string, point: [number, number], locked: boolean, commit: (x: number, y: number) => void) => {
    const world = applyToPoint(matrix, { x: point[0], y: point[1] });
    return <FieldRow key={label}>{(['x', 'y'] as const).map((axis) => <Field key={axis} label={`${label} ${axis.toUpperCase()}`}><NumberField value={world[axis]} unit={doc.workspace.unit} precision={doc.workspace.precision} disabled={locked} ariaLabel={`${label} ${axis.toUpperCase()}`} onCommit={(value) => commit(axis === 'x' ? value : world.x, axis === 'y' ? value : world.y)} /></Field>)}</FieldRow>;
  };
  const setKind = (value: string) => {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    let path: CurvePath | null = null;
    if (value === 'bezier') path = { start, segments: [{ kind: 'bezier', control1: [start[0] + dx / 3 - dy * 0.2, start[1] + dy / 3 + dx * 0.2], control2: [start[0] + dx * 2 / 3 - dy * 0.2, start[1] + dy * 2 / 3 + dx * 0.2], to: end }] };
    if (value === 'arc') {
      const center: [number, number] = [(start[0] + end[0]) / 2 - dy * 0.25, (start[1] + end[1]) / 2 + dx * 0.25];
      path = { start, segments: [{ kind: 'arc', center, radius: Math.hypot(start[0] - center[0], start[1] - center[1]), startAngle: Math.atan2(start[1] - center[1], start[0] - center[0]), endAngle: Math.atan2(end[1] - center[1], end[0] - center[0]), clockwise: false }] };
    }
    void dispatch('set-line-curve-path', { id: element.id, path });
  };
  const arc = element.path?.segments[0];
  let handleNumber = 0;
  return <div data-testid="path-geometry-fields">
    <FieldRow single><Field label="Path geometry"><SelectField value={kind} options={[{ value: 'straight', label: 'Straight' }, { value: 'arc', label: 'Arc' }, { value: 'bezier', label: 'Bézier' }]} disabled={disabled('parameter:pathType')} onChange={setKind} ariaLabel="Wall path geometry" /></Field></FieldRow>
    <small>{readOnly ? 'Instance placement · edit in the inspector' : 'Coordinates use project space and project units.'}</small>
    {pointFields('Start point', start, disabled('startPoint'), (x, y) => void dispatch('move-line-endpoint', { id: element.id, endpoint: 'start', x, y }))}
    {pointFields('End point', end, disabled('endPoint'), (x, y) => void dispatch('move-line-endpoint', { id: element.id, endpoint: 'end', x, y }))}
    {kind === 'arc' && arc?.kind === 'arc' && <>
      <FieldRow single><Field label="Arc bend"><NumberField value={wallPathParameters(element).arcBulge ?? 0} precision={3} disabled={disabled('parameter:arcBulge')} ariaLabel="Arc bend" onCommit={(bend) => {
        const center: [number, number] = [(start[0] + end[0]) / 2 - (end[1] - start[1]) * bend, (start[1] + end[1]) / 2 + (end[0] - start[0]) * bend];
        void dispatch('set-line-curve-path', { id: element.id, path: { start, segments: [{ ...arc, center, radius: Math.hypot(start[0] - center[0], start[1] - center[1]), startAngle: Math.atan2(start[1] - center[1], start[0] - center[0]), endAngle: Math.atan2(end[1] - center[1], end[0] - center[0]), clockwise: bend < 0 }] } });
      }} /></Field></FieldRow>
      {pointFields('Arc centre', arc.center, true, () => {})}
      <FieldRow single><Field label="Arc radius"><NumberField value={arc.radius} unit={doc.workspace.unit} precision={doc.workspace.precision} disabled ariaLabel="Arc radius" onCommit={() => {}} /></Field></FieldRow>
    </>}
    {kind === 'bezier' && <>
      <FieldRow single><Field label="Handle count"><NumberField value={element.path?.segments.reduce((sum, segment) => sum + (segment.kind === 'bezier' ? 2 : segment.kind === 'quadratic' ? 1 : 0), 0) ?? 0} min={2} max={64} step={2} precision={0} disabled={disabled('parameter:bezierHandles')} ariaLabel="Handle count" onCommit={(count) => void dispatch('set-wall-handle-count', { id: element.id, count })} /></Field></FieldRow>
      <small>Two handles per cubic segment. Add pairs to refine the curve; removing pairs reshapes it.</small>
      {element.path?.segments.flatMap((segment, index) => {
        const handles = segment.kind === 'bezier' ? [['control1', segment.control1], ['control2', segment.control2]] as const : segment.kind === 'quadratic' ? [['control', segment.control]] as const : [];
        return handles.map(([handle, point]) => pointFields(`Handle ${++handleNumber}`, point, disabled('parameter:bezierHandles'), (x, y) => void dispatch('move-line-curve-handle', { id: element.id, segment: index, handle, x, y })));
      })}
    </>}
  </div>;
}
