import { useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import { meshOf, meshStore } from '@/view3d/meshes';
import { inspectNormals } from '@/view3d/meshNormals';
import { addLog } from '@/diagnostics';
import { Field, SelectField, TextButton } from './primitives';

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
        options={[{ value: 'source', label: 'Original' }, { value: 'recompute', label: 'Recalculate shading normals' }, { value: 'flip', label: 'Flip all faces' }, { value: 'recompute-flip', label: 'Flip faces + recalculate' }]}
        onChange={(mode) => void dispatch('set-model-normals', { id, mode })} />
    </Field>
    <p style={{ fontSize: 12 }}>Recalculate for broken shading. Flip when the entire model faces inward. Mixed face directions need repair in the source app. Ctrl+Z undoes repairs.</p>
  </>;
}
