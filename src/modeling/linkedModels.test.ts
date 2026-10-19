import { expect, it } from 'vitest';
import { linkedModels } from './linkedModels';
import { snapshotOf } from './persistence';
import { modelingStore } from './store';

it('hides old package aliases while retaining separately created modeling workspaces', () => {
  const state = modelingStore.getState();
  const model = snapshotOf('workspace', { ...state, metadata: { ...state.metadata, id: 'chair' } }, { id: 'project', name: 'Project' });
  const alias = { ...model, id: 'chair' };
  const second = { ...model, id: 'another-workspace' };
  expect(linkedModels([model, alias, second], 'project').map(item => item.id)).toEqual(['workspace', 'another-workspace']);
  expect(linkedModels([model], 'other-project')).toEqual([]);
});
