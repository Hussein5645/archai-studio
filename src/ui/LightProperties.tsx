import { useAppState, useDispatch } from '@/app/context';
import { renderLightOf } from '@/document/renderLight';
import type { RenderLight } from '@shared/renderLights';
import { ColorField, Field, FieldRow, NumberField, SelectField, ToggleRow } from './primitives';
import styles from './Inspector.module.css';

export function LightProperties({ id }: { id: string }) {
  const doc = useAppState((s) => s.doc);
  const dispatch = useDispatch();
  const element = doc.elements[id];
  const light = element ? renderLightOf(doc, element) : null;
  if (!light) return null;
  const patch = (value: Partial<RenderLight> & { targetElevation?: number }) => void dispatch('update-light', { id, patch: value });
  return <div className={styles.section} data-testid="light-properties">
    <h3 className="u-section-title">Light</h3>
    <FieldRow><Field label="Type"><SelectField ariaLabel="Light type" value={light.kind} options={['point','spot','area'].map((value) => ({ value, label: `${value} light` }))} onChange={(kind) => patch({ kind: kind as RenderLight['kind'] })} /></Field>
      <Field label="Color"><ColorField ariaLabel="Light color" value={light.color} onCommit={(color) => color && patch({ color })} /></Field></FieldRow>
    <FieldRow single><Field label="Source elevation"><NumberField ariaLabel="Light source elevation" value={light.position[1] * 1000} unit={doc.workspace.unit} precision={doc.workspace.precision} onCommit={(elevation) => patch({ position: [light.position[0], elevation / 1000, light.position[2]] })} /></Field></FieldRow>
    {light.kind === 'spot' && element!.kind === 'line' && <FieldRow single><Field label="Target elevation"><NumberField ariaLabel="Light target elevation" value={Number((element!.meta!['renderLight'] as { targetElevation?: number }).targetElevation ?? 0)} unit={doc.workspace.unit} precision={doc.workspace.precision} onCommit={(targetElevation) => patch({ targetElevation })} /></Field></FieldRow>}
    <ToggleRow label="Light on" value={light.enabled} onChange={(enabled) => patch({ enabled })} />
    {light.kind === 'spot' && <FieldRow>
      <Field label="Inner cone"><NumberField ariaLabel="Light inner cone" value={light.innerCone ?? 20} min={0} max={light.outerCone ?? 45} precision={1} onCommit={(innerCone) => patch({ innerCone })} /></Field>
      <Field label="Outer cone"><NumberField ariaLabel="Light outer cone" value={light.outerCone ?? 45} min={1} max={89} precision={1} onCommit={(outerCone) => patch({ outerCone, innerCone: Math.min(light.innerCone ?? 20, outerCone) })} /></Field>
    </FieldRow>}
    {(['intensity','radius', ...(light.kind === 'point' ? [] : light.kind === 'spot' && element!.kind === 'line' ? [] : ['yaw','tilt']), ...(light.kind === 'area' ? ['size'] : [])] as Array<'intensity'|'radius'|'yaw'|'tilt'|'size'>).map((key) => <FieldRow single key={key}><Field label={{ intensity:'Brightness (lumens)',radius:'Reach (m)',yaw:'Direction',tilt:'Tilt',size:'Size (m)' }[key]}>
      <NumberField ariaLabel={`Light ${key}`} value={light[key]} min={key === 'intensity' ? 0 : key === 'radius' ? 0.1 : key === 'size' ? 0.01 : key === 'tilt' ? -90 : -360} max={key === 'intensity' ? 1000000 : key === 'radius' ? 1000 : key === 'size' ? 100 : key === 'tilt' ? 90 : 360} precision={1} onCommit={(value) => patch({ [key]: value })} />
    </Field></FieldRow>)}
  </div>;
}
