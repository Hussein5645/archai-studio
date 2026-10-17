import { useEffect, useSyncExternalStore } from 'react';
import { projectLoading } from '@/persistence/projectLoading';
import { BRAND_MARK } from './brand';
import { useI18n } from './i18n';
import styles from './ProjectLoadingScreen.module.css';

export function ProjectLoadingScreen() {
  const loading = useSyncExternalStore(projectLoading.subscribe, projectLoading.getSnapshot, projectLoading.getSnapshot);
  const { t } = useI18n();
  useEffect(() => projectLoading.attach(), []);
  if (!loading) return null;
  return (
    <div className={styles.screen} data-testid="project-loading" role="status" aria-live="polite" aria-label={t('Opening project')}>
      <div className={styles.card}>
        <img src={BRAND_MARK} alt="" width={52} height={52} />
        <h1>{t('Opening project')}</h1>
        <p className={styles.name}>{loading.name || t('Untitled Project')}</p>
        <div className={styles.track} role="progressbar" aria-label={t('Loading progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(loading.fraction * 100)}>
          <div style={{ width: `${loading.fraction * 100}%` }} />
        </div>
        <p className={styles.detail}>{t(loading.detail)}</p>
      </div>
    </div>
  );
}
