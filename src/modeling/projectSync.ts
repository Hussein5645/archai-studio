import type { ArchaiDocument } from '@/document';

export const SYNC_CHANNEL_NAME = 'archai-project-sync';

export interface RequestProjectDocMsg {
  type: 'REQUEST_PROJECT_DOC';
  projectId: string;
}

export interface ProjectDocUpdateMsg {
  type: 'PROJECT_DOC_UPDATE';
  projectId: string;
  doc: ArchaiDocument;
}

export interface InsertModeledAssetMsg {
  requestId?: string;
  /** Identity used by packages sent before project links used the workspace id. */
  previousPackageKey?: string;
  type: 'INSERT_MODELED_ASSET';
  projectId: string;
  assetId: string;
  name: string;
  caiBytes: Uint8Array;
  position: {
    /** 2D document x in mm (matches 3D scene X) */
    x: number;
    /** 2D document y in mm (matches 3D scene Z) */
    y: number;
    /** Elevation in mm (matches 3D scene Y up) */
    elevation: number;
  };
}

export interface AssetInsertedAckMsg {
  requestId?: string;
  type: 'ASSET_INSERTED_ACK';
  projectId: string;
  assetId: string;
  success: boolean;
  message?: string;
}

export interface RequestModelingSessionsMsg {
  type: 'REQUEST_MODELING_SESSIONS';
  projectId: string;
}

export interface ModelingSessionAnnounceMsg {
  type: 'MODELING_SESSION_ANNOUNCE';
  projectId: string;
  assetId: string;
  name: string;
}

export interface ModelingSessionClosedMsg {
  type: 'MODELING_SESSION_CLOSED';
  projectId: string;
  assetId: string;
}

export interface ModelingSessionTerminateMsg {
  type: 'MODELING_SESSION_TERMINATE';
  projectId: string;
  assetId: string;
}

export type ProjectSyncMessage =
  | RequestProjectDocMsg
  | ProjectDocUpdateMsg
  | InsertModeledAssetMsg
  | AssetInsertedAckMsg
  | RequestModelingSessionsMsg
  | ModelingSessionAnnounceMsg
  | ModelingSessionClosedMsg
  | ModelingSessionTerminateMsg;

export function getProjectSyncChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(SYNC_CHANNEL_NAME);
  } catch {
    return null;
  }
}

/** A send succeeds only after the destination has applied and saved the model. */
export function sendModeledAsset(message: InsertModeledAssetMsg): Promise<void> {
  const channel = getProjectSyncChannel();
  if (!channel) return Promise.reject(new Error('Project communication is unavailable.'));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('The linked project did not confirm the model. Open that project and try again.')), 120_000);
    channel.onmessage = (event: MessageEvent<ProjectSyncMessage>) => {
      const ack = event.data;
      if (ack?.type !== 'ASSET_INSERTED_ACK' || ack.requestId !== requestId || ack.projectId !== message.projectId || ack.assetId !== message.assetId) return;
      finish(ack.success ? undefined : new Error(ack.message || 'The project could not save the model.'));
    };
    try { channel.postMessage({ ...message, requestId }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
