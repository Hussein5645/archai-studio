import { Box, Cloud, CloudUpload, Download, FileCode, FolderOpen, Glasses, HardDrive, Layers, LayoutTemplate, Link2, LogIn, Plus, RotateCcw, Star, Trash2, Upload, Users } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAccount, useApp, useCloudProjects, useDispatch } from '@/app/context';
import type { CloudProject } from '@/cloud/projects';
import { openAccountDialog } from './account-dialog';
import { AccountButton } from './AccountButton';
import { openJoinDialog } from './JoinDialog';
import { openShareDialog } from './ShareDialog';
import { modelingStorage, type SavedAsset } from '@/modeling/persistence';
import {
  deleteLocalTemplate,
  downloadTemplateFile,
  getLocalTemplates,
  parseTemplateFile,
  saveLocalTemplate,
  type ArchaiTemplate,
} from '@/persistence/templates';
import type { RecentEntry } from '@/persistence/session';
import { useI18n } from './i18n';
import { IconButton, TextButton } from './primitives';
import { CreateProjectModal } from './TemplateModal';
import { useVrDevice } from './vrDevice';
import styles from './HomeScreen.module.css';
import { BRAND_MARK } from './brand';

export function HomeScreen() {
  const { t } = useI18n();
  const { platform, persistence, toasts, cloud } = useApp();
  const dispatch = useDispatch();
  const vr = useVrDevice();
  const accountState = useAccount();
  const signedIn = accountState.status === 'signed-in';
  const online = useCloudProjects();
  const [busyId, setBusyId] = useState<string | null>(null);

  const cloudTask = async (id: string, task: () => Promise<unknown>, done?: string) => {
    setBusyId(id);
    try {
      await task();
      if (done) toasts.push({ kind: 'success', message: t(done) });
    } catch (error) {
      toasts.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  const handlePutOnline = (e: React.MouseEvent, entry: RecentEntry) => {
    e.stopPropagation();
    void cloudTask(entry.id, () => cloud.putOnline(entry.id), 'The project is online: this is now the online copy');
  };

  const handleDeleteOnline = (project: CloudProject) => {
    if (!window.confirm(t(`Delete the online project "${project.name}" for everyone? This cannot be undone.`))) return;
    void cloudTask(project.id, () => cloud.remove(project.id), 'Online project deleted');
  };

  const recent = useSyncExternalStore(
    (listener) => persistence.subscribe(listener),
    () => persistence.recent(),
  );

  const [activeTab, setActiveTab] = useState<'projects' | 'online' | 'templates' | 'cai'>('projects');
  const [localTemplates, setLocalTemplates] = useState<ArchaiTemplate[]>([]);
  const [savedCaiAssets, setSavedCaiAssets] = useState<SavedAsset[]>([]);
  const templateFileInputRef = useRef<HTMLInputElement>(null);

  const refreshTemplates = () => {
    void getLocalTemplates(platform).then(setLocalTemplates);
  };

  const refreshCaiAssets = () => {
    void modelingStorage.list().then(setSavedCaiAssets).catch(() => setSavedCaiAssets([]));
  };

  useEffect(() => {
    refreshTemplates();
    refreshCaiAssets();
  }, [platform]);

  const handleOpenRecent = async (entry: RecentEntry) => {
    if (entry.cloud && signedIn) {
      await cloud.open(entry.id);
      return;
    }
    const ok = await persistence.openStored(entry.id);
    if (!ok) {
      toasts.push({ kind: 'error', message: t(`Could not open project "${entry.name}"`) });
    }
  };

  const handleForgetRecent = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (!window.confirm(t(`Remove project "${name || 'Untitled Project'}" from local history?`))) return;
    await persistence.forget(id);
    toasts.push({ kind: 'info', message: t('Project removed from local history') });
  };

  const handleResetExample = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    if (!window.confirm(t(`Reset "${name}" to its original version? Any edits you made will be lost.`))) return;
    await persistence.resetExampleProject();
    toasts.push({ kind: 'info', message: t(`"${name}" was reset to its original version`) });
  };

  const handleDeleteTemplate = async (e: React.MouseEvent, template: ArchaiTemplate) => {
    e.stopPropagation();
    if (!window.confirm(t(`Permanently delete template "${template.name}"? This cannot be undone.`))) return;
    await deleteLocalTemplate(platform, template.id);
    toasts.push({ kind: 'info', message: t(`Deleted template "${template.name}"`) });
    refreshTemplates();
  };

  const handleDeleteCaiAsset = async (e: React.MouseEvent, assetId: string, name: string) => {
    e.stopPropagation();
    if (!window.confirm(t(`Permanently delete CAI asset "${name || 'Untitled Asset'}"? This cannot be undone.`))) return;
    await modelingStorage.delete(assetId);
    toasts.push({ kind: 'info', message: t(`Deleted CAI asset "${name}"`) });
    refreshCaiAssets();
  };

  const openCaiAsset = (item: SavedAsset) => {
    platform.window.openModeling({ assetId: item.id, name: item.metadata.name, ...(item.project ? { projectId: item.project.id } : {}) });
  };

  const linkedCaiGroups = Array.from(
    savedCaiAssets.reduce((groups, item) => {
      if (!item.project) return groups;
      const currentProject = { ...item.project, name: recent.find((entry) => entry.id === item.project!.id)?.name ?? item.project.name };
      const group = groups.get(item.project.id) ?? { project: currentProject, assets: [] as SavedAsset[] };
      group.project = currentProject;
      group.assets.push(item);
      groups.set(item.project.id, group);
      return groups;
    }, new Map<string, { project: { id: string; name: string }; assets: SavedAsset[] }>()).values(),
  );
  const freeCaiAssets = savedCaiAssets.filter((item) => !item.project);

  const caiCard = (item: SavedAsset) => (
    <div
      key={item.id}
      className={styles.card}
      onClick={() => openCaiAsset(item)}
      data-testid={`cai-card-${item.id}`}
    >
      <div className={styles.cardTop}>
        <div className={styles.cardIcon}>
          <Box size={20} />
        </div>
        <div className={styles.cardMeta}>
          <h3 className={styles.cardName}>{item.metadata.name || t('Untitled Asset')}</h3>
          <span className={styles.cardTime}>
            {t('Saved')} {new Date(item.savedAt).toLocaleDateString()}
          </span>
          <span className={styles.cardTag}>
            <Layers size={10} /> {item.metadata.category || 'Architecture'}
          </span>
        </div>
      </div>

      <div className={styles.cardActions}>
        <TextButton primary type="button" onClick={() => openCaiAsset(item)}>
          {t('Open in Modeler')}
        </TextButton>

        <IconButton label={t('Delete asset')} onClick={(e) => void handleDeleteCaiAsset(e, item.id, item.metadata.name)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
    </div>
  );

  const handleImportAitFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result as string;
      if (!content) return;
      const parsed = parseTemplateFile(content);
      if (parsed.ok) {
        await saveLocalTemplate(platform, parsed.template);
        toasts.push({ kind: 'success', message: t(`Imported template "${parsed.template.name}"`) });
        refreshTemplates();
      } else {
        toasts.push({ kind: 'error', message: parsed.error });
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className={styles.container} data-testid="home-screen" data-ui-scale>
      <header className={styles.topHeader}>
        <div className={styles.brand}>
          <img className={styles.logoMark} src={BRAND_MARK} alt="" aria-hidden="true" />
          <span className={styles.brandName}>ArchAI</span>
        </div>

        <div className={styles.headerRight}>
          {platform.kind === 'web' && (
            <a
              className={styles.topDownloadBtn}
              href="/download.html"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="top-download-btn"
            >
              <Download size={15} aria-hidden="true" />
              {t('Download')}
            </a>
          )}

          <AccountButton />
        </div>
      </header>

      <div className={styles.hero}>
        {vr.headset && (
          <div className={styles.vrNotice} role="status" data-testid="vr-headset-notice">
            <Glasses size={18} aria-hidden="true" />
            <span>
              <strong>{vr.name ?? t('VR headset')} {t('detected')}.</strong> {t('A VR modelling mode is on its way. For now ArchAI works here as on a tablet; walk through a design with VR link in the 3D view.')}
            </span>
          </div>
        )}
        <h1 className={styles.heroTitle}>{t('Architecture Workspace')}</h1>
        <p className={styles.heroSubtitle}>
          {t('Create architectural models, manage element styles, and utilize CAI preset templates.')}
        </p>

        <div className={styles.actionBar}>
          <TextButton
            primary
            onClick={() => void dispatch('set-template-create-prompt', { open: true })}
            data-testid="create-project-btn"
          >
            <Plus size={15} /> {t('New Project')}
          </TextButton>

          <TextButton onClick={() => void dispatch('prompt-open-document')} data-testid="open-project-btn">
            <FolderOpen size={15} /> {t('Open File (.AIR)')}
          </TextButton>

          <TextButton onClick={() => templateFileInputRef.current?.click()} data-testid="import-ait-btn">
            <Upload size={15} /> {t('Import Template (.AIT)')}
          </TextButton>

          <TextButton
            onClick={() => {
              const assetId = `asset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
              platform.window.openModeling({ assetId, name: 'New CAI Asset' });
            }}
            data-testid="create-cai-btn"
          >
            <Box size={15} /> {t('Create CAI')}
          </TextButton>

          <TextButton onClick={() => openJoinDialog()} data-testid="join-link-btn">
            <Link2 size={15} /> {t('Join with a link')}
          </TextButton>

          <input
            ref={templateFileInputRef}
            type="file"
            accept=".ait,.json"
            className={styles.hiddenInput}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportAitFile(file);
            }}
          />
        </div>

        <div className={styles.navTabs}>
          <button
            type="button"
            className={`${styles.tabBtn} ${activeTab === 'projects' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('projects')}
            data-testid="tab-projects"
          >
            {t('Recent Projects')} ({recent.length})
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${activeTab === 'online' ? styles.tabBtnActive : ''}`}
            onClick={() => {
              setActiveTab('online');
              void cloud.refresh();
            }}
            data-testid="tab-online"
          >
            {t('Online Projects')}{signedIn ? ` (${online.projects.length})` : ''}
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${activeTab === 'templates' ? styles.tabBtnActive : ''}`}
            onClick={() => setActiveTab('templates')}
            data-testid="tab-templates"
          >
            {t('Local Templates')} ({localTemplates.length})
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${activeTab === 'cai' ? styles.tabBtnActive : ''}`}
            onClick={() => {
              setActiveTab('cai');
              refreshCaiAssets();
            }}
            data-testid="tab-cai"
          >
            {t('Saved CAI Files')} ({savedCaiAssets.length})
          </button>
        </div>
      </div>

      <main className={styles.mainContent}>
        {activeTab === 'projects' && (
          recent.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyStateIcon}>
                <FileCode size={24} />
              </div>
              <p style={{ margin: 0, fontWeight: 500 }}>{t('No local projects found')}</p>
              <span style={{ fontSize: 'var(--text-xs)' }}>{t('Create a new project or open an existing file to get started.')}</span>
            </div>
          ) : (
            <div className={styles.grid}>
              {recent.map((item) => (
                <div key={item.id} className={styles.card} onClick={() => void handleOpenRecent(item)} data-testid={`project-card-${item.id}`}>
                  <div className={styles.cardTop}>
                    <div className={styles.cardIcon}>
                      <FileCode size={20} />
                    </div>
                    <div className={styles.cardMeta}>
                      <h3 className={styles.cardName}>{item.name || t('Untitled Project')}</h3>
                      <span className={styles.cardTime}>
                        {t('Updated')} {new Date(item.updatedAt).toLocaleDateString()}
                      </span>
                      <span className={styles.cardTag}>
                        {item.builtin ? (
                          <>
                            <Star size={10} /> {t('Built-in Example')}
                          </>
                        ) : item.cloud ? (
                          <>
                            <Cloud size={10} /> {t('Online')}
                          </>
                        ) : (
                          <>
                            <HardDrive size={10} /> {item.filePath ? t('File Linked') : t('Local Browser')}
                          </>
                        )}
                      </span>
                    </div>
                  </div>

                  <div className={styles.cardActions}>
                    <TextButton type="button" onClick={() => void handleOpenRecent(item)}>
                      {t('Open')}
                    </TextButton>

                    {signedIn && !item.cloud && (
                      <IconButton label={t('Put online')} disabled={busyId === item.id} onClick={(e) => handlePutOnline(e, item)} data-testid={`put-online-${item.id}`}>
                        <CloudUpload size={14} />
                      </IconButton>
                    )}

                    {item.builtin ? (
                      <IconButton label={t('Reset to original')} onClick={(e) => void handleResetExample(e, item.name)}>
                        <RotateCcw size={14} />
                      </IconButton>
                    ) : (
                      <IconButton label={t('Delete from history')} onClick={(e) => void handleForgetRecent(e, item.id, item.name)}>
                        <Trash2 size={14} />
                      </IconButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'online' && (
          !signedIn ? (
            <div className={styles.emptyState} data-testid="online-signed-out">
              <div className={styles.emptyStateIcon}>
                <Cloud size={24} />
              </div>
              <p style={{ margin: 0, fontWeight: 500 }}>{t('Sign in to keep projects online')}</p>
              <span style={{ fontSize: 'var(--text-xs)' }}>{t('Online projects open on any device you sign in on. Projects on this device work without an account.')}</span>
              <TextButton primary type="button" onClick={() => openAccountDialog()}>
                <LogIn size={15} /> {t('Sign in')}
              </TextButton>
            </div>
          ) : online.projects.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyStateIcon}>
                <Cloud size={24} />
              </div>
              <p style={{ margin: 0, fontWeight: 500 }}>{online.loading ? t('Loading online projects...') : online.error ? online.error : t('No online projects yet')}</p>
              <span style={{ fontSize: 'var(--text-xs)' }}>{t('Use Put online on a project in Recent Projects, or the account menu inside a project.')}</span>
            </div>
          ) : (
            <div className={styles.grid}>
              {online.projects.map((project) => (
                <div key={project.id} className={styles.card} onClick={() => void cloudTask(project.id, () => cloud.open(project.id))} data-testid={`online-card-${project.id}`}>
                  <div className={styles.cardTop}>
                    <div className={styles.cardIcon}>
                      <Cloud size={20} />
                    </div>
                    <div className={styles.cardMeta}>
                      <h3 className={styles.cardName}>{project.name || t('Untitled Project')}</h3>
                      <span className={styles.cardTime}>
                        {t('Updated')} {new Date(project.updatedAt).toLocaleDateString()}
                      </span>
                      <span className={styles.cardTag}>
                        <Cloud size={10} /> {project.role === 'owner' ? t('Yours') : `${project.owner} · ${project.role === 'viewer' ? t('can view') : t('can edit')}`}
                        {(project.members ?? 1) > 1 ? ` · ${project.members} ${t('people')}` : ''}
                      </span>
                    </div>
                  </div>

                  <div className={styles.cardActions}>
                    <TextButton type="button" disabled={busyId === project.id} onClick={(e) => { e.stopPropagation(); void cloudTask(project.id, () => cloud.open(project.id)); }}>
                      {busyId === project.id ? t('Opening...') : t('Open')}
                    </TextButton>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <IconButton label={t('Share')} onClick={(e) => { e.stopPropagation(); openShareDialog(project.id); }} data-testid={`share-online-${project.id}`}>
                        <Users size={14} />
                      </IconButton>
                      <IconButton
                        label={t('Save a copy on this device')}
                        onClick={(e) => { e.stopPropagation(); void cloudTask(project.id, () => cloud.saveCopyOnDevice(project.id), 'A copy was saved on this device (see Recent Projects)'); }}
                      >
                        <Download size={14} />
                      </IconButton>
                      {project.role === 'owner' && (
                        <IconButton label={t('Delete online project')} onClick={(e) => { e.stopPropagation(); handleDeleteOnline(project); }}>
                          <Trash2 size={14} />
                        </IconButton>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'templates' && (
          localTemplates.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyStateIcon}>
                <LayoutTemplate size={24} />
              </div>
              <p style={{ margin: 0, fontWeight: 500 }}>{t('No local templates saved')}</p>
              <span style={{ fontSize: 'var(--text-xs)' }}>
                {t('You can save templates from inside any project, or import .AIT files.')}
              </span>
            </div>
          ) : (
            <div className={styles.grid}>
              {localTemplates.map((tmpl) => (
                <div key={tmpl.id} className={styles.card} data-testid={`template-card-${tmpl.id}`}>
                  <div className={styles.cardTop}>
                    <div className={styles.cardIcon}>
                      <LayoutTemplate size={20} />
                    </div>
                    <div className={styles.cardMeta}>
                      <h3 className={styles.cardName}>{tmpl.name}</h3>
                      <span className={styles.cardTime}>
                        {t('Saved')} {new Date(tmpl.updatedAt).toLocaleDateString()}
                      </span>
                      <span className={styles.cardTag}>
                        {Object.keys(tmpl.definitions).length} {t('CAI Assets')}
                      </span>
                    </div>
                  </div>

                  <div className={styles.cardActions}>
                    <TextButton
                      primary
                      type="button"
                      onClick={() =>
                        void dispatch('create-project-from-template', {
                          name: `${tmpl.name} Project`,
                          template: tmpl,
                        })
                      }
                    >
                      {t('Use Template')}
                    </TextButton>

                    <div style={{ display: 'flex', gap: 4 }}>
                      <IconButton label={t('Export .AIT')} onClick={() => downloadTemplateFile(tmpl)}>
                        <Download size={14} />
                      </IconButton>
                      <IconButton label={t('Delete template')} onClick={(e) => void handleDeleteTemplate(e, tmpl)}>
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {activeTab === 'cai' && (
          savedCaiAssets.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyStateIcon}>
                <Box size={24} />
              </div>
              <p style={{ margin: 0, fontWeight: 500 }}>{t('No saved CAI assets found')}</p>
              <span style={{ fontSize: 'var(--text-xs)' }}>
                {t('Use the "Create CAI" button to start modeling custom 3D architectural components.')}
              </span>
            </div>
          ) : (
            <div className={styles.caiSections}>
              {linkedCaiGroups.map(({ project, assets }) => (
                <section key={project.id} className={styles.projectAssetGroup} data-testid={`cai-project-group-${project.id}`}>
                  <div className={styles.projectAssetHeader}>
                    <div className={styles.projectAssetIcon}><FileCode size={17} /></div>
                    <div>
                      <h2>{project.name || t('Untitled Project')}</h2>
                      <span>{assets.length} {assets.length === 1 ? t('linked CAI model') : t('linked CAI models')}</span>
                    </div>
                  </div>
                  <div className={styles.grid}>{assets.map(caiCard)}</div>
                </section>
              ))}
              {freeCaiAssets.length > 0 && <div className={styles.grid}>{freeCaiAssets.map(caiCard)}</div>}
            </div>
          )
        )}
      </main>

      <CreateProjectModal />
    </div>
  );
}
