import { useEffect } from 'react';
import { buildKeymap, buildSequences, commandsForEvent, IS_MAC, isEditableTarget, keyFromEvent } from '@/commands';
import { useApp, useDispatch } from './context';
import { projectLoading } from '@/persistence/projectLoading';
import { bytesToBase64 } from '@/persistence/base64';

/** Keys that text inputs must keep for themselves even with a modifier held. */
const INPUT_OWNED = new Set(['z', 'y', 'c', 'v', 'x', 'a']);

/**
 * Binds every command shortcut from the registry — the registry is the single keyboard source
 * of truth, so the palette, menus and tooltips can never disagree with what the keys do.
 */
export function useGlobalShortcuts(): void {
  const { registry, executor, store, platform } = useApp();
  const dispatch = useDispatch();

  useEffect(() => {
    const keymap = buildKeymap(registry.all());
    const sequences = buildSequences(registry.all());
    /** The last plain letter typed and when, for two-letter sequences such as M V. */
    let last: { key: string; at: number } | null = null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (projectLoading.getSnapshot()) { e.preventDefault(); return; }
      if (e.defaultPrevented || e.isComposing) return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isEditableTarget(e.target);
      const key = keyFromEvent(e);
      if (plain && /^[a-z0-9]$/.test(key)) {
        const now = performance.now();
        const pair = last && now - last.at < 900 ? last.key + key : null;
        last = { key, at: now };
        const matched = pair ? sequences.get(pair) : undefined;
        if (matched) {
          const state = store.getState();
          const command = matched.find((c) => executor.isAvailable(c, state));
          last = null;
          e.preventDefault();
          if (command) void dispatch(command.id);
          return;
        }
      } else if (!plain) last = null;
      const candidates = commandsForEvent(keymap, e, IS_MAC);
      if (candidates.length === 0) return;
      const editable = isEditableTarget(e.target);
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      if (editable) {
        if (!hasModifier) return; // plain keys type characters
        if (INPUT_OWNED.has(keyFromEvent(e))) return; // native undo/copy/paste inside inputs
      }
      const state = store.getState();
      const command = candidates.find((c) => executor.isAvailable(c, state));
      // Browser paste events carry screenshots/files without requiring clipboard-read permission.
      if (command?.id === 'paste' && platform.kind === 'web' && !editable) return;
      // Swallow the key even when unavailable so the browser does not e.g. open "Save page".
      if (hasModifier || !editable) e.preventDefault();
      if (command) void dispatch(command.id);
    };
    window.addEventListener('keydown', onKeyDown);
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target) || projectLoading.getSnapshot() || store.getState().ui.editingTextId || store.getState().ui.screen !== 'project') return;
      const text = event.clipboardData?.getData('text/plain');
      if (text?.includes('archai/elements')) { event.preventDefault(); void dispatch('paste', {text}); return; }
      const file = Array.from(event.clipboardData?.files ?? []).find(file => file.type.startsWith('image/'));
      if (file) {
        event.preventDefault();
        const docId = store.getState().doc.id;
        void file.arrayBuffer().then(bytes => { if (store.getState().doc.id === docId) return dispatch('paste-image', {data:bytesToBase64(new Uint8Array(bytes)),mime:file.type,name:file.name}); });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('paste', onPaste); };
  }, [dispatch, executor, registry, store, platform]);
}
