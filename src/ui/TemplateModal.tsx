import { Download, FileCode, LayoutTemplate, Sparkles, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import {
  createTemplateFromDocument,
  downloadTemplateFile,
  getLocalTemplates,
  parseTemplateFile,
  saveLocalTemplate,
  type ArchaiTemplate,
} from '@/persistence/templates';
import { useI18n } from './i18n';
import { TextButton } from './primitives';
import styles from './TemplateModal.module.css';

export function SaveTemplateModal() {
  const { t } = useI18n();
  const { platform, toasts } = useApp();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const open = useAppState((s) => s.ui.templateSavePrompt);

  const [name, setName] = useState(doc.meta.name || 'Custom Template');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const close = () => void dispatch('set-template-save-prompt', { open: false });

  const handleSaveLocal = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const template = createTemplateFromDocument(doc, name, description);
      await saveLocalTemplate(platform, template);
      toasts.push({ kind: 'success', message: t(`Template "${template.name}" saved locally`) });
      close();
    } catch (err) {
      toasts.push({ kind: 'error', message: err instanceof Error ? err.message : t('Failed to save template') });
    } finally {
      setSaving(false);
    }
  };

  const handleExportAit = () => {
    if (!name.trim()) return;
    try {
      const template = createTemplateFromDocument(doc, name, description);
      downloadTemplateFile(template);
      toasts.push({ kind: 'success', message: t(`Exported "${template.name}" as .AIT file`) });
      close();
    } catch (err) {
      toasts.push({ kind: 'error', message: err instanceof Error ? err.message : t('Failed to export template') });
    }
  };

  return (
    <div className={styles.backdrop} data-ui-scale onClick={(e) => e.target === e.currentTarget && close()}>
      <div className={styles.dialog} role="dialog" aria-modal="true">
        <header className={styles.header}>
          <h2 className={styles.title}>
            <LayoutTemplate size={18} />
            {t('Save as Template')}
          </h2>
          <button type="button" className={styles.close} onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {t('Templates store graphic presets, element styles, and CAI definitions without board elements or layers.')}
          </p>

          <label className={styles.label}>
            <span>{t('Template Name')}</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('e.g. Modern Architecture Preset')}
              autoFocus
            />
          </label>

          <label className={styles.label}>
            <span>{t('Description (Optional)')}</span>
            <textarea
              className={styles.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('Describe graphics overrides or symbol definitions included...')}
            />
          </label>
        </div>

        <footer className={styles.footer}>
          <TextButton type="button" onClick={close} disabled={saving}>
            {t('Cancel')}
          </TextButton>
          <TextButton type="button" onClick={handleExportAit} disabled={saving || !name.trim()}>
            <Download size={13} /> {t('Export .AIT File')}
          </TextButton>
          <TextButton primary type="button" onClick={() => void handleSaveLocal()} disabled={saving || !name.trim()}>
            <Sparkles size={13} /> {t('Save to Local Browser')}
          </TextButton>
        </footer>
      </div>
    </div>
  );
}

export function CreateProjectModal() {
  const { t } = useI18n();
  const { platform, toasts } = useApp();
  const dispatch = useDispatch();
  const open = useAppState((s) => s.ui.templateCreatePrompt);

  const [name, setName] = useState('New Project');
  const [localTemplates, setLocalTemplates] = useState<ArchaiTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<ArchaiTemplate | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      void getLocalTemplates(platform).then(setLocalTemplates);
    }
  }, [open, platform]);

  if (!open) return null;

  const close = () => void dispatch('set-template-create-prompt', { open: false });

  const handleCreate = () => {
    void dispatch('create-project-from-template', {
      name: name.trim() || 'New Project',
      template: selectedTemplate,
    });
    close();
  };

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (!content) return;
      const res = parseTemplateFile(content);
      if (res.ok) {
        setSelectedTemplate(res.template);
        toasts.push({ kind: 'success', message: t(`Loaded template "${res.template.name}"`) });
      } else {
        toasts.push({ kind: 'error', message: res.error });
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className={styles.backdrop} data-ui-scale onClick={(e) => e.target === e.currentTarget && close()}>
      <div className={styles.dialog} role="dialog" aria-modal="true" data-testid="create-project-modal">
        <header className={styles.header}>
          <h2 className={styles.title}>
            <Sparkles size={18} />
            {t('Create New Project')}
          </h2>
          <button type="button" className={styles.close} onClick={close} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          <label className={styles.label}>
            <span>{t('Project Name')}</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('e.g. Ground Floor Architecture')}
              autoFocus
            />
          </label>

          <div className={styles.label}>
            <span>{t('Choose Template Preset')}</span>

            <div className={styles.templateGrid}>
              <div
                className={`${styles.templateCard} ${selectedTemplate === null ? styles.templateCardSelected : ''}`}
                onClick={() => setSelectedTemplate(null)}
              >
                <div className={styles.templateIcon}>
                  <FileCode size={18} />
                </div>
                <div className={styles.templateName}>{t('Default Empty')}</div>
                <div className={styles.templateDesc}>{t('Blank project canvas')}</div>
              </div>

              {localTemplates.map((template) => (
                <div
                  key={template.id}
                  className={`${styles.templateCard} ${selectedTemplate?.id === template.id ? styles.templateCardSelected : ''}`}
                  onClick={() => setSelectedTemplate(template)}
                >
                  <div className={styles.templateIcon}>
                    <LayoutTemplate size={18} />
                  </div>
                  <div className={styles.templateName}>{template.name}</div>
                  <div className={styles.templateDesc}>
                    {template.description || t(`${Object.keys(template.definitions).length} CAI assets`)}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 10 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".ait,.json"
                className={styles.fileInput}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileUpload(file);
                }}
              />
              <TextButton type="button" onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} /> {t('Load Template from .AIT File')}
              </TextButton>
              {selectedTemplate && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)', marginLeft: 10 }}>
                  {t('Selected')}: <strong>{selectedTemplate.name}</strong>
                </span>
              )}
            </div>
          </div>
        </div>

        <footer className={styles.footer}>
          <TextButton type="button" onClick={close}>
            {t('Cancel')}
          </TextButton>
          <TextButton primary type="button" onClick={handleCreate} data-testid="create-project-submit">
            {t('Create Project')}
          </TextButton>
        </footer>
      </div>
    </div>
  );
}
