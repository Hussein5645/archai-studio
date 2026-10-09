import { describe, expect, it } from 'vitest';
import { SYNC_CHANNEL_NAME, type InsertModeledAssetMsg, type ProjectDocUpdateMsg } from './projectSync';
import { createEmptyDocument, sequentialIds } from '@/document';
import { createGrayedOutProjectGroup, extractProjectElementSnapPoints } from './projectReference';
import * as THREE from 'three';
import type { SketchPlane } from './kernel/types';

describe('projectSync', () => {
  it('defines channel name correctly', () => {
    expect(SYNC_CHANNEL_NAME).toBe('archai-project-sync');
  });

  it('formats project messages accurately', () => {
    const ids = sequentialIds();
    const doc = createEmptyDocument({ ids, now: () => '2026-01-01', name: 'Test Project' });
    
    const docMsg: ProjectDocUpdateMsg = {
      type: 'PROJECT_DOC_UPDATE',
      projectId: doc.id,
      doc,
    };
    expect(docMsg.projectId).toBe(doc.id);
    expect(docMsg.doc.meta.name).toBe('Test Project');

    const insertMsg: InsertModeledAssetMsg = {
      type: 'INSERT_MODELED_ASSET',
      projectId: doc.id,
      assetId: 'asset-123',
      name: 'Custom Chair',
      caiBytes: new Uint8Array([1, 2, 3]),
      position: { x: 500, y: 1200, elevation: 0 },
    };
    expect(insertMsg.position.x).toBe(500);
    expect(insertMsg.position.y).toBe(1200);

    // Verify session presence message formats
    const reqMsg = {
      type: 'REQUEST_MODELING_SESSIONS' as const,
      projectId: doc.id,
    };
    expect(reqMsg.type).toBe('REQUEST_MODELING_SESSIONS');
    expect(reqMsg.projectId).toBe(doc.id);

    const announceMsg = {
      type: 'MODELING_SESSION_ANNOUNCE' as const,
      projectId: doc.id,
      assetId: 'asset-456',
      name: 'Dining Table',
    };
    expect(announceMsg.name).toBe('Dining Table');

    const closedMsg = {
      type: 'MODELING_SESSION_CLOSED' as const,
      projectId: doc.id,
      assetId: 'asset-456',
    };
    expect(closedMsg.assetId).toBe('asset-456');

    const terminateMsg = {
      type: 'MODELING_SESSION_TERMINATE' as const,
      projectId: doc.id,
      assetId: 'asset-456',
    };
    expect(terminateMsg.type).toBe('MODELING_SESSION_TERMINATE');
  });
});

describe('createGrayedOutProjectGroup', () => {
  it('creates an unselectable, grayed-out 3D group for an ArchAI document', () => {
    const ids = sequentialIds();
    const doc = createEmptyDocument({ ids, now: () => '2026-01-01', name: 'Test Project' });
    
    const group = createGrayedOutProjectGroup(doc);
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.name).toBe('project-reference-group');

    // Verify raycast is disabled on all objects in the group
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        expect(typeof child.raycast).toBe('function');
        // Dummy raycaster test
        const raycaster = new THREE.Raycaster();
        const intersects: THREE.Intersection[] = [];
        child.raycast(raycaster, intersects);
        expect(intersects.length).toBe(0);
      }
    });
  });
});

describe('extractProjectElementSnapPoints', () => {
  it('extracts vertex projections and edge intersections with label "Project Element"', () => {
    const group = new THREE.Group();
    // Create a simple box mesh centered at (100, 50, 100) with size (100, 100, 100)
    // Vertices: X in [50, 150], Y in [0, 100], Z in [50, 150]
    const geom = new THREE.BoxGeometry(100, 100, 100);
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(100, 50, 100);
    mesh.updateMatrixWorld(true);
    group.add(mesh);

    const topPlane: SketchPlane = { kind: 'plane', id: 'top', offset: 50 }; // Y = 50 passes right through the middle of the box
    const candidates = extractProjectElementSnapPoints(group, topPlane);

    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(['Project Element', 'Project Intersection']).toContain(c.label);
      expect(['body-vertex', 'edge-intersection']).toContain(c.type);
      expect(c.point).toBeDefined();
      expect(c.point3D).toBeDefined();
    }

    // Verify caching exists on userData
    expect(group.userData['cachedProjectGeometry']).toBeDefined();
    const cachedGeom = group.userData['cachedProjectGeometry'];
    expect(cachedGeom.vertices.length).toBeGreaterThan(0);

    // Call again to ensure cache hit works
    const candidates2 = extractProjectElementSnapPoints(group, topPlane);
    expect(candidates2.length).toBe(candidates.length);
  });
});
