import { useEffect, useState, type ReactNode } from 'react';
import { useAccount, useApp } from '@/app/context';
import { openAccountDialog } from '@/ui/account-dialog';
import type { RuntimeDownloadState } from '@shared/runtimeDownload';
import styles from './ViewOutput.module.css';

/** Mounting the native view starts Unreal: wait for sign-in and an explicit pack download. */
export function UnrealAccess({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const { platform } = useApp();
  const account = useAccount();
  const [status, setStatus] = useState<RuntimeDownloadState | null>(null);
  const [error, setError] = useState('');
  const signedIn = account.status === 'signed-in';
  useEffect(() => {
    if (!signedIn || !platform.unreal?.downloadStatus) return;
    let active = true;
    const poll = () => void platform.unreal!.downloadStatus!().then(value => { if (active) setStatus(value); }).catch(reason => { if (active) setError(String(reason)); });
    poll(); const timer = setInterval(poll, 500);
    return () => { active = false; clearInterval(timer); };
  }, [signedIn, platform]);
  if (signedIn && (status?.state === 'ready' || platform.unreal && !platform.unreal.downloadStatus)) return children;
  const busy = status && ['downloading', 'verifying', 'installing'].includes(status.state);
  const download = async () => {
    setError(''); setStatus({ state: 'downloading', received: 0, total: 0 });
    try { setStatus(await platform.unreal!.downloadInstall!()); } catch (reason) { setError(String(reason)); setStatus({ state: 'error', received: 0, total: 0 }); }
  };
  return <div className={styles.backdrop} style={{ position: 'absolute', zIndex: 10 }}>
    <section className={styles.dialog} role="dialog" aria-label="Unreal rendering">
      <header><strong>Unreal rendering</strong><button onClick={onClose}>Back to board</button></header>
      {!signedIn ? <><p>Sign in to download Unreal rendering and use VR and interactive exports. Without an account, you can export a Default view as an interactive desktop folder.</p>
        <button onClick={() => openAccountDialog('sign-in', 'Sign in to use Unreal rendering')}>Sign in</button></> : !platform.unreal?.downloadInstall ? <p>Download the Windows app to use Unreal rendering.</p> : <>
        <p>Unreal is an optional download, stored on this computer. Your projects stay in Archai. No Unreal Editor installation is needed for real-time rendering and exports.</p>
        {busy ? <><p role="status">{status.state === 'downloading' ? `Downloading Unreal${status.total ? ` · ${Math.round(status.received / status.total * 100)}% (${Math.round(status.received / 1048576)} / ${Math.round(status.total / 1048576)} MB)` : '…'}` : status.state === 'verifying' ? 'Verifying download…' : 'Installing Unreal…'}</p>
          <progress aria-label="Unreal download" max={status.total || 1} {...(status.total ? { value: status.received } : {})} />
          <button onClick={() => void platform.unreal?.downloadCancel?.()}>Cancel download</button></> : <button onClick={() => void download()} disabled={!status}>Download Unreal</button>}
      </>}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </section>
  </div>;
}
