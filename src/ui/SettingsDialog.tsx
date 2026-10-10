/**
 * App settings of this device: interface (UI scale, language, touch mode), board navigation
 * (mouse wheel) and pen input (palm rejection). Changes apply at once and are kept in
 * localStorage (see ./preferences, ./i18n, ./touch); nothing here touches the document.
 */
import { Hand, Monitor, PenLine, RotateCcw, Settings, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { preferences, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_PRESETS, usePreferences } from './preferences';
import { Segmented } from './primitives';
import { useTouchMode, type TouchModeSetting } from './touch';
import { useI18n, type Locale } from './i18n';
import styles from './SettingsDialog.module.css';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.rowLabel}>{t(label)}</span>
        {hint && <span className={styles.rowHint}>{t(hint)}</span>}
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {icon}
        {t(title)}
      </h3>
      {children}
    </section>
  );
}

/** The settings themselves: the Settings dialog and the Home screen's Settings tab show them. */
export function SettingsSections() {
  const { t, locale, setLocale } = useI18n();
  const { touchMode, setTouchMode, isTouch } = useTouchMode();
  const prefs = usePreferences();
  const percent = Math.round(prefs.uiScale * 100);
  return (
    <>
    <Section icon={<Monitor size={14} />} title="Interface">
      <Row label="UI scale" hint="Size of bars, panels, menus and dialogs. The drawing keeps its own zoom.">
        <div className={styles.scale}>
          <Segmented
            value={String(prefs.uiScale)}
            ariaLabel="UI scale"
            onChange={(value) => preferences.set({ uiScale: Number(value) })}
            options={[...UI_SCALE_PRESETS.map((scale) => ({ value: String(scale), label: `${Math.round(scale * 100)}%` })), ...(UI_SCALE_PRESETS.some((scale) => scale === prefs.uiScale) ? [] : [{ value: String(prefs.uiScale), label: `${percent}%` }])]}
          />
          <input
            type="range"
            min={UI_SCALE_MIN * 100}
            max={UI_SCALE_MAX * 100}
            step={5}
            value={percent}
            onChange={(event) => preferences.set({ uiScale: Number(event.target.value) / 100 })}
            aria-label={t('UI scale')}
            data-testid="ui-scale"
          />
        </div>
      </Row>
      <Row label="Language">
        <Segmented<Locale> value={locale} ariaLabel="Language" onChange={setLocale} options={[{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }]} />
      </Row>
      <Row label="Touch Screen Mode" hint={touchMode === 'auto' ? (isTouch ? 'Auto: using touch now' : 'Auto: using mouse now') : 'Larger controls and touch gestures'}>
        <Segmented<TouchModeSetting> value={touchMode} ariaLabel="Touch Screen Mode" onChange={setTouchMode} options={[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
      </Row>
    </Section>
    <Section icon={<Hand size={14} />} title="Board navigation">
      <Row label="Mouse wheel" hint="Ctrl + wheel and trackpad pinch always zoom; with Zoom, Shift + wheel pans.">
        <Segmented value={prefs.wheel} ariaLabel="Mouse wheel" onChange={(wheel) => preferences.set({ wheel })} options={[{ value: 'pan', label: 'Pan' }, { value: 'zoom', label: 'Zoom' }]} />
      </Row>
    </Section>
    <Section icon={<PenLine size={14} />} title="Pen">
      <Row label="Palm rejection" hint="After the pen touches the screen, fingers only pan and zoom for a few seconds.">
        <Segmented value={prefs.palmRejection ? 'on' : 'off'} ariaLabel="Palm rejection" onChange={(value) => preferences.set({ palmRejection: value === 'on' })} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
      </Row>
    </Section>
    </>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className={styles.backdrop} data-ui-scale onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={t('Settings')} data-testid="settings-dialog">
        <header className={styles.header}>
          <h2 className={styles.title}>
            <Settings size={16} />
            {t('Settings')}
          </h2>
          <button type="button" className={styles.close} aria-label={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          <SettingsSections />
        </div>
        <footer className={styles.footer}>
          <button type="button" className={styles.reset} onClick={() => preferences.reset()}>
            <RotateCcw size={14} />
            {t('Reset to defaults')}
          </button>
          <button type="button" className={styles.done} onClick={onClose} data-testid="settings-done">
            {t('Done')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
