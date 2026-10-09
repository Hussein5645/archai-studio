import { useApp, useAppState, useDispatch } from '@/app/context';
import { formatShortcut, IS_MAC } from '@/commands';
import { Menu, type MenuContent } from './primitives';
import { profileKindOf } from '@/commands/builtin/profileEdit';

const SELECTION_COMMANDS: (string | 'separator')[] = [
  'cut-selection',
  'copy-selection',
  'paste',
  'duplicate-selection',
  'delete-selection',
  'separator',
  'tool-move',
  'tool-copy',
  'tool-rotate',
  'tool-mirror',
  'tool-scale',
  'tool-array',
  'tool-offset',
  'select-similar',
  'join-lines',
  'explode-selection',
  'separator',
  'group-selection',
  'create-parametric-folder',
  'ungroup-selection',
  'create-asset-definition',
  'detach-instance',
  'separator',
  'bring-forward',
  'send-backward',
  'bring-to-front',
  'send-to-back',
  'separator',
  'lock-selection',
  'unlock-selection',
  'hide-selection',
  'rotate-cw',
  'separator',
  'zoom-to-selection',
];

const BOARD_COMMANDS: (string | 'separator')[] = ['repeat-last-tool', 'paste', 'select-all', 'separator', 'zoom-to-fit', 'zoom-reset', 'toggle-grid', 'toggle-snap', 'separator', 'create-level-sheets'];

export function ContextMenu({ position, onClose }: { position: { x: number; y: number }; onClose: () => void }) {
  const { executor } = useApp();
  const dispatch = useDispatch();
  const state = useAppState((s) => s);
  const commandIds = state.ui.selection.length > 0 ? SELECTION_COMMANDS : BOARD_COMMANDS;
  const entries: MenuContent = [];
  // The profile drawing mode first: finish or leave it; else a floor / ceiling / level offers it.
  if (state.ui.profileEdit) {
    entries.push({ id: 'finish-profile-edit', label: 'Finish boundary', onSelect: () => void dispatch('finish-profile-edit') }, { id: 'cancel-profile-edit', label: 'Cancel boundary', onSelect: () => void dispatch('cancel-profile-edit') }, { separator: true });
  } else if (state.ui.selection.length === 1 && profileKindOf(state.doc.elements[state.ui.selection[0]!])) {
    const id = state.ui.selection[0]!;
    entries.push({ id: 'begin-profile-edit', label: 'Edit boundary', onSelect: () => void dispatch('begin-profile-edit', { id }) }, { separator: true });
  }
  let pendingSeparator = false;
  for (const id of commandIds) {
    if (id === 'separator') {
      pendingSeparator = entries.length > 0;
      continue;
    }
    const command = executor.registry.get(id);
    if (!command) continue;
    const available = executor.isAvailable(command, state);
    // Hide unavailable toggles (e.g. "Unlock" when nothing is locked) to keep the menu short.
    if (!available && (id.startsWith('lock') || id.startsWith('unlock') || id === 'ungroup-selection' || id === 'detach-instance' || id === 'repeat-last-tool' || id === 'join-lines')) continue;
    if (pendingSeparator) {
      entries.push({ separator: true });
      pendingSeparator = false;
    }
    entries.push({
      id,
      label: command.label,
      shortcut: command.shortcuts?.[0] ? formatShortcut(command.shortcuts[0], IS_MAC) : undefined,
      disabled: !available,
      onSelect: () => void dispatch(id),
    });
  }
  return <Menu position={position} entries={entries} onClose={onClose} ariaLabel="Context menu" />;
}
