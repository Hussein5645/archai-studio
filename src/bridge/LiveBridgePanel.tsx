/**
 * The Live Bridge in the top bar (docs/live-bridge-proposal.md): a chip with the connected apps,
 * opening a panel to manage them.
 *
 * - Apps: each linked model with its colour, status (connected, syncing, disconnected, error),
 *   last sync and element count; its link mode (two-way, read-only, paused), what it receives,
 *   who decides each facet of its elements; select its model, sync now, disconnect.
 * - Conflicts: elements changed in ArchAI and in an app at once (facets nobody owns), and
 *   deletions not applied; take theirs or keep ArchAI's. Held mass deletions to confirm.
 * - Activity: what each app changed and how ArchAI handled it.
 */
import { Cable, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import type { BridgeData, BridgeFacet, BridgeMode } from '@/document';
import { BRIDGE_FACETS } from '@/document';
import { boardDoc } from '@/store';
import { isLive, liveBridgeControls, useLiveConnections, type LiveConnection } from '@/live/board';
import { FACET_LABELS, bridgeView, useBridgeColours } from './view';
import styles from './LiveBridgePanel.module.css';

type Tab = 'apps' | 'conflicts' | 'activity';

function ago(time: number | null | undefined, now: number): string {
  if (!time) return 'not synced yet';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(time).toLocaleString();
}

export type LinkStatus = 'Connected' | 'Syncing' | 'Disconnected' | 'Error';

export function linkStatus(connection: LiveConnection | undefined, now: number): LinkStatus {
  if (connection?.error) return 'Error';
  if (connection?.syncing) return 'Syncing';
  return connection && isLive(connection, now) ? 'Connected' : 'Disconnected';
}

export function LiveBridgeChip() {
  const connections = useLiveConnections();
  const bridge = useAppState((s) => boardDoc(s).bridge);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  const live = connections.filter((c) => isLive(c, now));
  const sources = Object.keys(bridge?.sources ?? {});
  if (live.length === 0 && sources.length === 0) return null;
  const apps = [...new Set(live.map((c) => c.app || 'App'))];
  const attention = (bridge?.conflicts.length ?? 0) + (bridge?.held.length ?? 0);
  return (
    <div className={styles.anchor} ref={anchor}>
      <button type="button" className={styles.chip} onClick={() => setOpen((o) => !o)} title="Live Bridge: apps linked to this project" data-testid="live-link-chip">
        <span className={styles.dot} data-live={live.length > 0 || undefined} />
        <Cable size={14} />
        {apps.length ? apps.join(', ') : 'Live Bridge'}
        {attention > 0 && <span className={styles.badge}>{attention}</span>}
      </button>
      {open && <LiveBridgePanel bridge={bridge} connections={connections} now={now} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LiveBridgePanel({ bridge, connections, now, onClose }: { bridge: BridgeData | undefined; connections: LiveConnection[]; now: number; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(() => ((bridge?.conflicts.length ?? 0) + (bridge?.held.length ?? 0) > 0 ? 'conflicts' : 'apps'));
  const colours = useBridgeColours();
  const conflicts = (bridge?.conflicts.length ?? 0) + (bridge?.held.length ?? 0);
  return (
    <div className={styles.panel} role="dialog" aria-label="Live Bridge" data-testid="live-bridge-panel">
      <header className={styles.header}>
        <h4>Live Bridge</h4>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <p className={styles.lead}>Apps linked to this project send their model as you edit and receive what the others share.</p>
      <div className={styles.tabs} role="tablist">
        {(['apps', 'conflicts', 'activity'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} data-active={tab === t || undefined} onClick={() => setTab(t)}>
            {t === 'apps' ? 'Apps' : t === 'conflicts' ? `Conflicts${conflicts ? ` (${conflicts})` : ''}` : 'Activity'}
          </button>
        ))}
      </div>
      <div className={styles.body}>
        {tab === 'apps' && <Apps bridge={bridge} connections={connections} now={now} />}
        {tab === 'conflicts' && <Conflicts bridge={bridge} />}
        {tab === 'activity' && <Activity bridge={bridge} now={now} />}
      </div>
      <label className={styles.footer}>
        <input type="checkbox" checked={colours} onChange={(e) => bridgeView.setShowColours(e.target.checked)} />
        Show each app's elements in its colour on the board
      </label>
    </div>
  );
}

function Apps({ bridge, connections, now }: { bridge: BridgeData | undefined; connections: LiveConnection[]; now: number }) {
  const dispatch = useDispatch();
  const byKey = new Map(connections.map((c) => [c.key, c]));
  const keys = [...new Set([...Object.keys(bridge?.sources ?? {}), ...connections.filter((c) => isLive(c, now)).map((c) => c.key)])];
  if (keys.length === 0) return <p className={styles.empty}>No app is linked yet. Turn on Live Bridge in an app's ArchAI plugin.</p>;
  const counts = new Map<string, number>();
  for (const binding of Object.values(bridge?.elements ?? {})) {
    if (binding.removed) continue;
    for (const [key, ref] of Object.entries(binding.refs)) if (ref.role === 'origin') counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    <>
      {keys.map((key) => {
        const source = bridge?.sources[key];
        const connection = byKey.get(key);
        const status = linkStatus(connection, now);
        const app = source?.app || connection?.app || 'App';
        const others = keys.filter((other) => other !== key);
        const ownerOptions = [
          { value: 'origin', label: app },
          { value: 'archai', label: 'ArchAI' },
          { value: 'shared', label: 'Shared (ask on conflict)' },
          ...others.map((other) => ({ value: other, label: bridge?.sources[other]?.app || byKey.get(other)?.app || other })),
        ];
        const setSource = (patch: Record<string, unknown>) => void dispatch('bridge-set-source', { key, ...patch });
        return (
          <section key={key} className={styles.app} data-testid="live-bridge-app">
            <div className={styles.appHead}>
              <span className={styles.swatch} style={{ background: source?.color ?? '#9aa0aa' }} />
              <strong>{app}</strong>
              <span className={styles.model} title={source?.name || connection?.name}>{source?.name || connection?.name || 'Model'}</span>
              <span className={styles.status} data-status={status}>{status}</span>
            </div>
            <small className={styles.meta}>
              {counts.get(key) ?? 0} elements · {ago(connection?.lastSync ?? source?.lastSync, now)}
              {source?.unsupported.length ? ` · ${source.unsupported.length} not supported` : ''}
              {connection?.protocol === 1 ? ' · older plugin (update it for element-level sync)' : ''}
            </small>
            {connection?.error && <small className={styles.error}>{connection.error}</small>}
            {source && (
              <>
                <div className={styles.grid}>
                  <label>
                    Link
                    <select value={source.mode} onChange={(e) => setSource({ mode: e.target.value as BridgeMode })}>
                      <option value="two-way">Two-way</option>
                      <option value="read-only">Only receives</option>
                      <option value="paused">Paused</option>
                    </select>
                  </label>
                  <label>
                    Receives
                    <select value={source.receives} onChange={(e) => setSource({ receives: e.target.value })}>
                      <option value="shared">Shared elements</option>
                      <option value="nothing">Nothing</option>
                    </select>
                  </label>
                </div>
                <details className={styles.authority}>
                  <summary>Who decides its elements' parts</summary>
                  <div className={styles.grid}>
                    {BRIDGE_FACETS.map((facet: BridgeFacet) => (
                      <label key={facet}>
                        {FACET_LABELS[facet]}
                        <select value={source.authority[facet] ?? 'origin'} onChange={(e) => setSource({ authority: { [facet]: e.target.value } })}>
                          {ownerOptions.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </details>
              </>
            )}
            <div className={styles.actions}>
              {source?.groupId && <button type="button" onClick={() => void dispatch('select', { ids: [source.groupId!] })}>Select model</button>}
              {source && <button type="button" onClick={() => setSource({ mode: source.mode === 'paused' ? 'two-way' : 'paused' })}>{source.mode === 'paused' ? 'Resume' : 'Pause'}</button>}
              {liveBridgeControls.available() && <button type="button" onClick={() => liveBridgeControls.resync(key)}>Sync now</button>}
              {liveBridgeControls.available() && source && (
                <button type="button" className={styles.danger} onClick={() => liveBridgeControls.disconnect(key)} title="Its elements stay in ArchAI as ArchAI elements">
                  Disconnect
                </button>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

function Conflicts({ bridge }: { bridge: BridgeData | undefined }) {
  const dispatch = useDispatch();
  const elements = useAppState((s) => boardDoc(s).elements);
  const conflicts = bridge?.conflicts ?? [];
  const held = bridge?.held ?? [];
  if (conflicts.length === 0 && held.length === 0) return <p className={styles.empty}>No conflicts. When ArchAI and an app change the same part of an element and nobody owns it, it shows up here.</p>;
  const appOf = (key: string) => bridge?.sources[key]?.app || 'The app';
  return (
    <>
      {held.map((h) => (
        <section key={h.id} className={styles.conflict}>
          <strong>{appOf(h.source)} would delete {h.elements.length} elements</strong>
          <small>Held because it is a large share of its model. If the app only sent part of its model, keep them.</small>
          <div className={styles.actions}>
            <button type="button" onClick={() => void dispatch('select', { ids: h.elements.filter((id) => elements[id]) })}>Select</button>
            <button type="button" className={styles.danger} onClick={() => void dispatch('bridge-held', { id: h.id, apply: true })}>Delete them</button>
            <button type="button" onClick={() => void dispatch('bridge-held', { id: h.id, apply: false })}>Keep them</button>
          </div>
        </section>
      ))}
      {conflicts.map((c) => {
        const element = elements[c.element];
        const what = c.facet === 'delete' ? 'deleted it' : `changed its ${FACET_LABELS[c.facet].toLowerCase()}`;
        return (
          <section key={c.id} className={styles.conflict}>
            <strong>{element?.name || 'Element'}</strong>
            <small>
              {appOf(c.source)} {what}, and it was changed in ArchAI too.
            </small>
            <div className={styles.actions}>
              {element && <button type="button" onClick={() => void dispatch('select', { ids: [c.element] })}>Select</button>}
              <button type="button" onClick={() => void dispatch('bridge-resolve', { conflict: c.id, take: 'theirs' })}>{c.facet === 'delete' ? 'Delete it' : `Take ${appOf(c.source)}'s`}</button>
              <button type="button" onClick={() => void dispatch('bridge-resolve', { conflict: c.id, take: 'mine' })}>Keep ArchAI's</button>
            </div>
          </section>
        );
      })}
    </>
  );
}

function Activity({ bridge, now }: { bridge: BridgeData | undefined; now: number }) {
  const log = [...(bridge?.log ?? [])].reverse();
  if (log.length === 0) return <p className={styles.empty}>Nothing synced yet.</p>;
  return (
    <ol className={styles.log}>
      {log.map((entry, i) => {
        const source = bridge?.sources[entry.source];
        return (
          <li key={`${entry.at}-${i}`}>
            <span className={styles.swatch} style={{ background: source?.color ?? '#9aa0aa' }} />
            <div>
              <strong>{source?.app || (entry.source === 'archai' ? 'ArchAI' : 'App')}</strong> {entry.text}
              <small>{ago(entry.at, now)}</small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
