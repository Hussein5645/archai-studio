import { useAppState, useDispatch } from '@/app/context';
import { AssetsLibrary } from './AssetsLibrary';
import { LayersTree } from './LayersTree';
import { MaterialsLibrary } from './MaterialsLibrary';
import styles from './LeftPanel.module.css';
import { useI18n } from './i18n';

export function LeftPanel() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const open = useAppState((s) => s.ui.panels.left);
  const tab = useAppState((s) => s.ui.panels.leftTab);
  if (!open) return null;
  return (
    <aside className={`${styles.panel} u-panel`} aria-label={t('Layers')} data-ui-scale data-testid="left-panel">
      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'layers'} className={styles.tab} data-active={tab === 'layers' || undefined} onClick={() => void dispatch('show-layers')}>
          {t('Layers')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'assets'} className={styles.tab} data-active={tab === 'assets' || undefined} onClick={() => void dispatch('show-assets')}>
          {t('Assets')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'materials'} className={styles.tab} data-active={tab === 'materials' || undefined} onClick={() => void dispatch('show-materials')}>
          {t('Materials')}
        </button>
      </div>
      <div className={styles.scroll} role="tabpanel">
        {tab === 'layers' ? <LayersTree /> : tab === 'materials' ? <MaterialsLibrary /> : <AssetsLibrary />}
      </div>
    </aside>
  );
}
