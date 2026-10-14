import type { MenuItemTemplateT } from '@shared/ipc';
import { toAccelerator, type CommandRegistry } from '@/commands';

const MENUS: { label: string; items: (string | '-')[] }[] = [
  {
    label: 'File',
    items: [
      'prompt-new-document',
      'prompt-open-document',
      '-',
      'save-document',
      'save-document-as',
      '-',
      'open-export-dialog',
      '-',
      'import-image',
      'import-3d-model',
      'import-d5-folder',
      'open-modeling',
      'import-cai-package',
    ],
  },
  {
    label: 'Edit',
    items: ['undo', 'redo', '-', 'cut-selection', 'copy-selection', 'paste', 'duplicate-selection', 'delete-selection', '-', 'select-all', 'clear-selection'],
  },
  {
    label: 'Arrange',
    items: [
      'group-selection',
      'ungroup-selection',
      'create-asset-definition',
      'detach-instance',
      '-',
      'bring-forward',
      'send-backward',
      'bring-to-front',
      'send-to-back',
      '-',
      'rotate-cw',
      'rotate-ccw',
      '-',
      'lock-selection',
      'unlock-selection',
      'hide-selection',
      'show-selection',
    ],
  },
  {
    label: 'View',
    items: ['zoom-in', 'zoom-out', 'zoom-reset', 'zoom-to-fit', 'zoom-to-selection', '-', 'toggle-grid', 'toggle-snap', 'open-graphics', '-', 'toggle-left-panel', 'toggle-inspector', 'open-command-palette'],
  },
];

/** The desktop application menu is generated from the registry, so it can never drift. */
export function buildAppMenu(registry: CommandRegistry): MenuItemTemplateT[] {
  return MENUS.map((menu) => ({
    type: 'submenu',
    label: menu.label,
    items: menu.items.flatMap((id): MenuItemTemplateT[] => {
      if (id === '-') return [{ type: 'separator' }];
      const command = registry.get(id);
      if (!command) return [];
      return [
        {
          type: 'command',
          commandId: command.id,
          label: command.label,
          accelerator: command.shortcuts?.[0] ? toAccelerator(command.shortcuts[0]) : undefined,
        },
      ];
    }),
  }));
}
