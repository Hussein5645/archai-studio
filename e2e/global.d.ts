import type { AppServices } from '../src/app/context';

declare global {
  interface Window {
    __archai?: AppServices;
  }
}
