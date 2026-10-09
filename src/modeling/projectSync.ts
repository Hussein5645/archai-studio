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
