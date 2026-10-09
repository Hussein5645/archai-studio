import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Whether ArchAI runs on a VR headset (in its browser, or as the Android app on the headset), so
 * the UI can adapt; a VR modelling mode will build on this. `immersiveVr` is WebXR support for
 * immersive sessions, which a desktop browser with a PC headset also has, so it does not by itself
 * mean the user is wearing one.
 */
export interface VrDevice {
  /** The page is shown on a standalone headset. */
  headset: boolean;
  /** A display name such as "Meta Quest 3", or null. */
  name: string | null;
  /** navigator.xr reports immersive-vr sessions (known after a check; false until then). */
  immersiveVr: boolean;
}

const HEADSETS: ReadonlyArray<{ pattern: RegExp; name: (match: RegExpMatchArray) => string }> = [
  { pattern: /\bQuest\s?(Pro|\d)?\b/i, name: (m) => `Meta Quest${m[1] ? ` ${m[1]}` : ''}` },
  { pattern: /OculusBrowser|\bOculus\b/i, name: () => 'Meta Quest' },
  { pattern: /\bPico\b(?:\s?(\w+))?/i, name: () => 'Pico' },
  { pattern: /\bWolvic\b/i, name: () => 'VR headset (Wolvic)' },
  { pattern: /\bVIVE\b|\bVive (Focus|XR)\b/i, name: () => 'HTC VIVE' },
  { pattern: /MagicLeap|Magic Leap/i, name: () => 'Magic Leap' },
  { pattern: /\bLynx\b/i, name: () => 'Lynx' },
];

/** The headset a user agent belongs to, or null (pure, for tests). */
export function headsetFromUserAgent(userAgent: string): string | null {
  for (const { pattern, name } of HEADSETS) {
    const match = userAgent.match(pattern);
    if (match) return name(match);
  }
  return null;
}

function initial(): VrDevice {
  const name = typeof navigator === 'undefined' ? null : headsetFromUserAgent(navigator.userAgent);
  return { headset: name !== null, name, immersiveVr: false };
}

const VrDeviceContext = createContext<VrDevice | null>(null);

export function VrDeviceProvider({ children }: { children: ReactNode }) {
  const [device, setDevice] = useState<VrDevice>(initial);

  useEffect(() => {
    const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
    if (!xr) return;
    let live = true;
    xr.isSessionSupported('immersive-vr')
      .then((supported) => {
        if (live && supported) setDevice((d) => ({ ...d, immersiveVr: true }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    // For styles (and later the VR modelling mode): html[data-vr-headset="true"].
    document.documentElement.setAttribute('data-vr-headset', device.headset ? 'true' : 'false');
    document.documentElement.setAttribute('data-immersive-vr', device.immersiveVr ? 'true' : 'false');
  }, [device]);

  const value = useMemo(() => device, [device]);
  return <VrDeviceContext.Provider value={value}>{children}</VrDeviceContext.Provider>;
}

export function useVrDevice(): VrDevice {
  return useContext(VrDeviceContext) ?? initial();
}
