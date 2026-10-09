import { ChevronRight, Download, Folder, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useApp, useAppState, useDispatch } from '@/app/context';
import { LibrarySignIn } from './LibrarySignIn';
import { downloadCaiFile } from '@/catalog/builder';
import type { CatalogAsset, CatalogFolder } from '@/catalog/types';
import { TextButton } from './primitives';
import styles from './LeftPanel.module.css';
import { modelingStorage } from '@/modeling/persistence';
import { Pencil } from 'lucide-react';

type CatalogState = { status: 'loading' } | { status: 'ready'; root: CatalogFolder } | { status: 'error'; message: string };

type SourceFilter = 'all' | 'online' | 'local';

function findFolder(root: CatalogFolder, path: string): CatalogFolder | null {
  if (path === '') return root;
  let current = root;
  for (const segment of path.split('/')) {
    const next = current.folders.find((f) => f.path === (current.path ? `${current.path}/${segment}` : segment));
    if (!next) return null;
    current = next;
  }
  return current;
}

function matchesFilter(asset: CatalogAsset, filter: SourceFilter): boolean {
  if (asset.kind !== 'asset') return false;
  if (filter === 'online') return !asset.isLocal;
  if (filter === 'local') return Boolean(asset.isLocal);
  return true;
}

function countAssets(folder: CatalogFolder, filter: SourceFilter = 'all'): number {
  return folder.assets.filter((asset) => matchesFilter(asset, filter)).length +
    folder.folders.reduce((sum, f) => sum + countAssets(f, filter), 0);
}

function formatSize(width: number, height: number): string {
  const f = (mm: number) => (mm >= 1000 ? `${(mm / 1000).toFixed(mm % 1000 === 0 ? 0 : 1)} m` : `${Math.round(mm)} mm`);
  return `${f(width)} × ${f(height)}`;
}

