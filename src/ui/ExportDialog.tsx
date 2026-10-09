/**
 * Export dialog for paper sheets: format, resolution, colour mode and scope, with a live preview
 * of the sheet as it will print. The export itself is the `export-paper` command, so everything
 * here is also available to scripts and the AI.
 */
import { Download, FileImage, FileText, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import { papersOf, type ExportSettings } from '@/commands/builtin/export';
import { PAPER_SIZES, paperOf } from '@/commands/builtin/views';
import { clampRaster, pixelsForPrint, type ColorMode, type ExportFormat } from '@/export/quality';
import { boardDoc } from '@/store';
import styles from './ExportDialog.module.css';
import { useI18n } from './i18n';
import { Segmented, SelectField, TextButton, ToggleRow } from './primitives';

/** The last settings used this session, so repeated exports keep their choices. */
let lastSettings: ExportSettings = { format: 'pdf', dpi: 300, quality: 0.92, transparent: false, colorMode: 'color', dxfScope: 'sheet', allPapers: false };

const FORMATS: { value: ExportFormat; label: string; title: string }[] = [
  { value: 'pdf', label: 'PDF', title: 'Vector drawing for print; 3D views and maps at the chosen DPI' },
  { value: 'png', label: 'PNG', title: 'Lossless image, optional transparent background' },
  { value: 'jpg', label: 'JPG', title: 'Compressed image for sharing' },
  { value: 'svg', label: 'SVG', title: 'Vector file for Illustrator, Inkscape or Affinity' },
  { value: 'dxf', label: 'DXF', title: 'CAD drawing for AutoCAD, Revit, Rhino, ArchiCAD, BricsCAD' },
];

const DXF_SCOPES: { value: ExportSettings['dxfScope']; label: string; title: string }[] = [
  { value: 'sheet', label: 'Sheet 1:1', title: 'Everything on the paper in paper millimetres, ready to plot' },
  { value: 'model', label: 'Model', title: 'The drawing only, at true size in real coordinates' },
];

const DPI_OPTIONS = [72, 150, 200, 300, 600].map((dpi) => ({ value: String(dpi), label: `${dpi} dpi` }));

const COLOR_OPTIONS: { value: ColorMode; label: string; title: string }[] = [
  { value: 'color', label: 'Colour', title: 'As drawn' },
  { value: 'grayscale', label: 'Greyscale', title: 'Tones kept, no colour' },
  { value: 'black', label: 'Black ink', title: 'Lines and text in black, fills in grey' },
];

function sizeLabel(size: string, width: number, height: number): string {
  const named = size !== 'custom' && PAPER_SIZES[size] ? size : null;
  const orientation = width >= height ? 'landscape' : 'portrait';
  return `${named ? `${named} ${orientation} · ` : ''}${Math.round(width)} × ${Math.round(height)} mm`;
}

export function ExportDialog() {
  const request = useAppState((s) => s.ui.exportDialog);
  return request.open && request.paperId ? <Dialog key={request.paperId} initialPaperId={request.paperId} /> : null;
}

function Dialog({ initialPaperId }: { initialPaperId: string }) {
  const { t } = useI18n();
  const { store } = useApp();
  const dispatch = useDispatch();
  const doc = useAppState((s) => boardDoc(s));
  const papers = useMemo(() => papersOf(doc), [doc]);
  const [paperId, setPaperId] = useState(initialPaperId);
  const [settings, setSettings] = useState<ExportSettings>(lastSettings);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null);
  const paper = papers.find((candidate) => candidate.id === paperId) ?? papers[0];
  const meta = paper ? paperOf(doc.elements[paper.id]?.meta) : null;
  const update = (patch: Partial<ExportSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const close = () => void dispatch('close-export-dialog');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        void dispatch('close-export-dialog');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, dispatch]);

  // A low-resolution render of the sheet through the same pipeline as the export, redone when
  // the sheet, its frame or the colour mode changes (the key says which render is current).
  const previewKey = paper ? `${paper.id}|${paper.region.x}|${paper.region.y}|${paper.region.width}|${paper.region.height}|${settings.colorMode}` : '';
  useEffect(() => {
    if (!previewKey) return;
    const [id, x, y, width, height, colorMode] = previewKey.split('|') as [string, string, string, string, string, ColorMode];
    const region = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
    let cancelled = false;
    const timer = setTimeout(() => {
      void import('@/export/raster').then(async ({ rasterizeBoard }) => {
        try {
          const canvas = await rasterizeBoard(boardDoc(store.getState()), region, { pixelsPerMm: 560 / Math.max(region.width, region.height), background: '#ffffff', excludeIds: [id], colorMode });
          if (!cancelled) setPreview({ key: previewKey, url: canvas.toDataURL('image/png') });
        } catch {
          // The preview is a convenience; the export reports its own errors.
        }
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewKey, store]);

  if (!paper || !meta) return null;
  const sheetWidth = paper.region.width / paper.scale;
  const sheetHeight = paper.region.height / paper.scale;
  const raster = settings.format === 'png' || settings.format === 'jpg';
  const pixels = clampRaster(pixelsForPrint(sheetWidth, settings.dpi), pixelsForPrint(sheetHeight, settings.dpi));
  const clamped = pixels.factor < 1;
  const count = settings.allPapers ? papers.length : 1;
  const output = settings.allPapers && count > 1 ? (settings.format === 'pdf' ? t(`One PDF, ${count} pages`) : t(`ZIP of ${count} files`)) : `${paper.title}.${settings.format}`;

  const run = async () => {
    setBusy(true);
    lastSettings = settings;
    try {
      const result = await dispatch('export-paper', { ...settings, id: paper.id });
      if (result.ok) void dispatch('close-export-dialog');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} data-ui-scale onPointerDown={(event) => event.target === event.currentTarget && !busy && close()}>
      <section className={styles.dialog} role="dialog" aria-label={t('Export')} data-testid="export-dialog">
        <header className={styles.header}>
          <h2 className={styles.title}>
            <Download size={16} /> {t('Export')}
          </h2>
          <button type="button" className={styles.close} onClick={close} aria-label={t('Close')} disabled={busy}>
            <X size={16} />
          </button>
        </header>
        <div className={styles.body}>
          <figure className={styles.preview} data-color={settings.colorMode}>
            <div className={styles.sheet} style={{ aspectRatio: `${sheetWidth} / ${sheetHeight}` }}>
              {preview?.key === previewKey ? <img src={preview.url} alt={t('Sheet preview')} /> : <Loader2 className={styles.spinner} size={20} />}
            </div>
            <figcaption>
              <strong>{paper.title}</strong>
              <span>
                {sizeLabel(meta.size, sheetWidth, sheetHeight)} · 1:{paper.scale}
              </span>
            </figcaption>
          </figure>
          <div className={styles.settings}>
            {papers.length > 1 && (
              <label className={styles.row}>
                <span>{t('Sheet')}</span>
                <SelectField value={paper.id} options={papers.map((candidate) => ({ value: candidate.id, label: candidate.title }))} onChange={setPaperId} ariaLabel="Sheet" disabled={settings.allPapers} />
              </label>
            )}
            <div className={styles.row}>
              <span>{t('Format')}</span>
              <Segmented value={settings.format} options={FORMATS} onChange={(format) => update({ format })} ariaLabel="Format" />
            </div>
            {settings.format === 'dxf' ? (
              <div className={styles.row}>
                <span>{t('CAD space')}</span>
                <Segmented value={settings.dxfScope} options={DXF_SCOPES} onChange={(dxfScope) => update({ dxfScope })} ariaLabel="CAD space" />
              </div>
            ) : (
              <label className={styles.row}>
                <span>{raster ? t('Resolution') : t('Image resolution')}</span>
                <SelectField value={String(settings.dpi)} options={DPI_OPTIONS} onChange={(dpi) => update({ dpi: Number(dpi) })} ariaLabel="Resolution" />
              </label>
            )}
            <div className={styles.row}>
              <span>{t('Colour')}</span>
              <Segmented value={settings.colorMode} options={COLOR_OPTIONS} onChange={(mode) => update({ colorMode: mode })} ariaLabel="Colour mode" />
            </div>
            {settings.format === 'jpg' && (
              <label className={styles.row}>
                <span>{t('Quality')}</span>
                <span className={styles.slider}>
                  <input type="range" min={0.6} max={1} step={0.02} value={settings.quality} onChange={(event) => update({ quality: Number(event.target.value) })} aria-label={t('JPEG quality')} />
                  <output>{Math.round(settings.quality * 100)}%</output>
                </span>
              </label>
            )}
            {(settings.format === 'png' || settings.format === 'svg') && <ToggleRow label="Transparent background" value={settings.transparent} onChange={(transparent) => update({ transparent })} />}
            {papers.length > 1 && <ToggleRow label={`All sheets (${papers.length})`} value={settings.allPapers} onChange={(allPapers) => update({ allPapers })} />}
            <div className={styles.summary}>
              {settings.format === 'pdf' || settings.format === 'svg' || settings.format === 'dxf' ? <FileText size={14} /> : <FileImage size={14} />}
              <span>
                {output}
                {raster && (
                  <>
                    {' · '}
                    {pixels.width.toLocaleString()} × {pixels.height.toLocaleString()} px
                  </>
                )}
              </span>
            </div>
            {raster && clamped && <p className={styles.note}>{t(`Too large for one image at ${settings.dpi} dpi; it will export at ${Math.floor(settings.dpi * pixels.factor)} dpi.`)}</p>}
            {settings.format === 'dxf' ? (
              <p className={styles.note}>
                {settings.dxfScope === 'sheet'
                  ? t('Millimetres at 1:1 on paper, layered by element type (A-WALL, A-DOOR…) with plot lineweights. 3D views and maps are outlined, not embedded.')
                  : t('Millimetres at true size in real coordinates: the drawing inside view frames and under the sheet, without sheet annotation.')}
              </p>
            ) : (
              !raster && <p className={styles.note}>{t('Lines, text and hatches stay vector; 3D views and maps render at the chosen resolution.')}</p>
            )}
          </div>
        </div>
        <footer className={styles.footer}>
          <TextButton onClick={close} disabled={busy}>
            {t('Cancel')}
          </TextButton>
          <TextButton primary onClick={() => void run()} disabled={busy} data-testid="export-run">
            {busy ? <Loader2 className={styles.spinner} size={14} /> : <Download size={14} />} {busy ? t('Exporting…') : t('Export')}
          </TextButton>
        </footer>
      </section>
    </div>
  );
}
