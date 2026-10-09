import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Unit } from '@/document';
import { fromDisplayUnit, parseLength, toDisplayUnit } from '@/geometry';
import styles from './primitives.module.css';
import { useI18n } from './i18n';

// ---- buttons --------------------------------------------------------------------------------

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: 'default' | 'large';
  children: ReactNode;
}

export function IconButton({ label, active, size = 'default', className, children, ...rest }: IconButtonProps) {
  const { t } = useI18n();
  const translated = t(label);
  return (
    <button
      type="button"
      className={[styles.iconButton, size === 'large' ? styles.large : '', className ?? ''].join(' ')}
      aria-label={translated}
      title={translated}
      data-active={active || undefined}
      aria-pressed={active}
      {...rest}
    >
      {children}
    </button>
  );
}

interface TextButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  primary?: boolean;
  children: ReactNode;
}

export function TextButton({ primary, className, children, ...rest }: TextButtonProps) {
  const { t } = useI18n();
  return (
    <button type="button" className={[styles.textButton, primary ? styles.primary : '', className ?? ''].join(' ')} {...rest}>
      {typeof children === 'string' ? t(children) : children}
    </button>
  );
}

// ---- fields ---------------------------------------------------------------------------------

export function Field({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t(label)}</span>
      {children}
    </label>
  );
}

export function FieldRow({ children, single }: { children: ReactNode; single?: boolean }) {
  return <div className={single ? styles.rowSingle : styles.row}>{children}</div>;
}

interface NumberFieldProps {
  value: number;
  onCommit: (value: number) => void;
  /** Displays an empty "Multiple values" state until a value is committed. */
  mixed?: boolean;
  /** Display unit; the value is always millimetres when a unit is given. */
  unit?: Unit;
  precision?: number;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Numeric input that commits on Enter/blur, reverts on Escape and nudges with arrow keys. */
export function NumberField({ value, onCommit, mixed = false, unit, precision = 2, suffix, step, min, max, disabled, ariaLabel }: NumberFieldProps) {
  const { t } = useI18n();
  const format = (v: number) => (unit ? toDisplayUnit(v, unit).toFixed(precision) : Number.isInteger(v) ? String(v) : v.toFixed(precision));
  const [text, setText] = useState(() => mixed ? '' : format(value));
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // Re-derive the displayed text when the value or its formatting changes while not editing.
  const formatted = mixed ? '' : format(value);
  const [synced, setSynced] = useState(formatted);
  if (formatted !== synced) {
    setSynced(formatted);
    if (!editing) setText(formatted);
  }

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = () => {
    setEditing(false);
    const parsed = unit ? parseLength(text, unit) : Number(text);
    if (parsed === null || !Number.isFinite(parsed)) {
      setText(mixed ? '' : format(value));
      return;
    }
    const next = clamp(parsed);
    if (mixed || Math.abs(next - value) > 1e-9) onCommit(next);
    else setText(format(value));
  };

  return (
    <div className={styles.inputWrap}>
      <input
        ref={ref}
        className={styles.input}
        value={text}
        placeholder={mixed ? t('Multiple values') : undefined}
        disabled={disabled}
        aria-label={ariaLabel ? t(ariaLabel) : undefined}
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            ref.current?.blur();
          } else if (e.key === 'Escape') {
            setText(mixed ? '' : format(value));
            setEditing(false);
            ref.current?.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const direction = e.key === 'ArrowUp' ? 1 : -1;
            const base = step ?? (unit ? fromDisplayUnit(1, unit) / 10 : 1);
            const delta = base * direction * (e.shiftKey ? 10 : 1);
            onCommit(clamp(value + delta));
          }
        }}
      />
      {(suffix ?? unit) && <span className={styles.suffix}>{suffix ?? unit}</span>}
    </div>
  );
}

interface ColorFieldProps {
  value: string | null;
  onCommit: (value: string | null) => void;
  allowNone?: boolean;
  ariaLabel?: string;
}

