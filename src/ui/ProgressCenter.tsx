/**
 * The progress card: long tasks (src/progress) in the bottom corner, each with its title, current
 * step and a bar (filling when the amount of work is known, sweeping otherwise). Tasks that end
 * within SHOW_AFTER_MS never appear, so quick operations do not flash a card.
 */
import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { progressTasks, subscribeProgress, type ProgressTask } from '@/progress';
import { useI18n } from './i18n';
import styles from './ProgressCenter.module.css';

const SHOW_AFTER_MS = 350;

export function ProgressCenter() {
  const { t } = useI18n();
  const tasks = useSyncExternalStore(subscribeProgress, progressTasks);
  const [now, setNow] = useState(() => Date.now());

  // Re-check once young tasks pass SHOW_AFTER_MS.
  // (Keyed on the oldest such task, so frequent progress updates do not keep postponing it.)
  const pendingSince = tasks.reduce<number | null>((oldest, task) => (task.state === 'running' && now - task.startedAt < SHOW_AFTER_MS && (oldest === null || task.startedAt < oldest) ? task.startedAt : oldest), null);
  useEffect(() => {
    if (pendingSince === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, pendingSince + SHOW_AFTER_MS - Date.now()) + 10);
    return () => clearTimeout(timer);
  }, [pendingSince]);

  // Running tasks once they are SHOW_AFTER_MS old; finished ones only if they ran that long.
  const visible = tasks.filter((task) => (task.state === 'running' ? now - task.startedAt >= SHOW_AFTER_MS : task.state === 'done' && (task.endedAt ?? task.startedAt) - task.startedAt >= SHOW_AFTER_MS));
  if (visible.length === 0) return null;
  return (
    <div className={styles.center} role="status" aria-live="polite" data-testid="progress-center">
      {visible.slice(-3).map((task) => (
        <TaskCard key={task.id} task={task} doneLabel={t('Done')} />
      ))}
    </div>
  );
}

function TaskCard({ task, doneLabel }: { task: ProgressTask; doneLabel: string }) {
  const { t } = useI18n();
  const percent = task.fraction === null ? null : Math.round(task.fraction * 100);
  const done = task.state === 'done';
  return (
    <div className={styles.card} data-testid="progress-task" data-state={task.state}>
      <div className={styles.head}>
        {done ? <Check size={14} className={styles.ok} aria-hidden="true" /> : <Loader2 size={14} className={styles.spin} aria-hidden="true" />}
        <strong className={styles.title}>{t(task.title)}</strong>
        <span className={styles.percent}>{done ? doneLabel : percent === null ? '' : `${percent}%`}</span>
      </div>
      {task.detail && !done && <div className={styles.detail}>{t(task.detail)}</div>}
      <div
        className={styles.track}
        role="progressbar"
        aria-label={t(task.title)}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null ? {} : { 'aria-valuenow': percent })}
      >
        {percent === null && !done ? <div className={styles.sweep} /> : <div className={styles.fill} style={{ transform: `scaleX(${done ? 1 : (percent ?? 0) / 100})` }} />}
      </div>
    </div>
  );
}