export function AssetsLibrary() {
  const { catalog, toasts, platform } = useApp();
  const signedIn = useAccount().status === 'signed-in';
  const dispatch = useDispatch();
  const projectId = useAppState((state) => state.ui.screen === 'project' ? state.doc.id : undefined);
  const [result, setResult] = useState<{ attempt: number; state: CatalogState } | null>(null);
  const [path, setPath] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [attempt, setAttempt] = useState(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [editableIds, setEditableIds] = useState<Set<string>>(new Set());
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // A result from an older attempt counts as "loading" for the current one.
  const state: CatalogState = result && result.attempt === attempt ? result.state : { status: 'loading' };

  useEffect(() => {
    let cancelled = false;
    catalog
      .load()
      .then((root) => !cancelled && setResult({ attempt, state: { status: 'ready', root } }))
      .catch(
        (error: unknown) =>
          !cancelled && setResult({ attempt, state: { status: 'error', message: error instanceof Error ? error.message : String(error) } }),
      );
    return () => {
      cancelled = true;
    };
  }, [catalog, attempt]);

  useEffect(() => {
    let active = true;
    void modelingStorage.list().then((assets) => {
      if (active) setEditableIds(new Set(assets.map((asset) => asset.id)));
    });
    return () => { active = false; };
  }, [attempt]);

  // Subscribe to catalog updates
  useEffect(() => {
    if (!catalog.subscribe) return;
    return catalog.subscribe(() => {
      setAttempt((n) => n + 1);
    });
  }, [catalog]);

  const placeAsset = (asset: CatalogAsset) => {
    void dispatch('begin-catalog-placement', { asset });
  };

  const handleCaiFileUpload = async (files: FileList | File[]) => {
    if (!catalog.addLocalPackage) return;
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith('.cai') && !file.type.includes('zip')) continue;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const asset = await catalog.addLocalPackage(bytes);
        toasts.push({ kind: 'success', message: `Imported package "${asset.name}"` });
      } catch (err) {
        toasts.push({ kind: 'error', message: `Failed to import ${file.name}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  };

  const handleExportCai = async (e: React.MouseEvent, asset: CatalogAsset) => {
    e.stopPropagation();
    try {
      if (catalog.exportPackageBytes) {
        const bytes = await catalog.exportPackageBytes(asset);
        if (bytes) {
          downloadCaiFile(bytes, `${asset.id}.cai`);
          toasts.push({ kind: 'success', message: `Exported ${asset.name} as .cai` });
          return;
        }
      }
      toasts.push({ kind: 'error', message: 'Package file not available for download' });
    } catch (err) {
      toasts.push({ kind: 'error', message: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const handleDeleteLocal = async (e: React.MouseEvent, asset: CatalogAsset) => {
    e.stopPropagation();
    if (!catalog.deleteLocalPackage) return;
    try {
      await catalog.deleteLocalPackage(asset.id);
      toasts.push({ kind: 'info', message: `Removed "${asset.name}" from local library` });
    } catch (err) {
      toasts.push({ kind: 'error', message: `Delete failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const folder = state.status === 'ready' ? findFolder(state.root, path) : null;
  const crumbs = useMemo(() => {
    const parts = path ? path.split('/') : [];
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  }, [path]);

  const visibleAssets = folder ? folder.assets.filter((a) => matchesFilter(a, sourceFilter)) : [];

  return (
    <div
      className={isDraggingOver ? styles.dropTargetActive : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setIsDraggingOver(true);
        }
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={(e) => {
        setIsDraggingOver(false);
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          void handleCaiFileUpload(e.dataTransfer.files);
        }
      }}
    >
      <input
        ref={uploadInputRef}
        type="file"
        accept=".cai,application/zip,application/x-zip-compressed"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => e.target.files && void handleCaiFileUpload(e.target.files)}
      />

      <div className={styles.libraryHeaderRow}>
        <h3 className="u-section-title" style={{ margin: 0 }}>
          Library
        </h3>
        <div className={styles.libraryActions}>
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
            onClick={() => void dispatch('open-modeling')}
            title="Model a new .CAI asset"
            data-testid="create-cai-btn"
          >
            <Plus size={12} />
            Create
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => uploadInputRef.current?.click()}
            title="Upload/Import .CAI package files"
            data-testid="upload-cai-btn"
          >
            <Upload size={12} />
            Upload
          </button>
        </div>
      </div>

      {/* Source Navigation Tabs: All / Online / Local */}
      <div className={styles.sourceNav} role="tablist" aria-label="Asset source">
        <button
          type="button"
          role="tab"
          aria-selected={sourceFilter === 'all'}
          className={styles.sourceTab}
          data-active={sourceFilter === 'all' || undefined}
          onClick={() => setSourceFilter('all')}
          data-testid="filter-all"
        >
          <span>All</span>
          <span className={styles.sourceBadge}>{state.status === 'ready' ? countAssets(state.root, 'all') : 0}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceFilter === 'online'}
          className={styles.sourceTab}
          data-active={sourceFilter === 'online' || undefined}
          onClick={() => setSourceFilter('online')}
          data-testid="filter-online"
        >
          <span>Online</span>
          <span className={styles.sourceBadge}>{state.status === 'ready' ? countAssets(state.root, 'online') : 0}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sourceFilter === 'local'}
          className={styles.sourceTab}
          data-active={sourceFilter === 'local' || undefined}
          onClick={() => setSourceFilter('local')}
          data-testid="filter-local"
        >
          <span>Local</span>
          <span className={styles.sourceBadge}>{state.status === 'ready' ? countAssets(state.root, 'local') : 0}</span>
        </button>
      </div>

      {!signedIn && <LibrarySignIn className={styles.notice} what="asset" />}
      {state.status === 'loading' && <div className={styles.notice}>Loading catalog…</div>}
      {state.status === 'error' && (
        <div className={styles.notice}>
          The remote asset library is unconfigured or offline.
          <br />
          <span className="u-faint">{state.message}</span>
          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <TextButton onClick={() => void dispatch('open-modeling')}>Create .CAI</TextButton>
            <TextButton onClick={() => uploadInputRef.current?.click()}>Upload .CAI</TextButton>
          </div>
        </div>
      )}
      {state.status === 'ready' && folder && (
        <>
          {state.root.warnings && state.root.warnings.length > 0 && (
            <div className={styles.warning} title={state.root.warnings.join('\n')}>
              {state.root.warnings.length} notice(s): {state.root.warnings[0]}
            </div>
          )}
          <nav className={styles.crumbs} aria-label="Catalog path">
            <button type="button" className={path ? styles.crumb : styles.crumbCurrent} onClick={() => setPath('')}>
              {sourceFilter === 'all' ? 'All' : sourceFilter === 'online' ? 'Online' : 'Local'}
            </button>
            {crumbs.map((c, i) => (
              <span key={c.path} style={{ display: 'contents' }}>
                <ChevronRight size={12} />
                {i === crumbs.length - 1 ? (
                  <span className={styles.crumbCurrent}>{titleCase(c.name)}</span>
                ) : (
                  <button type="button" className={styles.crumb} onClick={() => setPath(c.path)}>
                    {titleCase(c.name)}
                  </button>
                )}
              </span>
            ))}
          </nav>

          {folder.folders.map((sub) => {
            const count = countAssets(sub, sourceFilter);
            return (
              <button key={sub.path} type="button" className={styles.folder} onClick={() => setPath(sub.path)} data-testid={`catalog-folder-${sub.path}`}>
                <Folder size={14} className="u-muted" />
                <span className="u-truncate">{sub.name}</span>
                <span className={styles.folderCount}>{count}</span>
              </button>
            );
          })}

          {visibleAssets.length > 0 && (
            <div className={styles.grid}>
              {visibleAssets.map((asset) => (
                <div
                  key={asset.id}
                  className={styles.assetCard}
                  draggable
                  title={`${asset.name} — click for placement preview, or drag onto the board`}
                  onClick={() => placeAsset(asset)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-archai-asset', JSON.stringify(asset));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  data-testid={`catalog-asset-${asset.id}`}
                >
                  {asset.isLocal && <span className={styles.localBadge}>Local</span>}
                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={styles.cardActionBtn}
                      title="Download .CAI file"
                      onClick={(e) => void handleExportCai(e, asset)}
                    >
                      <Download size={12} />
                    </button>
                    {asset.isLocal && (
                      <button
                        type="button"
                        className={styles.cardActionBtn}
                        title={editableIds.has(asset.packageId ?? asset.id) ? 'Edit linked .CAI model' : 'Open the packaged model for editing'}
                        onClick={async (event) => {
                          event.stopPropagation();
                          const editableId = asset.packageId ?? asset.id;
                          if (!editableIds.has(editableId)) {
                            const bytes = await catalog.exportPackageBytes?.(asset);
                            if (!bytes) {
                              toasts.push({ kind: 'error', message: 'The local .CAI package could not be opened for editing' });
                              return;
                            }
                            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
                            await modelingStorage.saveFile(editableId, '__package__', buffer);
                          }
                          platform.window.openModeling({ assetId: editableId, name: asset.name, projectId });
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                    {asset.isLocal && (
                      <button
                        type="button"
                        className={`${styles.cardActionBtn} ${styles.cardActionBtnDanger}`}
                        title="Delete from local library"
                        onClick={(e) => void handleDeleteLocal(e, asset)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <span className={styles.thumb}>
                    <img src={asset.thumbnail?.url ?? asset.image.url} alt="" loading="lazy" draggable={false} />
                  </span>
                  <span className={styles.assetName}>{asset.name}</span>
                  <span className={styles.assetMeta}>{formatSize(asset.size.width, asset.size.height)}</span>
                </div>
              ))}
            </div>
          )}

          {folder.folders.length === 0 && visibleAssets.length === 0 && (
            <div className={styles.empty}>
              {sourceFilter === 'local'
                ? 'No local assets in this folder.'
                : sourceFilter === 'online'
                  ? 'No online assets in this folder.'
                  : 'No general assets in this folder yet.'}
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                  onClick={() => void dispatch('open-modeling')}
                >
                  <Plus size={12} /> Create .CAI Asset
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/*
 * The Assets tab intentionally has no document-local definitions section. Reusable definitions
 * remain part of the document model and Layers tree, but the library surface is strictly R2.
 */

function titleCase(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