export function ColorField({ value, onCommit, allowNone, ariaLabel }: ColorFieldProps) {
  const { t } = useI18n();
  const [text, setText] = useState(value ?? '');
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(value ?? '');
  }
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'none') {
      if (allowNone) onCommit(null);
      else setText(value ?? '');
      return;
    }
    const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) onCommit(hex.toLowerCase());
    else setText(value ?? '');
  };
  return (
    <div className={styles.inputWrap}>
      <span className={styles.swatch} style={{ position: 'relative' }}>
        <span className={styles.swatchInner} style={{ background: value ?? 'transparent' }} />
        <input
          type="color"
          className={styles.colorInput}
          value={value && value.length === 7 ? value : '#000000'}
          onChange={(e) => onCommit(e.target.value)}
          aria-label={`${t(ariaLabel ?? 'Colour')} ${t('picker')}`}
        />
      </span>
      <input
        className={styles.input}
        value={text}
        placeholder={allowNone ? t('None') : '#000000'}
        aria-label={ariaLabel ? t(ariaLabel) : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(value ?? '');
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

export function TextField({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  disabled,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }
  return (
    <div className={styles.inputWrap}>
      <input
          className={styles.input}
          disabled={disabled}
        value={text}
        placeholder={placeholder ? t(placeholder) : undefined}
        aria-label={ariaLabel ? t(ariaLabel) : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onCommit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  mixed = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  mixed?: boolean;
}) {
  const { t } = useI18n();
  return (
    <select className={styles.select} value={mixed ? '' : value} aria-label={ariaLabel ? t(ariaLabel) : undefined} disabled={disabled} onChange={(e) => e.target.value !== '' && onChange(e.target.value as T)}>
      {mixed && <option value="" disabled>{t('Multiple values')}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {t(o.label)}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={ariaLabel ? t(ariaLabel) : undefined}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title ? t(o.title) : undefined}
          className={styles.segment}
          data-active={o.value === value || undefined}
          onClick={() => onChange(o.value)}
        >
          {typeof o.label === 'string' ? t(o.label) : o.label}
        </button>
      ))}
    </div>
  );
}

export function ToggleRow({ label, value, onChange, disabled = false, mixed = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; mixed?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={styles.toggleRow}>
      <span>{t(label)}</span>
      <button type="button" role="switch" aria-checked={mixed ? 'mixed' : value} aria-label={t(label)} className={styles.toggle} data-on={!mixed && value} data-mixed={mixed || undefined} disabled={disabled} onClick={() => onChange(mixed ? true : !value)} />
    </div>
  );
}

export function Divider() {
  return <div className={styles.divider} />;
}

// ---- menus ----------------------------------------------------------------------------------

export interface MenuEntry {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  icon?: ReactNode;
  onSelect: () => void;
}

export type MenuContent = (MenuEntry | { separator: true } | { title: string })[];

interface MenuProps {
  position: { x: number; y: number };
  entries: MenuContent;
  onClose: () => void;
  ariaLabel?: string;
  /** `above`: `position.y` is where the menu's bottom edge goes (menus opening upwards). */
  placement?: 'below' | 'above';
}

/** A positioned popup menu with keyboard navigation; closes on outside click or Escape. */
export function Menu({ position, entries, onClose, ariaLabel, placement = 'below' }: MenuProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const items = entries.filter((e): e is MenuEntry => 'id' in e);

  // `position` is in screen pixels; a menu scaled by the UI scale (CSS zoom) scales its own
  // left/top too, so they are divided by its zoom. Upward menus measure their real height.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const zoom = node.currentCSSZoom || 1;
    const height = node.getBoundingClientRect().height;
    const top = placement === 'above' ? Math.max(8, position.y - height) : position.y;
    node.style.left = `${position.x / zoom}px`;
    node.style.top = `${top / zoom}px`;
    node.style.transform = '';
    // Keep the menu on screen.
    const rect = node.getBoundingClientRect();
    const dx = Math.min(0, window.innerWidth - 8 - rect.right) - Math.min(0, rect.left - 8);
    const dy = Math.min(0, window.innerHeight - 8 - rect.bottom);
    if (dx || dy) node.style.transform = `translate(${dx / zoom}px, ${dy / zoom}px)`;
  }, [placement, position.x, position.y, entries.length]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!node.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let next = active;
      for (let i = 0; i < items.length; i++) {
        next = (next + step + items.length) % items.length;
        if (!items[next]!.disabled) break;
      }
      setActive(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const item = items[active];
      if (item && !item.disabled) {
        item.onSelect();
        onClose();
      }
    }
  };

  const rows = entries.map((entry) => ({ entry, itemIndex: 'id' in entry ? items.indexOf(entry) : -1 }));
  return (
    <div ref={ref} className={styles.menu} style={{ left: position.x, top: position.y }} data-ui-scale role="menu" aria-label={ariaLabel ? t(ariaLabel) : undefined} tabIndex={-1} onKeyDown={onKeyDown}>
      {rows.map(({ entry, itemIndex }, i) => {
        if ('separator' in entry) return <div key={`sep-${i}`} className={styles.divider} />;
        if ('title' in entry)
          return (
            <div key={`title-${i}`} className={styles.menuGroupTitle}>
              {t(entry.title)}
            </div>
          );
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={styles.menuItem}
            disabled={entry.disabled}
            data-active={itemIndex === active || undefined}
            onMouseEnter={() => setActive(itemIndex)}
            onClick={() => {
              entry.onSelect();
              onClose();
            }}
          >
            {entry.icon}
            <span className={styles.menuItemLabel}>{t(entry.label)}</span>
            {entry.shortcut && <kbd className="u-kbd">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
