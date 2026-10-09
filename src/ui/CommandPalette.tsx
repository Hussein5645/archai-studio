import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useAppState, useDispatch, useRecentDocuments } from '@/app/context';
import { formatShortcut, IS_MAC, type CommandGroup } from '@/commands';
import styles from './CommandPalette.module.css';

const GROUP_LABELS: Record<CommandGroup, string> = {
  create: 'Create',
  select: 'Select & tools',
  transform: 'Transform',
  edit: 'Edit',
  arrange: 'Arrange',
  view: 'View',
  history: 'History',
  document: 'Document',
  shell: 'Panels',
};

const GROUP_ORDER: CommandGroup[] = ['create', 'edit', 'arrange', 'transform', 'select', 'view', 'history', 'document', 'shell'];

interface PaletteItem {
  key: string;
  label: string;
  group: string;
  hint?: string;
  available: boolean;
  score: number;
  run: () => void;
}

function scoreMatch(query: string, label: string, aliases: readonly string[], id: string): number {
  if (!query) return 1;
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const l = label.toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  if (l.includes(q)) return 40;
  if (aliases.some((a) => a.toLowerCase().includes(q))) return 30;
  if (id.includes(q.replace(/\s+/g, '-'))) return 20;
  // Subsequence match as a last resort ("zf" → "zoom to fit").
  let i = 0;
  for (const c of l) if (c === q[i]) i++;
  return i === q.length ? 10 : 0;
}

export function CommandPalette() {
  const open = useAppState((s) => s.ui.paletteOpen);
  if (!open) return null;
  // Mounted fresh on every open, so the query and highlight always start clean.
  return <PaletteDialog />;
}

function PaletteDialog() {
  const { executor, persistence } = useApp();
  const dispatch = useDispatch();
  const state = useAppState((s) => s);
  const recent = useRecentDocuments();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    // Not requestAnimationFrame: it does not fire while the tab is hidden.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(timer);
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  const items = useMemo<PaletteItem[]>(() => {
    const close = () => void dispatch('close-command-palette');
    const commands: PaletteItem[] = executor.registry
      .all()
      .filter((c) => c.palette !== false)
      .map((c) => ({
        key: c.id,
        label: c.label,
        group: GROUP_LABELS[c.group],
        hint: c.shortcuts?.[0] ? formatShortcut(c.shortcuts[0], IS_MAC) : undefined,
        available: executor.isAvailable(c, state),
        score: scoreMatch(query, c.label, c.aliases ?? [], c.id),
        run: () => {
          close();
          void dispatch(c.id);
        },
      }));
    const recents: PaletteItem[] = recent
      .filter((r) => r.id !== state.doc.id)
      .map((r) => ({
        key: `recent:${r.id}`,
        label: `Open “${r.name}”`,
        group: 'Recent documents',
        hint: new Date(r.updatedAt).toLocaleDateString(),
        available: true,
        score: scoreMatch(query, r.name, ['open', 'recent'], r.id),
        run: () => {
          close();
          void persistence.openStored(r.id);
        },
      }));
    const all = [...commands, ...recents].filter((i) => i.score > 0);
    const groupRank = (g: string) => {
      if (g === 'Recent documents') return query ? 0 : 99;
      const index = GROUP_ORDER.findIndex((k) => GROUP_LABELS[k] === g);
      return index === -1 ? 50 : index;
    };
    all.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (query && b.score !== a.score) return b.score - a.score;
      const rank = groupRank(a.group) - groupRank(b.group);
      return rank !== 0 ? rank : a.label.localeCompare(b.label);
    });
    return all;
  }, [dispatch, executor, persistence, query, recent, state]);

  const availableIndexes = items.flatMap((item, index) => item.available ? [index] : []);
  const selectedIndex = items[active]?.available ? active : (availableIndexes[0] ?? -1);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const position = availableIndexes.indexOf(selectedIndex);
      setActive(availableIndexes[(position + step + availableIndexes.length) % availableIndexes.length] ?? -1);
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault();
      const item = items[selectedIndex];
      if (item?.available) item.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void dispatch('close-command-palette');
    } else if (e.key === 'Tab') {
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled):not([tabindex="-1"])') ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  let lastGroup: string | null = null;
  return (
    <div className={styles.backdrop} onPointerDown={() => void dispatch('close-command-palette')} data-ui-scale data-testid="command-palette">
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className={styles.inputRow}>
          <Search size={16} />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder="Type a command…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={selectedIndex >= 0 ? `palette-option-${selectedIndex}` : undefined}
            aria-describedby="palette-help"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            data-testid="palette-input"
          />
          {query && <button type="button" className={styles.control} aria-label="Clear search" onClick={() => { setQuery(''); setActive(0); inputRef.current?.focus(); }}><X size={14} /></button>}
          <button type="button" className={styles.control} aria-label="Close command palette" onClick={() => void dispatch('close-command-palette')}><kbd className="u-kbd">Esc</kbd></button>
        </div>
        <div ref={listRef} className={styles.list} id="palette-list" role="listbox" aria-label="Commands">
          {items.length === 0 && <div className={styles.empty}>No matching commands. Try a tool name, action, or project name.</div>}
          {items.map((item, index) => {
            const showGroup = !query && item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {showGroup && <div className={styles.group}>{item.group}</div>}
                <button
                  type="button"
                  role="option"
                  id={`palette-option-${index}`}
                  tabIndex={-1}
                  aria-selected={index === selectedIndex}
                  aria-disabled={!item.available}
                  className={styles.item}
                  data-active={index === selectedIndex || undefined}
                  data-index={index}
                  disabled={!item.available}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => item.available && item.run()}
                  data-testid={`palette-item-${item.key}`}
                >
                  <span className={styles.itemLabel}>{item.label}</span>
                  {!item.available && <span className={styles.itemHint}>Unavailable</span>}
                  {query && <span className={styles.itemHint}>{item.group}</span>}
                  {item.hint && <kbd className="u-kbd">{item.hint}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
        <div className={styles.footer} id="palette-help">
          <span><kbd className="u-kbd">↑ ↓</kbd> navigate <kbd className="u-kbd">Enter</kbd> run</span>
          <span role="status">{availableIndexes.length} available</span>
        </div>
      </div>
    </div>
  );
}
