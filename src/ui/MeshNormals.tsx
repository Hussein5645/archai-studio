import { useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import { meshOf, meshStore } from '@/view3d/meshes';
import { inspectNormals } from '@/view3d/meshNormals';
import { addLog } from '@/diagnostics';
import { descendantsOf } from '@/document';
import { Divider, Field, SelectField, TextButton } from './primitives';
import styles from './Inspector.module.css';

export function MeshNormals({ id }: { id: string }) {
  const doc = useAppState((s) => s.doc);
  const dispatch = useDispatch();
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      await meshStore.prepare(doc);
      const model = meshStore.models.get(meshOf(doc.elements[id])!.blobId);
      const text = model ? inspectNormals(model) : 'Model could not be loaded';
      setReport(text); addLog('info', `Normals: ${doc.elements[id]?.name ?? id}: ${text}`);
    } catch { setReport('Could not inspect this model'); }
    finally { setBusy(false); }
  };
  return <>
    <TextButton onClick={() => void check()} disabled={busy}>{busy ? 'Checking…' : 'Check source normals'}</TextButton>
    {report && <p role="status" style={{ fontSize: 12 }}>{report}</p>}
    <Field label="Normals">
      <SelectField value={String(doc.elements[id]?.meta?.['normalMode'] ?? 'source')} ariaLabel="Model normals"
        options={[{ value: 'source', label: 'Original' }, { value: 'auto', label: 'Auto orient faces + recalculate' }, { value: 'recompute', label: 'Recalculate shading normals' }, { value: 'flip', label: 'Flip all faces' }, { value: 'recompute-flip', label: 'Flip faces + recalculate' }]}
        onChange={(mode) => void dispatch('set-model-normals', { id, mode })} />
    </Field>
    <p style={{ fontSize: 12 }}>Auto repair makes connected faces consistent and closed shells face outward. Open surfaces keep their majority direction; check their intended side. Ctrl+Z undoes repairs.</p>
  </>;
}

export function GroupMeshNormals({ id }: { id: string }) {
  const doc = useAppState((s) => s.doc);
  const dispatch = useDispatch();
  const [report, setReport] = useState('');
  const models = descendantsOf(doc.elements, id).filter((element) => meshOf(element));
  if (!models.length) return null;
  return <>
    <Divider />
    <div className={styles.section} data-testid="group-mesh-normals">
      <h3 className="u-section-title">Mesh normals · {models.length} models</h3>
      <TextButton onClick={async () => {
        const result = await dispatch('auto-repair-group-normals', { ids: [id] });
        if (result.ok) setReport(`Auto repair applied to ${models.length} models, including nested groups. Ctrl+Z undoes the whole repair.`);
      }}>Auto repair all mesh normals</TextButton>
      {report && <p role="status" style={{ fontSize: 12 }}>{report}</p>}
      <p style={{ fontSize: 12 }}>Repairs ArchAI’s mesh copies, including source-controlled linked models. No source-app access or conversion is needed. Open surfaces keep their majority direction; check their intended side. Unlock pinned group members before repairing.</p>
    </div>
  </>;
}
