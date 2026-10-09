import { describe, expect, it } from 'vitest';
import { headsetFromUserAgent } from './vrDevice';

describe('headsetFromUserAgent', () => {
  it('recognises the Meta Quest browser and the Android app on a Quest', () => {
    expect(headsetFromUserAgent('Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/126.0 VR Safari/537.36')).toBe('Meta Quest 3');
    expect(headsetFromUserAgent('Mozilla/5.0 (Linux; Android 12; Quest Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 wv')).toBe('Meta Quest Pro');
    expect(headsetFromUserAgent('Mozilla/5.0 (Linux; Android 12; A8150) wv ArchAI-Android (Oculus; Eureka)')).toBe('Meta Quest');
  });

  it('recognises other standalone headsets', () => {
    expect(headsetFromUserAgent('Mozilla/5.0 (Linux; Android 10; A8150) wv ArchAI-Android (Pico; A8150)')).toBe('Pico');
    expect(headsetFromUserAgent('Mozilla/5.0 (Android 10; Mobile VR; rv:105.0) Gecko/105.0 Firefox/105.0 Wolvic/1.3')).toBe('VR headset (Wolvic)');
  });

  it('leaves phones, tablets and desktops alone', () => {
    expect(headsetFromUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 wv ArchAI-Android (samsung; SM-X710)')).toBeNull();
    expect(headsetFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36')).toBeNull();
    expect(headsetFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBeNull();
  });
});
