/** Opens the sign-in dialog from anywhere (library panels, VR link, Home, top bar). */
import { useSyncExternalStore } from 'react';

export type AccountDialogMode = 'sign-in' | 'sign-up' | 'password';

let open: { mode: AccountDialogMode; reason: string | null } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** `reason` says why an account is needed ("Sign in to use the libraries"). */
export function openAccountDialog(mode: AccountDialogMode = 'sign-in', reason: string | null = null): void {
  open = { mode, reason };
  emit();
}

export function closeAccountDialog(): void {
  open = null;
  emit();
}

export function useAccountDialog(): { mode: AccountDialogMode; reason: string | null } | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}
