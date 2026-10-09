/**
 * Materials from the internet (src/materials/online.ts): search Poly Haven's CC0 library and add
 * a material, with all its texture maps, to the project in one click (one undo step).
 */
import { Check, Globe, Loader2, Search, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { useApp, useDispatch } from '@/app/context';
import { downloadOnlineMaterial, ONLINE_CATEGORIES, onlineMaterials, searchOnline, type OnlineMaterial, type OnlineResolution } from '@/materials/online';
import { materialUi } from '@/materials/uiStore';
import { useI18n } from './i18n';
import styles from './OnlineMaterials.module.css';

const PAGE = 60;

export function OnlineMaterials({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const { toasts } = useApp();
  const [all, setAll] = useState<OnlineMaterial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [resolution, setResolution] = useState<OnlineResolution>('1k');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [added, setAdded] = useState<Record<string, true>>({});

  useEffect(() => {
    onlineMaterials().then(setAll, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const results = useMemo(() => (all ? searchOnline(all, query, category) : []), [all, query, category]);

  const add = async (item: OnlineMaterial) => {
    if (busy[item.id] !== undefined) return;
    setBusy((b) => ({ ...b, [item.id]: 0 }));
    try {
      const downloaded = await downloadOnlineMaterial(item, resolution, (fraction) => setBusy((b) => ({ ...b, [item.id]: fraction })));
      const result = await dispatch('create-material', { material: downloaded.material, textures: downloaded.textures });
      if (!result.ok) throw new Error(result.error.message);
      materialUi.set({ active: result.value as string });
      setAdded((a) => ({ ...a, [item.id]: true }));
      toasts.push({ kind: 'success', message: `${t('Added')} ${item.name} (${(downloaded.bytes / 1_048_576).toFixed(1)} MB)` });
    } catch (e) {
      toasts.push({ kind: 'error', message: `${item.name}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[item.id];
        return next;
      });
    }
  };

  const size = (item: OnlineMaterial) => (item.dimensions ? `${(item.dimensions[0] / 1000).toFixed(item.dimensions[0] % 1000 ? 2 : 1)} × ${(item.dimensions[1] / 1000).toFixed(item.dimensions[1] % 1000 ? 2 : 1)} m` : '');

  return createPortal(
    <div className={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={styles.dialog} role="dialog" aria-label={t('Materials from the internet')} data-testid="online-materials">
        <header className={styles.header}>
          <Globe size={18} />
          <div>
            <h2>{t('Materials from the internet')}</h2>
            <p>
              {t('Scanned PBR materials from')} <a href="https://polyhaven.com/textures" target="_blank" rel="noopener noreferrer">Poly Haven</a> · CC0, {t('free for any use')}
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.controls}>
          <label className={styles.search}>
            <Search size={14} />
            <input autoFocus placeholder={t('Search: brick, oak floor, marble, concrete…')} value={query} onChange={(event) => {
                setQuery(event.target.value);
                setShown(PAGE);
              }} />
          </label>
          <select value={resolution} onChange={(event) => setResolution(event.target.value as OnlineResolution)} title={t('Texture resolution (larger files look sharper up close)')}>
            <option value="1k">1K · ~2 MB</option>
            <option value="2k">2K · ~8 MB</option>
            <option value="4k">4K · ~30 MB</option>
          </select>
        </div>
        <div className={styles.chips}>
          <button type="button" aria-pressed={category === null} onClick={() => {
              setCategory(null);
              setShown(PAGE);
            }}>
            {t('All')}
          </button>
          {ONLINE_CATEGORIES.map((c) => (
            <button key={c} type="button" aria-pressed={category === c} onClick={() => {
                setCategory(category === c ? null : c);
                setShown(PAGE);
              }}>
              {c}
            </button>
          ))}
        </div>
        <div className={styles.results}>
          {error && <p className={styles.note}>{t('The library could not be reached')} ({error}). {t('Check the internet connection and try again.')}</p>}
          {!all && !error && (
            <p className={styles.note}>
              <Loader2 size={14} className={styles.spin} /> {t('Loading the library…')}
            </p>
          )}
          {all && results.length === 0 && <p className={styles.note}>{t('No materials match.')}</p>}
          <div className={styles.grid}>
            {results.slice(0, shown).map((item) => {
              const progress = busy[item.id];
              return (
                <button key={item.id} type="button" className={styles.card} onClick={() => void add(item)} disabled={progress !== undefined} title={`${item.name}\n${item.categories.join(', ')}`} data-testid={`online-${item.id}`}>
                  <img src={item.thumb} alt="" loading="lazy" />
                  <span className={styles.name}>{item.name}</span>
                  <span className={styles.meta}>{size(item)}</span>
                  {progress !== undefined && (
                    <span className={styles.progress}>
                      <span style={{ width: `${Math.round(progress * 100)}%` }} />
                    </span>
                  )}
                  {added[item.id] && progress === undefined && (
                    <span className={styles.added}>
                      <Check size={12} /> {t('Added')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {results.length > shown && (
            <button type="button" className={styles.more} onClick={() => setShown((n) => n + PAGE)}>
              {t('Show more')} ({results.length - shown})
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
