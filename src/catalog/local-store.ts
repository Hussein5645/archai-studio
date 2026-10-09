import { base64ToBytes, bytesToBase64 } from '@/persistence/base64';
import type { Platform } from '@/platform/types';

const STORAGE_PREFIX = 'archai:cai:pkg:';

export interface LocalCaiStore {
  savePackage(id: string, bytes: Uint8Array): Promise<void>;
  getPackage(id: string): Promise<Uint8Array | null>;
  deletePackage(id: string): Promise<void>;
  listPackageIds(): Promise<string[]>;
  loadAllPackages(): Promise<{ id: string; bytes: Uint8Array }[]>;
  subscribe(listener: () => void): () => void;
}

export function createLocalCaiStore(platform?: Platform | null): LocalCaiStore {
  const memory = new Map<string, Uint8Array>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Error in LocalCaiStore listener', err);
      }
    }
  };

  return {
    async savePackage(id: string, bytes: Uint8Array): Promise<void> {
      memory.set(id, bytes);
      if (platform?.storage) {
        try {
          const key = `${STORAGE_PREFIX}${id}`;
          await platform.storage.set(key, bytesToBase64(bytes));
        } catch (err) {
          console.warn('Could not persist .cai package to platform storage', err);
        }
      }
      notify();
    },

    async getPackage(id: string): Promise<Uint8Array | null> {
      const inMem = memory.get(id);
      if (inMem) return inMem;
      if (platform?.storage) {
        try {
          const raw = await platform.storage.get(`${STORAGE_PREFIX}${id}`);
          if (raw) {
            const bytes = base64ToBytes(raw);
            memory.set(id, bytes);
            return bytes;
          }
        } catch (err) {
          console.warn('Could not load .cai package from storage', err);
        }
      }
      return null;
    },

    async deletePackage(id: string): Promise<void> {
      memory.delete(id);
      if (platform?.storage) {
        try {
          await platform.storage.delete(`${STORAGE_PREFIX}${id}`);
        } catch (err) {
          console.warn('Could not delete .cai package from storage', err);
        }
      }
      notify();
    },

    async listPackageIds(): Promise<string[]> {
      const ids = new Set<string>(memory.keys());
      if (platform?.storage) {
        try {
          const keys = await platform.storage.keys(STORAGE_PREFIX);
          for (const key of keys) {
            ids.add(key.slice(STORAGE_PREFIX.length));
          }
        } catch (err) {
          console.warn('Could not list .cai packages from storage', err);
        }
      }
      return Array.from(ids);
    },

    async loadAllPackages(): Promise<{ id: string; bytes: Uint8Array }[]> {
      const packageIds = await this.listPackageIds();
      const results: { id: string; bytes: Uint8Array }[] = [];
      for (const id of packageIds) {
        const bytes = await this.getPackage(id);
        if (bytes) results.push({ id, bytes });
      }
      return results;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
