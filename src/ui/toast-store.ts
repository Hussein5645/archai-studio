/** Minimal notification store, independent of the document store. */
export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  message: string;
}

export interface ToastStore {
  push(toast: Omit<Toast, 'id'>): void;
  dismiss(id: number): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): Toast[];
}

export function createToastStore(): ToastStore {
  let toasts: Toast[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const dismiss = (id: number) => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  };
  return {
    push(toast) {
      const id = nextId++;
      toasts = [...toasts, { id, ...toast }].slice(-4);
      notify();
      setTimeout(() => dismiss(id), toast.kind === 'error' ? 6000 : 3000);
    },
    dismiss,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => toasts,
  };
}
