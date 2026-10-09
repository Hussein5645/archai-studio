/**
 * The Inspector's "Data and sheets" section of an analysis origin: export its numbers as CSV and
 * put charts of it on a sheet (see commands/builtin/analysisData.ts).
 */
import { ChartPie, Compass, FileSpreadsheet, Sun, Table2, Wind } from 'lucide-react';
import { useState } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import type { Element } from '@/document';
import { Divider, Field, FieldRow, NumberField, TextButton } from '@/ui/primitives';
import { useI18n } from '@/ui/i18n';
import { paperOf } from '@/commands/builtin/views';
import { quantityOf } from './dataExport';
import type { AnalysisMeta } from './model';
import styles from '@/ui/Inspector.module.css';

export function AnalysisDataPanel({ element, meta }: { element: Element; meta: AnalysisMeta }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const [spacing, setSpacing] = useState(1000);
  const { unit, threshold: defaultThreshold, quantity } = quantityOf(meta);
  const [threshold, setThreshold] = useState(defaultThreshold);
  const [busy, setBusy] = useState(false);
  // Charts go on the open sheet, else a selected or the only paper.
  const paperId = useAppState((s) => s.ui.sheet?.paperId ?? Object.values(s.doc.elements).filter((e) => paperOf(e.meta) && e.parentId === null).map((e) => e.id).at(0) ?? null);
  const run = async (command: string, input: Record<string, unknown>) => {
    setBusy(true);
    try {
      await dispatch(command, input);
    } finally {
      setBusy(false);
    }
  };
  const needsRun = !meta.active;
  return (
    <>
      <Divider />
      <div className={styles.section} data-testid="analysis-data-section">
        <h3 className="u-section-title">{t('Data and sheets')}</h3>
        <FieldRow>
          <Field label="Grid">
            <NumberField value={spacing / 1000} precision={2} min={0.1} max={10} step={0.25} suffix="m" onCommit={(value) => setSpacing(Math.round(value * 1000))} ariaLabel="Sample spacing" />
          </Field>
          <Field label={meta.kind === 'sun' && meta.display !== 'sun-hours' ? 'Lit at least' : 'Threshold'}>
            <NumberField value={threshold} precision={1} suffix={unit} onCommit={setThreshold} ariaLabel="Threshold" />
          </Field>
        </FieldRow>
        <p className={styles.hint}>{needsRun ? t('Run the analysis to export its values: they come from its 3D view.') : t(`${quantity} on the ground, roofs and every level floor.`)}</p>
        <div className={styles.actions}>
          <TextButton disabled={busy || needsRun} onClick={() => void run('export-analysis-data', { id: element.id, content: 'grid', spacing })}>
            <FileSpreadsheet size={13} /> {t('Grid CSV')}
          </TextButton>
          <TextButton disabled={busy || needsRun} onClick={() => void run('export-analysis-data', { id: element.id, content: 'summary', spacing, threshold })}>
            <Table2 size={13} /> {t('Summary CSV')}
          </TextButton>
          <TextButton disabled={busy} onClick={() => void run('export-analysis-data', { id: element.id, content: 'climate' })}>
            <Compass size={13} /> {t('Climate CSV')}
          </TextButton>
        </div>
        <div className={styles.actions}>
          {meta.kind === 'sun' && (
            <TextButton disabled={!paperId} onClick={() => void dispatch('add-analysis-chart', { paperId, originId: element.id, chart: 'sun-path' })}>
              <Sun size={13} /> {t('Sun path')}
            </TextButton>
          )}
          {meta.kind === 'wind' && (
            <TextButton disabled={!paperId} onClick={() => void dispatch('add-analysis-chart', { paperId, originId: element.id, chart: 'wind-rose' })}>
              <Wind size={13} /> {t('Wind rose')}
            </TextButton>
          )}
          <TextButton disabled={!paperId} onClick={() => void dispatch('add-analysis-chart', { paperId, originId: element.id, chart: 'legend' })}>
            <ChartPie size={13} /> {t('Legend')}
          </TextButton>
          <TextButton disabled={!paperId || busy || needsRun} onClick={() => void run('add-analysis-summary', { paperId, originId: element.id, spacing, threshold })}>
            <Table2 size={13} /> {t('Summary table')}
          </TextButton>
        </div>
        {!paperId && <p className={styles.hint}>{t('Add a paper (Shift+P) to place charts on a sheet.')}</p>}
      </div>
    </>
  );
}
