import { useState } from 'react';
import { createPortal } from 'react-dom';
import { openAccountDialog } from '@/ui/account-dialog';
import { account } from '@/cloud/account';
import { useAccount, useAppState } from '@/app/context';
import type { UnrealImageOptions } from '@shared/unrealRuntime';
import styles from './ViewOutput.module.css';
import { interactiveSource, type InteractiveOutput } from './interactiveExport';
import { documentInContext, viewContext } from '@/document/viewVisibility';

export type ViewAction = 'render' | 'bake' | 'interactive' | 'vr';
export const viewActionEvent = 'archai:view-output';
export function requestViewAction(portalId: string, action: ViewAction) {
  if (action === 'vr' && account().state().status !== 'signed-in') { openAccountDialog('sign-in', 'Sign in to export to VR'); return; }
  window.dispatchEvent(new CustomEvent(viewActionEvent, { detail: { portalId, action } }));
}
export type ImageOutput = UnrealImageOptions & { format: 'png' | 'jpeg' };
export function ViewOutputDialog({ mode, busy, error, onClose, onImage, onInteractive, children, portalId = null, result = '', initialDestination = 'folder' }: {
  mode: 'render' | 'interactive'; busy: boolean; error: string; onClose: () => void;
  onImage: (options: ImageOutput) => Promise<void>; onInteractive: (ids: string[] | null, output: InteractiveOutput) => Promise<void>;
  portalId?: string | null;
  result?: string;
  initialDestination?: 'folder' | 'link';
  children?: React.ReactNode;
}) {
  const signedIn = useAccount().status === 'signed-in';
  const doc = useAppState((s) => portalId ? documentInContext(s.doc, viewContext(portalId)) : s.doc);
  const [source] = useState(() => interactiveSource(doc, portalId));
  const [destination, setDestination] = useState<'folder' | 'link'>(initialDestination);
  const [lighting, setLighting] = useState<'realtime' | 'baked'>(source.renderer === 'baked' && source.current && (initialDestination === 'folder' || source.webReady) ? 'baked' : 'realtime');
  const restricted = !signedIn && (source.renderer !== 'default' || destination !== 'folder');
  const canBake = source.renderer !== 'default' && source.current && (destination === 'folder' || source.webReady);
  const selection = useAppState((s) => s.ui.selection);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [quality, setQuality] = useState<'standard' | 'high'>('high');
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [scope, setScope] = useState('all');
  const [ids, setIds] = useState<string[]>(selection.filter((id) => !doc.elements[id]?.meta?.['view3d']));
  const objects = Object.values(doc.elements).filter((e) => e.visible && !e.meta?.['view3d'] && !e.meta?.['renderLight'] && !e.meta?.['point'] && !e.meta?.['cameraMarker'] && !e.meta?.['viewRig'] && !e.meta?.['sectionLine']);
  return createPortal(<div className={styles.backdrop}>
    <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={mode === 'render' ? 'Render image' : 'Export interactive scene'}>
      <header><strong>{mode === 'render' ? 'Render image' : 'Export interactive scene'}</strong><button onClick={onClose} disabled={busy} aria-label="Close export settings">×</button></header>
      {mode === 'render' ? <>
        <label>Resolution<select aria-label="Render resolution" onChange={(e) => { const [w, h] = e.target.value.split('x').map(Number); if (w && h) { setWidth(w); setHeight(h); } }} defaultValue="1920x1080">
          <option value="1280x720">HD · 1280 × 720</option><option value="1920x1080">Full HD · 1920 × 1080</option><option value="2560x1440">QHD · 2560 × 1440</option><option value="3840x2160">4K · 3840 × 2160</option><option value="custom">Custom</option>
        </select></label>
        <div className={styles.row}><label>Width<input aria-label="Render width" type="number" min={320} max={7680} value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label><label>Height<input aria-label="Render height" type="number" min={240} max={7680} value={height} onChange={(e) => setHeight(Number(e.target.value))} /></label></div>
        <div className={styles.row}><label>Quality<select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}><option value="standard">Standard</option><option value="high">High</option></select></label><label>Format<select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label></div>
        {children}
        <button disabled={busy || !Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240 || width > 7680 || height > 7680} onClick={() => void onImage({ width, height, quality, format })}>{busy ? 'Rendering…' : 'Render image'}</button>
      </> : <>
        <label>Export as<select aria-label="Interactive destination" value={destination} onChange={e => { const value = e.target.value as typeof destination; setDestination(value); if (value === 'link' && !source.webReady) setLighting('realtime'); }}>
          <option value="folder">Folder · desktop{signedIn ? ' and VR' : ''}</option><option value="link">Web link · desktop, mobile and VR</option>
        </select></label>
        {restricted && <p role="note">An account is required for Unreal, web links and VR. Guests can export a Default view as an interactive desktop folder.</p>}
        <p data-testid="interactive-source">Source: {source.renderer === 'default' ? 'Default' : source.renderer === 'baked' ? 'Baked scene' : 'Unreal Engine'} · Style: {source.style}.<br />
          Bake: {source.current ? `available${source.bake?.webError ? ' for Unreal only' : ''}` : source.bake ? 'outdated — rebake to use it' : 'not available'}.</p>
        {source.renderer !== 'default' && <label>Lighting<select aria-label="Interactive lighting" value={lighting} onChange={e => setLighting(e.target.value as typeof lighting)}>
          <option value="realtime">Real-time · no bake required</option><option value="baked" disabled={!canBake}>Saved baked lighting</option>
        </select></label>}
        <label>Include<select aria-label="Export scope" value={scope} onChange={(e) => setScope(e.target.value)}><option value="all">Whole scene</option><option value="selected">Choose elements</option></select></label>
        {scope === 'selected' && <div className={styles.objects}>{objects.map((e) => <label key={e.id}><input type="checkbox" checked={ids.includes(e.id)} onChange={(event) => setIds((items) => event.target.checked ? [...items, e.id] : items.filter((id) => id !== e.id))} />{e.name || e.kind}</label>)}</div>}
        <p>{destination === 'link' ? 'Publishes an optimized WebXR scene. Open the link on desktop, mobile or a supported headset browser. Sign in to publish. Unreal lighting is approximated for the web; the Windows player is not uploaded.'
          : source.renderer === 'default' ? signedIn ? 'Portable browser experience with desktop navigation and WebXR controls. The folder includes a local player. Unreal Editor is not required.' : 'Interactive desktop folder using the Default renderer. No Unreal download or account is required.'
          : lighting === 'baked' ? 'Copies the saved Unreal Lightmass experience for Windows / PC OpenXR. Materials and lighting come from the bake; selection filtering keeps its original lighting context.'
          : 'Walkable Unreal player for Windows and PC VR, using the current view style and real-time lighting. Unreal Editor is not required.'}</p>
        {source.current && source.bake?.webError && destination === 'link' && <p>The browser bake is unavailable. This link will use real-time web lighting.</p>}
        <button disabled={busy || (scope === 'selected' && !ids.length) || lighting === 'baked' && !canBake} onClick={() => restricted ? openAccountDialog('sign-in', 'Sign in for Unreal, web publishing and VR exports') : void onInteractive(scope === 'all' ? null : ids,
          { destination, lighting, renderer: source.renderer, style: source.style, signature: source.signature })}>{busy ? 'Exporting…' : restricted ? 'Sign in to export' : 'Export interactive scene'}</button>
      </>}
      {busy && <div role="progressbar" aria-label={mode === 'render' ? 'Rendering image' : 'Exporting interactive scene'} className={styles.progress}><span /></div>}
      {error && <p role="alert">{error}</p>}
      {result && (result.startsWith('https://') ? <label>Interactive link<input aria-label="Interactive link" readOnly value={result} onFocus={event => event.currentTarget.select()} /></label> : <p role="status">{result}</p>)}
    </section>
  </div>, document.body);
}

export async function encodeImage(bytes: Uint8Array, format: 'png' | 'jpeg'): Promise<Uint8Array> {
  if (format === 'png') return bytes;
  const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
  try {
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not encode image')), 'image/jpeg', 0.95));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { image.close(); }
}
