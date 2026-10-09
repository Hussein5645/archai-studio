import { useEffect, useRef, useState } from 'react';
import { useApp, useAppState, useDispatch } from '@/app/context';
import type { RectElement, TextElement } from '@/document';
import { stickyFontSize, stickyOf } from '@/annotations/model';
import { LINE_HEIGHT, worldMatrix, worldToScreen } from '@/geometry';
import styles from './Workboard.module.css';

/**
 * In-place text editing: an HTML textarea positioned over the element in screen space. Edits
 * are kept locally and committed as one `set-text` when editing ends.
 */
export function TextEditor() {
  const editingId = useAppState((s) => s.ui.editingTextId);
  const element = useAppState((s) => (s.ui.editingTextId ? s.doc.elements[s.ui.editingTextId] : undefined));
  if (element?.kind === 'rect' && editingId && stickyOf(element)) return <StickyEditorSession key={editingId} element={element} />;
  if (!element || element.kind !== 'text' || !editingId) return null;
  // Keyed by element id so each editing session starts with fresh local state.
  return <TextEditorSession key={editingId} element={element} />;
}

function TextEditorSession({ element }: { element: TextElement }) {
  const { store } = useApp();
  const dispatch = useDispatch();
  const viewport = useAppState((s) => s.ui.viewport);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(element.text);
  const initial = useRef(element.text);

  useEffect(() => {
    const node = ref.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, []);

  // Grow with the wrapped text instead of scrolling inside the box.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [value, viewport.zoom]);

  const m = worldMatrix(store.getState().doc.elements, element);
  const origin = worldToScreen(viewport, { x: m[4], y: m[5] });
  const rotation = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const fontPx = element.fontSize * viewport.zoom;

  const commit = () => {
    const text = value.trim() === '' ? initial.current : value;
    if (text !== initial.current) dispatch('set-text', { id: element.id, text });
    if (value.trim() === '' && initial.current === '') dispatch('delete-selection', { ids: [element.id] });
    dispatch('end-text-edit');
  };

  return (
    <textarea
      ref={ref}
      className={styles.textEditor}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setValue(initial.current);
          dispatch('end-text-edit');
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: origin.x,
        top: origin.y,
        width: Math.max(20, element.width * viewport.zoom),
        minHeight: Math.max(fontPx * LINE_HEIGHT, element.height * viewport.zoom),
        fontSize: fontPx,
        color: element.color,
        textAlign: element.align,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
      }}
      spellCheck={false}
      aria-label="Edit text"
    />
  );
}

/** A sticky note edited in place: a textarea the colour and size of the note. */
function StickyEditorSession({ element }: { element: RectElement }) {
  const { store } = useApp();
  const dispatch = useDispatch();
  const viewport = useAppState((s) => s.ui.viewport);
  const ref = useRef<HTMLTextAreaElement>(null);
  const sticky = stickyOf(element)!;
  const [value, setValue] = useState(sticky.text);
  const initial = useRef(sticky.text);

  useEffect(() => {
    const node = ref.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, []);

  const m = worldMatrix(store.getState().doc.elements, element);
  const origin = worldToScreen(viewport, { x: m[4], y: m[5] });
  const rotation = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const scale = Math.hypot(m[0], m[1]);
  const width = element.width * scale * viewport.zoom;
  const height = element.height * scale * viewport.zoom;
  const fontPx = stickyFontSize(value, element.width, element.height) * scale * viewport.zoom;

  const commit = () => {
    if (value !== initial.current) dispatch('set-text', { id: element.id, text: value });
    dispatch('end-text-edit');
  };

  return (
    <textarea
      ref={ref}
      className={styles.textEditor}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setValue(initial.current);
          dispatch('end-text-edit');
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: origin.x,
        top: origin.y,
        width,
        height,
        padding: `${height * 0.08}px ${width * 0.08}px`,
        boxSizing: 'border-box',
        fontSize: fontPx,
        lineHeight: 1.25,
        color: '#1f2024',
        background: sticky.color,
        textAlign: 'center',
        borderRadius: width * 0.01,
        boxShadow: '0 4px 14px rgba(0,0,0,.18)',
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
      }}
      spellCheck={false}
      placeholder="Type a note"
      aria-label="Edit sticky note"
      data-testid="sticky-editor"
    />
  );
}
