/**
 * The banner at the top of the board that says what the active drafting / modify tool needs next
 * (Revit's status prompt, made prominent): SELECT objects (with a count and Done), PICK a curve,
 * or pick a POINT. The cursor also carries the short prompt; this one cannot be missed.
 */
import { MousePointerClick, Crosshair, Target, Check, X } from 'lucide-react';
import { useAppState, useDispatch } from '@/app/context';
import { useI18n } from './i18n';
import styles from './ToolPrompt.module.css';

const PHASE = {
  select: { label: 'Select', icon: MousePointerClick },
  pick: { label: 'Pick', icon: Target },
  point: { label: 'Point', icon: Crosshair },
} as const;

export function ToolPrompt({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const prompt = useAppState((s) => s.ui.toolPrompt);
  if (!prompt) return null;
  const phase = PHASE[prompt.phase];
  const Icon = phase.icon;
  return (
    <div className={styles.prompt} data-phase={prompt.phase} role="status" aria-live="polite" data-testid="tool-prompt">
      <span className={styles.phase}>
        <Icon size={14} /> {t(phase.label)}
      </span>
      <span className={styles.text}>{prompt.text}</span>
      {prompt.phase === 'select' && (
        <button type="button" className={styles.done} disabled={!prompt.count} onClick={onDone} data-testid="tool-prompt-done">
          <Check size={13} /> {t('Done')}
        </button>
      )}
      <button type="button" className={styles.cancel} onClick={() => void dispatch('set-tool', { tool: 'select' })} title={t('Leave the tool (Esc)')}>
        <X size={13} />
      </button>
    </div>
  );
}
