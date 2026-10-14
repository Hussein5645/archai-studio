/**
 * The Live Bridge section of the inspector: for the selected elements, where they come from and
 * how they sync: source app, status and last change, sharing, who decides each part, which apps
 * may edit them as copies, and Convert to ArchAI element.
 */
import { useAppState, useDispatch } from '@/app/context';
import { BRIDGE_FACETS, descendantsOf, type BridgeFacet, type BridgeShare } from '@/document';
import { boardDoc } from '@/store';
import { editableElsewhere, ownerOf, originOf } from './engine';
import { FACET_LABELS } from './view';
import styles from './LiveBridgePanel.module.css';

const SHARES: { value: BridgeShare; label: string }[] = [
  { value: 'shared', label: 'All linked apps' },
  { value: 'source-only', label: 'Only the app it came from' },
  { value: 'archai-only', label: 'ArchAI only' },
];

export function BridgeInspector({ ids: selectedIds }: { ids: string[] }) {
  const dispatch = useDispatch();
  const bridge = useAppState((s) => boardDoc(s).bridge);
  const elements = useAppState((s) => boardDoc(s).elements);
  if (!bridge || Object.keys(bridge.sources).length === 0) return null;
  const sourceGroups = new Set(Object.values(bridge.sources).map((source) => source.groupId));
  const ids = [...new Set(selectedIds.flatMap((id) => sourceGroups.has(id)
    ? descendantsOf(elements, id).filter((child) => bridge.elements[child.id]).map((child) => child.id)
    : [id]))];
  if (!ids.length) return null;
  const bindings = ids.map((id) => bridge.elements[id]);
  const single = ids.length === 1 ? bindings[0] : undefined;
  const origins = new Set(bindings.flatMap((b) => Object.entries(b?.refs ?? {}).filter(([, r]) => r.role === 'origin').map(([k]) => k)));
  const share = new Set(bindings.map((b) => b?.share ?? 'shared'));
  const sources = Object.entries(bridge.sources);
  const appOf = (key: string) =>
    key === 'archai' ? 'ArchAI' : key === 'shared' ? 'Shared' : bridge.sources[key]?.app || key;
  const synced = bindings.some((b) => b && Object.keys(b.refs).length > 0);
  return (
    <div className={styles.inspector} data-testid="bridge-inspector">
      <h5>Live Bridge</h5>
      {origins.size > 0 ? (
        <p>
          From{' '}
          {[...origins].map((key) => (
            <span key={key} className={styles.from}>
              <span className={styles.swatch} style={{ background: bridge.sources[key]?.color }} />
              {bridge.sources[key]?.app} ({bridge.sources[key]?.name})
            </span>
          ))}
        </p>
      ) : (
        <p>{single?.history?.length ? `Converted from ${single.history.map((h) => h.app || 'an app').join(', ')}` : 'Made in ArchAI'}</p>
      )}
      {single && Object.entries(single.refs).map(([key, ref]) => (
        <small key={key} className={styles.meta}>
          {appOf(key)}: {ref.role === 'copy' ? 'editable copy' : 'original'} ({ref.fidelity}{ref.lossy ? ', simplified' : ''}) · last change {new Date(ref.at).toLocaleString()}
        </small>
      ))}
      {single && bridge.conflicts.some((c) => c.element === ids[0]) && (
        <small className={styles.error}>Has a conflict: see Live Bridge in the top bar.</small>
      )}
      <label className={styles.row}>
        Goes to
        <select value={share.size === 1 ? [...share][0] : ''} onChange={(e) => void dispatch('bridge-set-share', { ids, share: e.target.value })}>
          {share.size > 1 && (
            <option value="" disabled>
              Mixed
            </option>
          )}
          {SHARES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </label>
      {synced && (
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => void dispatch('bridge-set-control', { ids, control: 'source' })}
            title="The source app controls geometry, placement, materials and names"
          >
            Source controls all
          </button>
          <button
            type="button"
            onClick={() => void dispatch('bridge-set-control', { ids, control: 'placement' })}
            title="Keep geometry and materials in the source app; move and rename the selection in ArchAI"
          >
            Place in ArchAI
          </button>
          <button
            type="button"
            onClick={() => void dispatch('bridge-set-control', { ids, control: 'shared' })}
            title="Concurrent edits to the same part require a conflict decision"
          >
            Shared control
          </button>
        </div>
      )}
      {synced && (
        <details className={styles.authority}>
          <summary>
            Control each part of{' '}
            {ids.length > 1 ? `${ids.length} selected elements` : 'this element'}
          </summary>
          <div className={styles.grid}>
            {BRIDGE_FACETS.map((facet: BridgeFacet) => {
              const owners = new Set(
                bindings.map((binding) => {
                  if (!binding) return 'archai';
                  const owner = ownerOf(bridge, binding, facet);
                  return owner === originOf(binding) ? 'origin' : owner;
                }),
              );
              return (
              <label key={facet}>
                {FACET_LABELS[facet]}
                <select value={owners.size === 1 ? [...owners][0] : 'mixed'} onChange={(e) => void dispatch('bridge-set-owner', { ids, facet, owner: e.target.value || null })}>
                    {owners.size > 1 && (
                      <option value="mixed" disabled>
                        Mixed
                      </option>
                    )}
                    <option value="">Use source defaults</option>
                  <option value="origin">The app it came from</option>
                  <option value="archai">ArchAI</option>
                  <option value="shared">Shared (ask on conflict)</option>
                </select>
              </label>
            );
            })}
          </div>
        </details>
      )}
      <details className={styles.authority}>
        <summary>Editable in other apps</summary>
        {bindings.some((b) => !editableElsewhere(b)) && (
          <small className={styles.meta}>
            Geometry from an app is edited only in that app. Convert it into an ArchAI element to
            let other apps edit it.
          </small>
        )}
        {bindings.every((b) => editableElsewhere(b)) && sources
          .filter(([key]) => !origins.has(key))
          .map(([key, source]) => {
            const offered = bindings.every((b) => (b?.offers?.[key]?.length ?? 0) > 0);
            return (
              <label key={key} className={styles.check}>
                <input type="checkbox" checked={offered} onChange={(e) => void dispatch('bridge-offer', { ids, key, facets: e.target.checked ? ['geometry', 'transform', 'material', 'metadata'] : [] })} />
                {source.app} ({source.name}) gets an editable copy
                </label>
            );
          })}
      </details>
      {synced && (
        <div className={styles.actions}>
          <button type="button" onClick={() => void dispatch('bridge-convert', { ids })} title="No longer updated by the app; where it came from is kept">
            Convert to ArchAI element
          </button>
        </div>
      )}
    </div>
  );
}
