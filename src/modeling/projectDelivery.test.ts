import { afterEach, expect, it, vi } from 'vitest';
import { sendModeledAsset, type InsertModeledAssetMsg } from './projectSync';

const message: InsertModeledAssetMsg = { type: 'INSERT_MODELED_ASSET', projectId: 'project', assetId: 'model', name: 'Model', caiBytes: new Uint8Array(), position: { x: 0, y: 0, elevation: 0 } };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function channelFixture() {
  let sent: InsertModeledAssetMsg;
  const close = vi.fn();
  const channel = { onmessage: (_event: unknown) => {}, postMessage: (value: InsertModeledAssetMsg) => { sent = value; }, close };
  vi.stubGlobal('BroadcastChannel', class { constructor() { return channel; } });
  return { close, ack: (success: boolean, requestId?: string) => channel.onmessage({ data: { type: 'ASSET_INSERTED_ACK', projectId: message.projectId, assetId: message.assetId, requestId: requestId ?? sent.requestId, success, message: 'Save failed' } }) };
}

it('waits for the matching project save confirmation and closes its channel', async () => {
  const channel = channelFixture();
  const complete = vi.fn();
  const sending = sendModeledAsset(message).then(complete);
  channel.ack(true, 'unrelated-request');
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  channel.ack(true);
  await sending;
  expect(complete).toHaveBeenCalled();
  expect(channel.close).toHaveBeenCalled();
});

it('surfaces failed project saves', async () => {
  const channel = channelFixture();
  const sending = sendModeledAsset(message);
  channel.ack(false);
  await expect(sending).rejects.toThrow('Save failed');
  expect(channel.close).toHaveBeenCalled();
});

it('times out when the destination is closed', async () => {
  vi.useFakeTimers();
  const channel = channelFixture();
  const sending = sendModeledAsset(message);
  const rejected = expect(sending).rejects.toThrow('did not confirm');
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(channel.close).toHaveBeenCalled();
});
