export interface LogEntry { id: number; time: string; level: 'info' | 'warn' | 'error'; message: string }
let entries: readonly LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
export const logEntries = () => entries;
export const subscribeLog = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function clearLog() { entries = []; for (const listener of listeners) listener(); }
export function addLog(level: LogEntry['level'], message: string) {
  const safe = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi, '$1[redacted]')
    .replace(/\bsk-[\w-]+/g, '[redacted]');
  entries = [...entries.slice(-499), { id: nextId++, time: new Date().toISOString(), level, message: safe.slice(0, 4000) }];
  for (const listener of listeners) listener();
}

let installed = false;
export function installDiagnostics() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      addLog(level, args.map((arg) => arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : '[details]').join(' '));
    };
  }
  window.addEventListener('error', (event) => addLog('error', event.message));
  window.addEventListener('unhandledrejection', (event) => addLog('error', event.reason instanceof Error ? event.reason.message : String(event.reason)));
}
