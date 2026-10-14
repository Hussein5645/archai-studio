import { planOfBlob } from './meshPlan';

self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(planOfBlob(event.data));
};
