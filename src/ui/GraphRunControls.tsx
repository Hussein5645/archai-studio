import { useAppState, useDispatch } from '@/app/context';
import { graphRuntimeOf } from '@/commands/builtin/parametric';
import { TextButton } from './primitives';

export function GraphRunControls({ componentId, showRunOnce = true }: { componentId: string; showRunOnce?: boolean }) {
  const dispatch = useDispatch();
  const component = useAppState((state) => state.doc.elements[componentId]);
  const runtime = graphRuntimeOf(component);
  const running = runtime.status === 'running';
  return <div data-testid="graph-run-controls" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <span aria-live="polite" title={runtime.message} style={{ color: runtime.status === 'error' ? '#b91c1c' : running ? '#047857' : undefined }}>{runtime.status === 'error' ? `Stopped: ${runtime.message}` : running ? 'Running · live updates' : 'Stopped'}</span>
    {showRunOnce && <TextButton onClick={() => void dispatch('run-parametric-graph', { id: componentId })}>Run once</TextButton>}
    <TextButton onClick={() => void dispatch(running ? 'stop-parametric-graph' : 'start-parametric-graph', { id: componentId })}>{running ? 'Stop graph' : 'Start graph'}</TextButton>
  </div>;
}
