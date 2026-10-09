/**
 * The modeling workspace, served at `/modeling?asset=<id>&name=<name>` in its own tab or
 * desktop window: asset metadata, a split viewport (3D / top / front / side / cameras, each
 * pane with its own display style), a Layers tree (model layers with their GLB nodes, cameras,
 * view planes, modeled bodies), an Inspector for the selection, and the Tools panel (primitive
 * solids and the gizmo mode for now). Body meshes come from the kernel worker (see ./bodies.ts).
 * Everything autosaves locally (see ./persistence.ts).
 */
import { ArrowLeft, ArrowUpFromLine, Box, Camera, Check, ChevronDown, ChevronRight, Circle, Columns2, Combine, Cone, Copy, CopyPlus, Cylinder, Download, Ellipse, Eye, EyeOff, FlipHorizontal2, Focus, Grid2x2, Hand, Hexagon, Home, Image as ImageIcon, Layers, Lock, MousePointer2, Move, Move3d, MoveRight, Package, PaintBucket, PenLine, PenTool, Pencil, PencilRuler, Plus, RectangleHorizontal, Redo2, RefreshCw, Rotate3d, RotateCw, Scaling, Scissors, Send, Slice, Spline, Square, SquareDashed, SquareRoundCorner, Target, Trash2, TriangleAlert, Undo2, Upload, Video, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Vector3 } from 'three';
import { ASSET_CATEGORIES } from '@/catalog/categories';
import type { ArchaiDocument } from '@/document';
import { parseDocument } from '@/persistence/serialize';
import { ColorField, Field, FieldRow, IconButton, NumberField, Segmented, SelectField, TextButton, TextField, ToggleRow } from '@/ui/primitives';
import { TouchActionBar } from '@/ui/TouchActionBar';
import { useTouchMode } from '@/ui/touch';
import topBarStyles from '@/ui/TopBar.module.css';
import { BodyRuntime } from './bodies';
import { kernel } from './kernel/client';
import styles from './Modeling.module.css';
import { Panel } from './Panel';
import { ParametersPanel, ParamNumber } from './ParametersPanel';
import { fieldPath } from './parameters';
import { modelingStorage, snapshotOf } from './persistence';
import { modelingScene, PLANE_COLORS, WORK_PLANE_COLOR } from './scene';
import { packageAsset } from './package';
import { getProjectSyncChannel, type ProjectSyncMessage } from './projectSync';
import { createGrayedOutProjectGroup } from './projectReference';
import { arrangeSketch, checkLineLoop, dot, planeFrame, planeLabel, samePlane, shapeContour, shapesBounds, stitchedLineLoops, toPlane, toWorld } from './kernel/sketch';
import { fixProfile, moveShape } from './sketchEdit';
import { bulgeArc } from './curves';
import type { InferenceType } from './inference';
import { resolveExtrudeParts, summarizeExtrude, type ExtrudeSummary } from './tools/extrude';
import { modifyInstruction } from './tools/modify';
import { planeOnFace, planeThroughPoint, topologyFacts, traceOntoPlane } from './referenceActions';
import { cameraOfPane, curveRefIsClosed, findBody, findNode, findSketch, modelingStore, newFeatureId, newShapeId, paneCount, PLANE_AXIS, PLANE_LABELS, ORTHO_VIEWS, PRIMITIVE_LABELS, PRIMITIVE_SIZES, selectedSketchId, viewPlaneOf, selectionKey, MODIFY_TOOLS, SKETCH_TOOLS, STYLE_LABELS, useModeling, type Body, type Extrude, type Feature, type Layer, type LayerNode, type Layout, type Lod, type ModelingState, type OrthoViewId, type PaneView, type PlaneId, type PrimitiveShape, type SelectedItem, type Shape2D, type Sketch, type SketchPlane, type Tool, type Vec2, type ViewStyle, type WorkPlaneSetupMode } from './store';
import { downloadCaiFile, extractCaiPackage } from '@/catalog/builder';
import { ModelingViewport } from './viewport';
import { formatBoardId } from '@/app/router';

const ICON = 16;
const CATEGORY_OPTIONS = ASSET_CATEGORIES.map((value) => ({ value, label: value }));
const STYLE_OPTIONS = (Object.keys(STYLE_LABELS) as ViewStyle[]).map((value) => ({ value, label: STYLE_LABELS[value] }));
const LOD_OPTIONS: { value: Lod; label: string }[] = [
  { value: 'high', label: 'High LOD' },
  { value: 'low', label: 'Low LOD' },
];
const PLANE_IDS: PlaneId[] = ['top', 'front', 'side'];
const PRIMITIVE_SHAPES: PrimitiveShape[] = ['box', 'cylinder', 'sphere', 'cone'];
const SHAPE_OPTIONS = PRIMITIVE_SHAPES.map((value) => ({ value, label: PRIMITIVE_LABELS[value] }));
const TOOL_LABELS: Record<Tool, string> = { select: 'Select', line: 'Line', rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', polyline: 'Polyline', arc: 'Arc', ellipse: 'Ellipse', spline: 'Pen curve', freehand: 'Freehand', knife: 'Knife', offset: 'Offset', pickline: 'Pick lines', smove: 'Move', scopy: 'Copy', srotate: 'Rotate', smirror: 'Mirror curves', sscale: 'Scale', trim: 'Trim / extend', extend: 'Extend to boundary', split: 'Split', fillet: 'Fillet / chamfer', extrude: 'Extrude', pushpull: 'Push/pull', revolve: 'Revolve', sweep: 'Sweep', mirror: 'Mirror', pattern: 'Pattern', boolean: 'Boolean', paint: 'Paint' };
/** Single keys select tools; `Esc` is handled on its own. */
const TOOL_KEYS: Record<Tool, string> = { select: 'Esc', line: 'L', rect: 'R', circle: 'C', polygon: 'P', polyline: 'W', arc: 'A', ellipse: 'EL', spline: 'SP', freehand: 'F', knife: 'J', offset: 'O', pickline: 'PL', smove: 'MV', scopy: 'CO', srotate: 'RO', smirror: 'MM', sscale: 'RE', trim: 'TR', extend: 'ET', split: 'SL', fillet: 'FL', extrude: 'E', pushpull: 'Q', revolve: 'V', sweep: 'U', mirror: 'M', pattern: 'N', boolean: 'B', paint: 'K' };
const AXIS_OPTIONS: { value: 'x' | 'y' | 'z'; label: string }[] = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
];
const BOOLEAN_OPTIONS: { value: 'union' | 'subtract' | 'intersect'; label: string }[] = [
  { value: 'union', label: 'Union' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'intersect', label: 'Intersect' },
];
const OP_OPTIONS: { value: Extrude['op']; label: string }[] = [
  { value: 'new', label: 'New body' },
  { value: 'add', label: 'Add' },
  { value: 'cut', label: 'Cut' },
];

function ToolIcon({ tool, size = 16 }: { tool: Tool; size?: number }) {
  switch (tool) {
    case 'select':
      return <MousePointer2 size={size} />;
    case 'rect':
      return <RectangleHorizontal size={size} />;
    case 'line':
      return <PenLine size={size} />;
    case 'circle':
      return <Circle size={size} />;
    case 'polygon':
      return <Hexagon size={size} />;
    case 'polyline':
      return <PenLine size={size} />;
    case 'arc':
      return <Spline size={size} />;
    case 'ellipse':
      return <Ellipse size={size} />;
    case 'spline':
      return <PenTool size={size} />;
    case 'freehand':
      return <Pencil size={size} />;
    case 'knife':
      return <Scissors size={size} />;
    case 'offset':
      return <SquareDashed size={size} />;
    case 'pickline':
      return <Target size={size} />;
    case 'smove':
      return <Move size={size} />;
    case 'scopy':
      return <CopyPlus size={size} />;
    case 'srotate':
      return <RotateCw size={size} />;
    case 'smirror':
      return <FlipHorizontal2 size={size} />;
    case 'sscale':
      return <Scaling size={size} />;
    case 'trim':
      return <Scissors size={size} />;
    case 'extend':
      return <MoveRight size={size} />;
    case 'split':
      return <Slice size={size} />;
    case 'fillet':
      return <SquareRoundCorner size={size} />;
    case 'extrude':
      return <ArrowUpFromLine size={size} />;
    case 'pushpull':
      return <Hand size={size} />;
    case 'revolve':
      return <RefreshCw size={size} />;
    case 'sweep':
      return <Spline size={size} />;
    case 'mirror':
      return <FlipHorizontal2 size={size} />;
    case 'pattern':
      return <Copy size={size} />;
    case 'boolean':
      return <Combine size={size} />;
    case 'paint':
      return <PaintBucket size={size} />;
  }
}

function FeatureIcon({ feature, size = 13 }: { feature: Feature; size?: number }) {
  const className = 'u-muted';
  switch (feature.kind) {
    case 'primitive':
      return <ShapeIcon shape={feature.shape} size={size} />;
    case 'mesh':
      return <Box size={size} className={className} />;
    case 'extrude':
      return <ArrowUpFromLine size={size} className={className} />;
    case 'revolve':
      return <RefreshCw size={size} className={className} />;
    case 'sweep':
      return <Spline size={size} className={className} />;
    case 'mirror':
      return <FlipHorizontal2 size={size} className={className} />;
    case 'pattern':
      return <Copy size={size} className={className} />;
    case 'boolean':
      return <Combine size={size} className={className} />;
    case 'transform':
      return <Move3d size={size} className={className} />;
    case 'direct-edit':
      return <Move3d size={size} className={className} />;
  }
}

function FeatureDriverRows({ feature, depth, onSelect, sketches }: { feature: Feature; depth: number; onSelect: ModelingState['select']; sketches: Sketch[] }) {
  // Several profiles: a row for all of them, then one per profile loop.
  if ((feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') && feature.profileShapes?.length) {
    const sketch = findSketch(sketches, feature.profile);
    const loops = sketch ? profileLoops(sketch, feature.profileShapes) : [];
    if (loops.length > 1) {
      const all = feature.profileShapes;
      return (
        <>
          <li className={styles.treeRow} style={{ paddingInlineStart: depth }} data-testid={`profiles-${feature.id}`}>
            <span className={styles.treeToggle} />
            <Layers size={11} className="u-muted" />
            <button type="button" className={styles.treeName} onClick={(event) => onSelect({ kind: 'loop', sketchId: feature.profile, loopIndex: 0, shapeIds: all }, event.shiftKey || event.ctrlKey || event.metaKey)}>Profiles</button>
            <span className={styles.treeMeta} title="Linked: editing these curves updates the solid">{loops.length} · linked</span>
          </li>
          {loops.map((loop, index) => {
            const shapeIds = loop.shapeIds.filter((id) => all.includes(id));
            return (
              <li key={loop.id} className={styles.treeRow} style={{ paddingInlineStart: depth + 14 }} data-testid={`profile-${feature.id}-${index}`}>
                <span className={styles.treeToggle} />
                <Spline size={11} className="u-muted" />
                <button type="button" className={styles.treeName} onClick={(event) => onSelect(shapeIds.length === 1 ? { kind: 'shape', sketchId: feature.profile, shapeId: shapeIds[0]! } : { kind: 'loop', sketchId: feature.profile, loopIndex: loop.loopIndex, shapeIds }, event.shiftKey || event.ctrlKey || event.metaKey)}>{`Profile ${index + 1}`}</button>
                <span className={styles.treeMeta}>{loop.name}</span>
              </li>
            );
          })}
          {feature.kind === 'revolve' && feature.axisRef && <FeatureDriverRows feature={{ ...feature, profileShapes: [] }} depth={depth} onSelect={onSelect} sketches={sketches} />}
          {feature.kind === 'sweep' && <FeatureDriverRows feature={{ ...feature, profileShapes: [] }} depth={depth} onSelect={onSelect} sketches={sketches} />}
        </>
      );
    }
  }
  const refs: { label: string; ref: { sketchId: string; shapeIds: string[] } }[] = [];
  if ((feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') && feature.profileShapes?.length) refs.push({ label: 'Profile', ref: { sketchId: feature.profile, shapeIds: feature.profileShapes } });
  if (feature.kind === 'revolve' && feature.axisRef) refs.push({ label: 'Axis', ref: feature.axisRef });
  if (feature.kind === 'sweep') refs.push({ label: 'Path', ref: feature.path });
  return refs.map(({ label, ref }) => (
    <li key={`${feature.id}-${label}`} className={styles.treeRow} style={{ paddingInlineStart: depth }}>
      <span className={styles.treeToggle} />
      <Spline size={11} className="u-muted" />
      <button type="button" className={styles.treeName} onClick={(event) => onSelect(ref.shapeIds.length === 1 ? { kind: 'shape', sketchId: ref.sketchId, shapeId: ref.shapeIds[0]! } : { kind: 'loop', sketchId: ref.sketchId, loopIndex: 0, shapeIds: ref.shapeIds }, event.shiftKey || event.ctrlKey || event.metaKey)}>{label}</button>
      <span className={styles.treeMeta}>linked · editable</span>
    </li>
  ));
}

const OP_WORDS = { new: '', add: 'Add', cut: 'Cut' } as const;

function featureLabel(feature: Feature, sketches: Sketch[], bodies: Body[]): string {
  if (feature.name) return feature.name;
  switch (feature.kind) {
    case 'primitive':
      return PRIMITIVE_LABELS[feature.shape];
    case 'mesh':
      return 'Converted solid';
    case 'extrude': {
      const sketch = findSketch(sketches, feature.profile);
      const isFace = feature.profile.startsWith('sketch-face-') || sketch?.name?.includes('face');
      if (isFace) {
        return `Push/pull ${feature.op === 'cut' ? 'cut' : 'add'} ${Math.abs(feature.distance)} mm`;
      }
      const profiles = sketch && feature.profileShapes?.length ? profileLoops(sketch, feature.profileShapes).length : 1;
      return `${OP_WORDS[feature.op] || 'Extrude'} ${sketch?.name ?? '?'}${profiles > 1 ? ` · ${profiles} profiles` : ''} ${feature.distance} mm`;
    }
    case 'revolve':
      return `${OP_WORDS[feature.op] || 'Revolve'} ${findSketch(sketches, feature.profile)?.name ?? '?'} ${feature.angle}°`;
    case 'sweep':
      return `${OP_WORDS[feature.op] || 'Sweep'} ${findSketch(sketches, feature.profile)?.name ?? '?'}`;
    case 'mirror':
      return `Mirror ${feature.axis.toUpperCase()} at ${feature.offset}`;
    case 'pattern':
      return `${feature.mode === 'linear' ? 'Linear' : 'Radial'} pattern × ${feature.count}`;
    case 'boolean':
      return `${BOOLEAN_OPTIONS.find((option) => option.value === feature.op)?.label} ${findBody(bodies, feature.tool)?.name ?? '?'}`;
    case 'transform':
      return 'Transform';
    case 'direct-edit':
      return feature.points.length > 1 ? 'Move edge' : 'Move vertex';
    case 'smooth':
      return `Smooth × ${feature.level}`;
    case 'face-material':
      return `Face material · ${feature.material}`;
  }
}

function featureTitle(feature: Feature): string {
  switch (feature.kind) {
    case 'primitive':
      return 'Primitive';
    case 'mesh':
      return 'Independent solid';
    case 'extrude':
      return 'Extrude';
    case 'revolve':
      return 'Revolve';
    case 'sweep':
      return 'Sweep';
    case 'mirror':
      return 'Mirror';
    case 'pattern':
      return 'Pattern';
    case 'boolean':
      return 'Boolean';
    case 'transform':
      return 'Transform';
    case 'direct-edit':
      return 'Direct edit';
    case 'smooth':
      return 'Smooth';
    case 'face-material':
      return 'Face material';
  }
}

function shapeLabel(shape: Shape2D): string {
  if (shape.name) return shape.name;
  switch (shape.kind) {
    case 'rect':
      return `Rectangle ${Math.round(shape.width)} × ${Math.round(shape.height)}`;
    case 'circle':
      return `Circle ⌀${Math.round(shape.radius * 2)}`;
    case 'polygon':
      return `${shape.sides}-gon r${Math.round(shape.radius)}`;
    case 'polyline': {
      // Pen curves and ellipses (handles), arcs (bulges), else straight lines.
      if (shape.handles?.some(Boolean)) return shape.closed === false ? `Curve (${shape.points.length} points)` : shape.points.length === 4 && shape.handles.every(Boolean) ? 'Ellipse' : `Closed curve (${shape.points.length} points)`;
      if (shape.closed === false && shape.points.length === 2 && shape.bulges?.[0]) return `Arc R${Math.round(bulgeArc(shape.points[0]!, shape.points[1]!, shape.bulges[0]).r)}`;
      return `${shape.closed === false ? 'Line' : 'Polyline'} (${shape.points.length} points)`;
    }
  }
}

function ShapeIcon({ shape, size = 13 }: { shape: PrimitiveShape | null; size?: number }) {
  const className = 'u-muted';
  if (shape === 'cylinder') return <Cylinder size={size} className={className} />;
  if (shape === 'sphere') return <Circle size={size} className={className} />;
  if (shape === 'cone') return <Cone size={size} className={className} />;
  return <Box size={size} className={className} />;
}

function shapeOf(body: Body): PrimitiveShape | null {
  const first = body.features[0];
  return first?.kind === 'primitive' ? first.shape : null;
}

/** Puts a new primitive beside what is already modeled so shapes do not start on top of each other. */
function nextPosition(shape: PrimitiveShape): [number, number, number] {
  const bounds = modelingScene.bounds();
  if (!bounds) return [0, 0, 0];
  return [Math.round(bounds.max.x + PRIMITIVE_SIZES[shape][0] / 2 + 100), 0, 0];
}

/** Asset id and name from the URL (`?asset=…&name=…&project=…`, also accepted after `#/modeling`). */
function routeParams(): { assetId: string; name: string | null; projectId: string | null } {
  const search = window.location.search || window.location.hash.slice(window.location.hash.indexOf('?'));
  const params = new URLSearchParams(search.startsWith('?') ? search : '');
  return {
    assetId: params.get('asset') ?? `asset-${Date.now().toString(36)}`,
    name: params.get('name'),
    projectId: params.get('project'),
  };
}

function openAppPath(path: string): void {
  if (window.location.protocol === 'file:') window.location.hash = path;
  else window.location.assign(path);
}

function newLayerId(): string {
  return `layer-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---- panels ---------------------------------------------------------------------------------


/** The GLB node tree with a low-LOD checkbox per node (a parent flags its whole subtree). */
function LodNodes({ layer, nodes, depth }: { layer: Layer; nodes: LayerNode[]; depth: number }) {
  const setNodeLowLod = useModeling((s) => s.setNodeLowLod);
  if (nodes.length === 0) return null;
  return (
    <ul className={styles.lodList}>
      {nodes.map((node) => (
        <li key={node.id}>
          <label className={styles.lodRow} style={{ paddingInlineStart: 4 + depth * 14 }}>
            <input type="checkbox" checked={node.lowLod} onChange={(event) => setNodeLowLod(layer.id, node.id, event.target.checked)} />
            <span>{node.name}</span>
            {node.triangles > 0 && <span className={styles.treeMeta}>{node.triangles.toLocaleString()} tri</span>}
          </label>
          <LodNodes layer={layer} nodes={node.children} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

function AssetPanel() {
  const metadata = useModeling((s) => s.metadata);
  const [width, height, depth] = useModeling((s) => s.modelSize);
  const set = useModeling((s) => s.setMetadata);
  const layers = useModeling((s) => s.layers);
  const bodies = useModeling((s) => s.bodies);
  const updateLayer = useModeling((s) => s.updateLayer);
  const updateBody = useModeling((s) => s.updateBody);
  return (
    <Panel title="Asset" defaultOpen={false}>
      <Field label="Name">
        <TextField value={metadata.name} placeholder="e.g. Lounge chair" onCommit={(name) => set({ name })} ariaLabel="Asset name" />
      </Field>
      <Field label="Package ID">
        <TextField value={metadata.id} placeholder="lounge-chair" onCommit={(id) => set({ id })} ariaLabel="Package id" />
      </Field>
      <Field label="Category">
        <SelectField value={metadata.category} options={CATEGORY_OPTIONS} onChange={(category) => set({ category })} ariaLabel="Category" />
      </Field>
      <div className={styles.sizeRow} title="Measured from the visible model">
        <span className={styles.sizeLabel}>Size</span>
        <span className={styles.sizeValue}>{width > 0 ? `${width} × ${depth} × ${height} mm` : '— (import or model something)'}</span>
      </div>
      <Field label="Tags">
        <TextField value={metadata.tags} placeholder="wood, modern" onCommit={(tags) => set({ tags })} ariaLabel="Tags" />
      </Field>
      <div className={styles.lodSection}>
        <div className={styles.lodTitle}>Levels of detail</div>
        <p className={styles.empty}>High packages every visible layer. Tick the layers that make the low version (a simpler model for boards on low LOD).</p>
        {layers.length === 0 && bodies.length === 0 ? (
          <p className={styles.empty}>No layers or bodies yet.</p>
        ) : (
          <ul className={styles.lodList}>
            {bodies.map((body) => (
              <li key={body.id}>
                <label className={styles.lodRow}>
                  <input type="checkbox" checked={body.lowLod} onChange={(event) => updateBody(body.id, { lowLod: event.target.checked })} />
                  <span>{body.name}</span>
                  <span className={styles.treeMeta}>{body.lowLod ? 'high + low' : 'high only'}</span>
                </label>
              </li>
            ))}
            {layers.map((layer) => (
              <li key={layer.id}>
                <label className={styles.lodRow}>
                  <input type="checkbox" checked={layer.lowLod} onChange={(event) => updateLayer(layer.id, { lowLod: event.target.checked })} />
                  <span>{layer.name}</span>
                  <span className={styles.treeMeta}>{layer.lowLod ? 'high + low' : 'high only'}</span>
                </label>
                <LodNodes layer={layer} nodes={layer.nodes} depth={1} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** Picks a tool. Sketching is projected onto the active work plane from every view. */
function useSelectTool() {
  return useCallback((tool: Tool) => {
    const state = modelingStore.getState();
    if (SKETCH_TOOLS.includes(tool) && !state.sketchEdit) {
      const activeSketchId = selectedSketchId(state.selection, state.bodies);
      const activeSketch = activeSketchId ? findSketch(state.sketches, activeSketchId) : null;
      // Views only change what is seen: drawing always goes on the work plane.
      const drawingPlane: SketchPlane = state.workPlane;

      if (!activeSketch || !samePlane(activeSketch.plane, drawingPlane)) {
        const sketchOnPlane = state.sketches.find((s) => samePlane(s.plane, drawingPlane));
        if (sketchOnPlane) {
          state.select({ kind: 'sketch', id: sketchOnPlane.id });
        } else {
          // Drawing needs a sketch on the work plane: make one (no question to answer first).
          const newSketchId = state.addSketch(drawingPlane);
          state.select({ kind: 'sketch', id: newSketchId });
        }
      }
    }
    state.setTool(tool);
  }, []);
}

function inspectSelectedLoop(state: ModelingState): void {
  const sketchId = selectedSketchId(state.selection, state.bodies);
  const sketch = sketchId ? findSketch(state.sketches, sketchId) : null;
  const seedId = state.selection?.kind === 'shape' ? state.selection.shapeId : sketch?.shapes[0]?.id;
  if (!sketch || !seedId) {
    state.setLoopCheck(null);
    return;
  }
  const check = checkLineLoop(sketch.shapes, seedId);
  if (!check) {
    state.setLoopCheck(null);
    return;
  }
  const openingCount = check.openings.length;
  state.setLoopCheck({
    sketchId: sketch.id,
    shapeIds: check.shapeIds,
    closed: check.closed,
    openings: check.openings,
    message: check.closed ? 'Closed loop · ready to extrude' : `${openingCount || 1} ${openingCount === 1 ? 'opening' : 'openings'} · close the red endpoints before extruding`,
  });
}

/** Snap kinds the user can switch off one by one (Snaps popover). */
const SNAP_TYPES: [InferenceType, string][] = [
  ['endpoint', 'End points'],
  ['midpoint', 'Midpoints'],
  ['center', 'Centres'],
  ['quadrant', 'Quadrants'],
  ['edge-intersection', 'Intersections'],
  ['point-on-edge', 'Nearest on curve'],
  ['perpendicular', 'Perpendicular'],
  ['tangent', 'Tangent'],
  ['extension', 'Extensions'],
  ['alignment', 'Alignment'],
];

/** The letters typed last, for two-letter tool shortcuts. */
const keySequence = { keys: '', at: 0 };

const TOOL_GROUPS: { label: string; icon: ReactNode; tools: Tool[] }[] = [
  { label: 'Select', icon: <MousePointer2 size={19} />, tools: ['select'] },
  { label: 'Draw', icon: <Pencil size={19} />, tools: ['line', 'rect', 'circle', 'polygon', 'polyline', 'arc', 'ellipse', 'spline', 'freehand', 'knife', 'pickline'] },
  { label: 'Edit curves', icon: <Scissors size={19} />, tools: ['smove', 'scopy', 'srotate', 'smirror', 'sscale', 'offset', 'trim', 'extend', 'split', 'fillet'] },
  { label: 'Transform', icon: <Move3d size={19} />, tools: [] },
  { label: 'Parametric', icon: <Spline size={19} />, tools: ['extrude', 'revolve', 'sweep'] },
  { label: 'Independent solids', icon: <Box size={19} />, tools: ['pushpull'] },
  { label: 'Modify', icon: <Combine size={19} />, tools: ['mirror', 'pattern', 'boolean', 'paint'] },
];

/** Compact canvas-side toolbar. Tool options stay contextual above the viewport. */
function CanvasToolbar({ viewportRef }: { viewportRef: React.RefObject<ModelingViewport | null> }) {
  const tool = useModeling((s) => s.tool);
  const selectTool = useSelectTool();
  const addPrimitive = useModeling((s) => s.addPrimitive);
  const gizmoMode = useModeling((s) => s.gizmoMode);
  const setGizmoMode = useModeling((s) => s.setGizmoMode);
  const settingWorkPlane = useModeling((s) => s.settingWorkPlane);
  const workPlaneMode = useModeling((s) => s.workPlaneMode);
  const startSettingWorkPlane = useModeling((s) => s.startSettingWorkPlane);
  const cancelSettingWorkPlane = useModeling((s) => s.cancelSettingWorkPlane);
  // One flyout at a time: opening a group closes the others; a click elsewhere closes it.
  const navRef = useRef<HTMLElement | null>(null);
  const onGroupToggle = (event: React.SyntheticEvent<HTMLDetailsElement>) => {
    const opened = event.currentTarget;
    if (!opened.open) return;
    navRef.current?.querySelectorAll('details[open]').forEach((other) => {
      if (other !== opened) other.removeAttribute('open');
    });
  };
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const nav = navRef.current;
      if (!nav || nav.contains(event.target as Node)) return;
      nav.querySelectorAll('details[open]').forEach((open) => open.removeAttribute('open'));
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);
  return (
    <nav ref={navRef} className={styles.canvasToolbar} aria-label="Modeling tools">
      {TOOL_GROUPS.map((group) => {
        const active = group.tools.includes(tool);
        return (
          <details key={group.label} className={styles.toolGroup} data-active={active || undefined} onToggle={onGroupToggle}>
            <summary title={group.label} aria-label={group.label}>{group.icon}<span className={styles.touchToolLabel}>{group.label === 'Independent solids' ? 'Solids' : group.label === 'Parametric' ? 'Build' : group.label}</span></summary>
            <div className={styles.toolFlyout}>
              <strong>{group.label}</strong>
              {group.tools.map((item) => (
                <button key={item} type="button" aria-label={TOOL_LABELS[item]} data-testid={`tool-${item}`} data-active={tool === item || undefined} onClick={(event) => { selectTool(item); (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); }}>
                  <ToolIcon tool={item} size={16} /><span>{TOOL_LABELS[item]}</span><kbd>{TOOL_KEYS[item]}</kbd>
                </button>
              ))}
              {group.label === 'Transform' && (
                <>
                  <button type="button" aria-label="Move" data-active={gizmoMode === 'translate' || undefined} onClick={(event) => { selectTool('select'); setGizmoMode('translate'); (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); }}><Move3d size={16} /><span>Move</span><kbd>G</kbd></button>
                  <button type="button" aria-label="Rotate" data-active={gizmoMode === 'rotate' || undefined} onClick={(event) => { selectTool('select'); setGizmoMode('rotate'); (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); }}><Rotate3d size={16} /><span>Rotate</span><kbd>T</kbd></button>
                  <button type="button" aria-label="Scale" data-active={gizmoMode === 'scale' || undefined} onClick={(event) => { selectTool('select'); setGizmoMode('scale'); (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); }}><SquareDashed size={16} /><span>Scale</span><kbd>S</kbd></button>
                  <span className={styles.optionText}>X cycles Move → Rotate → Scale</span>
                </>
              )}
              {group.label === 'Independent solids' && PRIMITIVE_SHAPES.map((shape) => (
                <button key={shape} type="button" aria-label={`Add ${PRIMITIVE_LABELS[shape]}`} data-testid={`add-${shape}`} onClick={() => addPrimitive(shape, nextPosition(shape))}><ShapeIcon shape={shape} size={16} /><span>{PRIMITIVE_LABELS[shape]}</span></button>
              ))}
            </div>
          </details>
        );
      })}
      <details className={styles.toolGroup} data-active={settingWorkPlane || undefined} onToggle={onGroupToggle}>
        <summary title="Work plane" aria-label="Work plane"><PencilRuler size={19} /><span className={styles.touchToolLabel}>Plane</span></summary>
        <div className={styles.toolFlyout}>
          <strong>Set work plane</strong>
          <button
            type="button"
            data-active={(settingWorkPlane && workPlaneMode === 'surface') || undefined}
            onClick={(event) => {
              startSettingWorkPlane('surface');
              (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
            }}
          >
            <Focus size={16} /><span>Surface / Face</span>
          </button>
          <button
            type="button"
            data-active={(settingWorkPlane && workPlaneMode === 'plane') || undefined}
            onClick={(event) => {
              startSettingWorkPlane('plane');
              (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
            }}
          >
            <Layers size={16} /><span>Reference plane</span>
          </button>
          <button
            type="button"
            data-active={(settingWorkPlane && workPlaneMode === '3points') || undefined}
            onClick={(event) => {
              startSettingWorkPlane('3points');
              (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
            }}
          >
            <Target size={16} /><span>3 Points (Origin, X, Plane)</span>
          </button>
          {settingWorkPlane && (
            <button
              type="button"
              onClick={(event) => {
                cancelSettingWorkPlane();
                (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
              }}
              style={{ color: 'var(--danger, #ff4d4f)' }}
            >
              <X size={16} /><span>Cancel placement</span>
            </button>
          )}
        </div>
      </details>
      <span className={styles.toolbarSpacer} />
      <button type="button" className={styles.toolbarButton} title="Zoom extents" aria-label="Zoom extents" onClick={() => viewportRef.current?.frameAll()}><Focus size={19} /></button>
    </nav>
  );
}

/** The status instruction for a finger: gestures instead of clicks and held keys. */
function touchInstruction(tool: Tool, text: string): string {
  if (tool === 'select') return 'Tap to select · Add toggles more · Select area for a box · drag the gizmo to transform.';
  return text.replace(/[Rr]ight-click/g, 'long-press').replace(/Double-click/g, 'Double-tap').replace(/Click/g, 'Tap').replace(/click/g, 'tap');
}

function toolInstruction(tool: Tool, settingWorkPlane: boolean, workPlaneMode: WorkPlaneSetupMode = 'surface', pointsCount = 0): string {
  if (settingWorkPlane) {
    if (workPlaneMode === 'surface') return 'Click a solid body face or imported surface. Camera stays unchanged.';
    if (workPlaneMode === 'plane') return 'Click a reference plane (Top, Front, Side) or pick one in the top bar.';
    if (workPlaneMode === '3points') {
      if (pointsCount === 0) return 'Click 1st point: Origin (P1). Snaps to vertices, surfaces and grid.';
      if (pointsCount === 1) return 'Click 2nd point: X-Axis direction (P2).';
      return 'Click 3rd point: Plane orientation (P3).';
    }
  }
  if (tool === 'select') return 'Click to select · Ctrl/Shift-click adds · drag empty space for box selection · drag gizmo to transform.';
  if (tool === 'line') return 'Click first point, then endpoint or type a length.';
  if (tool === 'knife') return 'Click two points to add a splitting segment on the active sketch surface.';
  if (tool === 'polyline' || tool === 'arc') return 'Click points. Enter completes; Backspace removes the last point.';
  if (tool === 'rect') return 'Click first corner, then opposite corner or type width,height.';
  if (tool === 'circle' || tool === 'polygon') return 'Click center, then radius or type an exact value.';
  if (tool === 'ellipse') return 'Click the centre, the end of one axis, then the other radius (or type it).';
  if (tool === 'spline') return 'Click for corners, press and drag for smooth points · click the first point to close · Enter finishes.';
  if (tool === 'pushpull') return 'Select a face, then drag or enter a distance.';
  if (tool === 'extrude' || tool === 'revolve') return 'Select a closed profile, preview, then press Enter.';
  return `${TOOL_LABELS[tool]} · follow the preview and click to commit.`;
}

function StatusBar({ viewportRef }: { viewportRef: React.RefObject<ModelingViewport | null> }) {
  const { isTouch } = useTouchMode();
  const tool = useModeling((s) => s.tool);
  const settingWorkPlane = useModeling((s) => s.settingWorkPlane);
  const workPlaneMode = useModeling((s) => s.workPlaneMode);
  const workPlanePoints = useModeling((s) => s.workPlanePoints);
  const preview = useModeling((s) => s.sketchPreview);
  const loopCheck = useModeling((s) => s.loopCheck);
  const numericEntry = useModeling((s) => s.numericEntry);
  const setNumericEntry = useModeling((s) => s.setNumericEntry);
  const settings = useModeling((s) => s.inferenceSettings);
  const setSettings = useModeling((s) => s.setInferenceSettings);
  const lastReusedNotice = useModeling((s) => s.lastReusedNotice);
  const clearLastReusedNotice = useModeling((s) => s.clearLastReusedNotice);

  useEffect(() => {
    if (!lastReusedNotice) return;
    const timer = setTimeout(() => {
      clearLastReusedNotice();
    }, 2500);
    return () => clearTimeout(timer);
  }, [lastReusedNotice, clearLastReusedNotice]);

  const commitMeasurement = () => {
    const tools = viewportRef.current?.tools;
    if (tools?.sketch.active) tools.sketch.keyDown({ key: 'Enter' });
    else if ((tool === 'extrude' || tool === 'pushpull' || tool === 'revolve') && tools) {
      const value = Number(numericEntry);
      const state = modelingStore.getState();
      if (Number.isFinite(value) && value !== 0) {
        if (tool === 'revolve') state.setToolOptions({ revolve: { ...state.toolOptions.revolve, angle: Math.min(360, Math.abs(value)) } });
        else state.setToolOptions({ extrude: { ...state.toolOptions.extrude, distance: value } });
      }
      state.setNumericEntry('');
      tools.solid.commit();
    }
  };
  return (
    <footer className={styles.statusBar} data-testid="status-bar">
      <span className={styles.statusInstruction} data-loop={loopCheck ? (loopCheck.closed ? 'closed' : 'open') : undefined}>
        {lastReusedNotice ? (
          <strong style={{ color: 'var(--accent)' }}>⚡ {lastReusedNotice}</strong>
        ) : (
          loopCheck?.message ?? (isTouch ? touchInstruction(tool, toolInstruction(tool, settingWorkPlane, workPlaneMode, workPlanePoints.length)) : toolInstruction(tool, settingWorkPlane, workPlaneMode, workPlanePoints.length))
        )}
      </span>
      {isTouch ? (
        <span className={styles.modifierHints}>Two fingers pan · pinch to zoom · long-press a camera for its menu</span>
      ) : (
        <span className={styles.modifierHints}>Ctrl+Shift+Alt = check loop · Double right-click = repeat · Shift = lock · Alt = disable snaps · Esc = cancel</span>
      )}
      <details className={styles.snapPopover}>
        <summary>{settings.enabled ? (preview?.inference?.label ?? (preview?.snap ? 'Snapped' : 'Snaps on')) : 'Snaps off'}</summary>
        <div className={styles.snapMenu}>
          <strong>Snapping & inference</strong>
          {([['geometry', 'Geometry'], ['inference', 'Inference'], ['grid', 'Grid'], ['guides', 'Guides'], ['workPlane', 'Work plane']] as const).map(([key, label]) => (
            <label key={key}><input type="checkbox" checked={settings[key]} onChange={(event) => setSettings({ [key]: event.target.checked })} /> {label}</label>
          ))}
          <label>Tolerance <input type="range" min="3" max="24" value={settings.tolerance} onChange={(event) => setSettings({ tolerance: Number(event.target.value) })} /> {settings.tolerance}px</label>
          <strong>Snap to</strong>
          {SNAP_TYPES.map(([type, label]) => (
            <label key={type}><input type="checkbox" checked={!settings.disabledTypes[type]} onChange={(event) => setSettings({ disabledTypes: { ...settings.disabledTypes, [type]: !event.target.checked } })} data-testid={`snap-${type}`} /> {label}</label>
          ))}
        </div>
      </details>
      <label className={styles.measurements}><span>Measurements</span><input value={numericEntry} placeholder="Type a value" onChange={(event) => setNumericEntry(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitMeasurement(); } else if (event.key === 'Escape') setNumericEntry(''); }} /></label>
      {isTouch && <TextButton disabled={!numericEntry.trim()} onClick={commitMeasurement}>Apply</TextButton>}
    </footer>
  );
}

/**
 * Sketch edit mode (Revit's Edit Boundary): the edited sketch, Finish (one undo step) and
 * Cancel (restore), plus a summary of what the curves would extrude to.
 */
function SketchEditBar() {
  const session = useModeling((s) => s.sketchEdit);
  const sketches = useModeling((s) => s.sketches);
  const finish = useModeling((s) => s.finishSketchEdit);
  const cancel = useModeling((s) => s.cancelSketchEdit);
  const past = useModeling((s) => s.past.length);
  if (!session) return null;
  const sketch = findSketch(sketches, session.sketchId);
  if (!sketch) return null;
  const arrangement = arrangeSketch(sketch.shapes);
  const edits = Math.max(0, past - session.base);
  const status = arrangement.faces.length
    ? `${arrangement.faces.filter((face) => face.solid).length} closed region${arrangement.faces.length === 1 ? '' : 's'}${arrangement.faces.some((face) => face.holes.length) ? ` · ${arrangement.faces.reduce((n, face) => n + face.holes.length, 0)} opening(s)` : ''}`
    : sketch.shapes.length ? 'no closed loop yet' : 'empty';
  return (
    <div className={styles.optionsBar} style={{ background: 'color-mix(in srgb, #16a36a 10%, var(--bg-panel))', borderColor: '#16a36a' }} data-testid="sketch-edit-bar">
      <span className={styles.optionsTool} style={{ color: '#16a36a' }}>
        <PencilRuler size={15} /> Editing {sketch.name}
      </span>
      <span className={styles.optionText} data-testid="sketch-edit-status">
        {sketch.shapes.length} curve{sketch.shapes.length === 1 ? '' : 's'} · {status}
        {arrangement.openEnds.length > 0 && arrangement.faces.length > 0 ? ` · ${arrangement.openEnds.length} loose end${arrangement.openEnds.length === 1 ? '' : 's'}` : ''}
        {edits > 0 ? ` · ${edits} change${edits === 1 ? '' : 's'}` : ''}
      </span>
      <span className={styles.optionText}>Draw and edit curves; everything else is locked. Enter finishes.</span>
      <TextButton primary onClick={finish} data-testid="sketch-edit-finish" title="Finish editing (Enter): keep the changes as one undo step">
        <Check size={13} /> Finish
      </TextButton>
      <TextButton onClick={cancel} data-testid="sketch-edit-cancel" title="Cancel editing: discard every change made since entering the sketch">
        <X size={13} /> Cancel
      </TextButton>
    </div>
  );
}

/**
 * Editable dimensions of the selected curve (Revit's temporary dimensions, in the options bar):
 * a line's length and angle, a rectangle's size, a circle's radius, a selected point's X / Y.
 * Typing a value reshapes the curve (one undo step).
 */
function CurveDimensions({ sketchId, shape, pointIndex }: { sketchId: string; shape: Shape2D; pointIndex: number | null }) {
  const updateShape = useModeling((s) => s.updateShape);
  const set = (next: Shape2D) => updateShape(sketchId, next);
  const field = (label: string, value: number, onCommit: (value: number) => void, unit: 'mm' | undefined = 'mm', precision = 1) => (
    <label className={styles.option} key={label}>
      {label}
      <NumberField value={Math.round(value * 10 ** precision) / 10 ** precision} unit={unit} precision={precision} onCommit={onCommit} ariaLabel={`Curve ${label.toLowerCase()}`} />
    </label>
  );
  if (shape.kind === 'polyline' && pointIndex !== null && shape.points[pointIndex]) {
    const [x, y] = shape.points[pointIndex]!;
    const move = (point: Vec2) => set({ ...shape, points: shape.points.map((item, index) => (index === pointIndex ? point : item)) });
    return <>{field('X', x, (value) => move([value, y]))}{field('Y', y, (value) => move([x, value]))}</>;
  }
  if (shape.kind === 'polyline' && shape.closed === false && shape.points.length === 2 && !shape.bulges?.some((bulge) => bulge)) {
    const [a, b] = shape.points as [Vec2, Vec2];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const place = (len: number, deg: number) => {
      const rad = (deg * Math.PI) / 180;
      set({ ...shape, points: [a, [a[0] + Math.cos(rad) * len, a[1] + Math.sin(rad) * len]] });
    };
    return <>{field('Length', length, (value) => value > 0 && place(value, angle))}{field('Angle °', angle, (value) => place(length, value), undefined)}</>;
  }
  const arcBulge = shape.kind === 'polyline' && shape.closed === false && shape.points.length === 2 && !shape.handles?.[0] ? (shape.bulges?.[0] ?? 0) : 0;
  if (shape.kind === 'polyline' && arcBulge) {
    // An arc: its radius (the ends stay, it bows more or less) and its angle (start and centre stay).
    const [a, b] = shape.points as [Vec2, Vec2];
    const arc = bulgeArc(a, b, arcBulge);
    const degrees = (Math.abs(arc.sweep) * 180) / Math.PI;
    const direction = Math.sign(arc.sweep) || 1;
    const setRadius = (radius: number) => {
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (radius < chord / 2 - 1e-9) return;
      let theta = 2 * Math.asin(Math.min(1, chord / (2 * radius)));
      if (Math.abs(arc.sweep) > Math.PI) theta = Math.PI * 2 - theta;
      set({ ...shape, bulges: [direction * Math.tan(theta / 4)] });
    };
    const setAngle = (value: number) => {
      if (!(value > 0 && value < 360)) return;
      const sweep = ((direction * value) * Math.PI) / 180;
      const end: Vec2 = [arc.c[0] + Math.cos(arc.start + sweep) * arc.r, arc.c[1] + Math.sin(arc.start + sweep) * arc.r];
      set({ ...shape, points: [a, end], bulges: [Math.tan(sweep / 4)] });
    };
    return <>{field('Radius', arc.r, (value) => value > 0 && setRadius(value))}{field('Angle °', degrees, setAngle, undefined)}<span className={styles.optionText}>Arc length {Math.round(arc.r * Math.abs(arc.sweep) * 10) / 10} mm</span></>;
  }
  if (shape.kind === 'rect') {
    return <>{field('Width', shape.width, (width) => width > 0 && set({ ...shape, width }))}{field('Height', shape.height, (height) => height > 0 && set({ ...shape, height }))}</>;
  }
  if (shape.kind === 'circle') return field('Radius', shape.radius, (radius) => radius > 0 && set({ ...shape, radius }));
  if (shape.kind === 'polygon') return <>{field('Radius', shape.radius, (radius) => radius > 0 && set({ ...shape, radius }))}{field('Rotation °', shape.rotation, (rotation) => set({ ...shape, rotation }), undefined)}</>;
  return null;
}

/** The strip above the panes: the active tool's parameters, snapping and the numeric entry. */
function OptionsBar({ viewportRef }: { viewportRef: React.RefObject<ModelingViewport | null> }) {
  const sketchEdit = useModeling((s) => s.sketchEdit);
  const enterSketchEdit = useModeling((s) => s.enterSketchEdit);
  useModeling((s) => s.modifyProgress);
  const hasCurveSelection = useModeling((s) => (s.selectionSet.length ? s.selectionSet : s.selection ? [s.selection] : []).some((item) => item.kind === 'shape' || item.kind === 'curve-point' || item.kind === 'loop'));
  const tool = useModeling((s) => s.tool);
  const setTool = useModeling((s) => s.setTool);
  const options = useModeling((s) => s.toolOptions);
  const setToolOptions = useModeling((s) => s.setToolOptions);
  const numericEntry = useModeling((s) => s.numericEntry);
  const sketches = useModeling((s) => s.sketches);
  const bodies = useModeling((s) => s.bodies);
  const materials = useModeling((s) => s.materials);
  const selection = useModeling((s) => s.selection);
  const gizmoMode = useModeling((s) => s.gizmoMode);
  const addSketch = useModeling((s) => s.addSketch);
  const activePane = useModeling((s) => s.activePane);
  const panes = useModeling((s) => s.panes);
  const planes = useModeling((s) => s.planes);
  const workPlane = useModeling((s) => s.workPlane);
  const sketchId = selectedSketchId(selection, bodies);
  const sketch = sketchId ? findSketch(sketches, sketchId) : null;
  const paneView = panes[activePane]!;
  const drawingPlane = workPlane;
  const viewPlane = viewPlaneOf(paneView, { planes, workPlane });
  const edgeOn = viewPlane !== null && Math.abs(dot(planeFrame(viewPlane).normal, planeFrame(workPlane).normal)) < 0.02;
  const sketching = SKETCH_TOOLS.includes(tool);
  const materialOptions = Object.entries(materials)
    .map(([value, material]) => ({ value, label: material.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const bodyOptions = bodies.map((body) => ({ value: body.id, label: body.name }));
  const extrude = options.extrude;
  const setExtrude = (patch: Partial<typeof extrude>) => setToolOptions({ extrude: { ...extrude, ...patch } });
  const revolve = options.revolve;
  const setRevolve = (patch: Partial<typeof revolve>) => setToolOptions({ revolve: { ...revolve, ...patch } });
  const sweep = options.sweep;
  const setSweep = (patch: Partial<typeof sweep>) => setToolOptions({ sweep: { ...sweep, ...patch } });
  const extrudeParts = tool === 'extrude' ? resolveExtrudeParts(sketches, extrude) : [];
  const extrudeSummary = summarizeExtrude(extrudeParts);
  const extrudeProfileReady = extrudeParts.length > 0;
  const extrudeProfileClosed = extrudeSummary.solids > 0;
  // What "Fix" would do for each group: close gaps, drop duplicates, trim overshooting tails.
  const extrudeFixes = extrudeParts.flatMap((part) => {
    if (!part.closed && part.arrangement.openEnds.length === 0) return [];
    const inGroup = part.sketch.shapes.filter((shape) => part.group.shapeIds.includes(shape.id));
    const bounds = shapesBounds(inGroup);
    const diagonal = bounds ? Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) : 0;
    const fix = fixProfile(inGroup, Math.max(options.grid || 0, 10, diagonal * 0.03), newShapeId);
    return fix.joined || fix.removed || fix.trimmed ? [{ part, fix }] : [];
  });
  const fixCounts = extrudeFixes.reduce((sum, { fix }) => ({ joined: sum.joined + fix.joined, removed: sum.removed + fix.removed, trimmed: sum.trimmed + fix.trimmed }), { joined: 0, removed: 0, trimmed: 0 });
  const fixLabel = [fixCounts.joined && `close ${fixCounts.joined} gap${fixCounts.joined === 1 ? '' : 's'}`, fixCounts.trimmed && `trim ${fixCounts.trimmed} tail${fixCounts.trimmed === 1 ? '' : 's'}`, fixCounts.removed && `remove ${fixCounts.removed} duplicate${fixCounts.removed === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const healProfiles = () => {
    const changes: Record<string, Shape2D[]> = {};
    const profiles = extrude.profiles.map((group) => ({ ...group }));
    for (const { part, fix } of extrudeFixes) {
      const kept = new Set(fix.shapes.map((shape) => shape.id));
      const others = part.sketch.shapes.filter((shape) => !part.group.shapeIds.includes(shape.id));
      changes[part.sketch.id] = [...others, ...fix.shapes];
      const group = profiles.find((item) => item.sketchId === part.sketch.id);
      if (group) {
        group.shapeIds = [...kept];
        delete group.regions;
      }
    }
    if (!Object.keys(changes).length) return;
    const store = modelingStore.getState();
    store.setSketchShapes(changes);
    store.setToolOptions({ extrude: { ...store.toolOptions.extrude, profiles, profile: profiles[0] ?? null } });
  };
  const revolveAxisReady = Boolean(revolve.axisRef && !curveRefIsClosed(sketches, revolve.axisRef));
  const revolveProfileReady = Boolean(revolve.profile && curveRefIsClosed(sketches, revolve.profile));
  const sweepPathReady = Boolean(sweep.path && !curveRefIsClosed(sketches, sweep.path));
  const sweepProfileReady = Boolean(sweep.profile && curveRefIsClosed(sketches, sweep.profile));
  const mirror = options.mirror;
  const setMirror = (patch: Partial<typeof mirror>) => setToolOptions({ mirror: { ...mirror, ...patch } });
  const pattern = options.pattern;
  const setPattern = (patch: Partial<typeof pattern>) => setToolOptions({ pattern: { ...pattern, ...patch } });
  const boolean = options.boolean;
  const setBoolean = (patch: Partial<typeof boolean>) => setToolOptions({ boolean: { ...boolean, ...patch } });
  const addFeature = useModeling((s) => s.addFeature);
  const updateBody = useModeling((s) => s.updateBody);
  const updateSketch = useModeling((s) => s.updateSketch);
  const selectedBody = selection?.kind === 'body' ? findBody(bodies, selection.id) : selection?.kind === 'feature' ? findBody(bodies, selection.bodyId) : null;
  const targetValue = (target: string | null) => (target && bodies.some((body) => body.id === target) ? target : (bodies[bodies.length - 1]?.id ?? ''));
  const applyMirror = () => {
    if (!selectedBody) return;
    addFeature(selectedBody.id, { kind: 'mirror', id: newFeatureId(), axis: mirror.axis, offset: mirror.offset, keepOriginal: mirror.keepOriginal });
    setTool('select');
  };
  const applyPattern = () => {
    if (!selectedBody) return;
    addFeature(selectedBody.id, pattern.mode === 'linear' ? { kind: 'pattern', id: newFeatureId(), mode: 'linear', count: pattern.count, step: pattern.step } : { kind: 'pattern', id: newFeatureId(), mode: 'radial', count: pattern.count, axis: pattern.axis, center: pattern.center, angle: pattern.angle });
    setTool('select');
  };
  const applyBoolean = () => {
    const tool = boolean.tool && bodies.some((body) => body.id === boolean.tool) ? boolean.tool : null;
    if (!selectedBody || !tool || tool === selectedBody.id) return;
    addFeature(selectedBody.id, { kind: 'boolean', id: newFeatureId(), op: boolean.op, tool });
    // The tool body is consumed: hidden, kept for editing.
    updateBody(tool, { visible: false });
    setBoolean({ tool: null });
    setTool('select');
  };
  const settingWorkPlane = useModeling((s) => s.settingWorkPlane);
  const workPlaneMode = useModeling((s) => s.workPlaneMode);
  const workPlanePoints = useModeling((s) => s.workPlanePoints);
  const setWorkPlaneMode = useModeling((s) => s.setWorkPlaneMode);
  const clearWorkPlanePoints = useModeling((s) => s.clearWorkPlanePoints);
  const cancelSettingWorkPlane = useModeling((s) => s.cancelSettingWorkPlane);
  const setWorkPlane = useModeling((s) => s.setWorkPlane);

  const vec3Fields = (label: string, value: [number, number, number], onCommit: (next: [number, number, number]) => void) =>
    (['X', 'Y', 'Z'] as const).map((axis, index) => (
      <label key={axis} className={styles.option}>
        {label} {axis}
        <NumberField
          value={value[index]!}
          unit="mm"
          precision={0}
          onCommit={(v) => {
            const next = [...value] as [number, number, number];
            next[index] = v;
            onCommit(next);
          }}
        />
      </label>
    ));

  if (settingWorkPlane) {
    return (
      <div className={styles.optionsBar} style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }} data-testid="workplane-options-bar">
        <span className={styles.optionsTool} style={{ color: 'var(--accent)' }}>
          <PencilRuler size={15} /> Set Work Plane
        </span>
        <div className={styles.segmentedControl}>
          <button
            type="button"
            className={styles.segmentBtn}
            data-active={workPlaneMode === 'surface' || undefined}
            onClick={() => setWorkPlaneMode('surface')}
          >
            <Focus size={13} /> Surface / Face
          </button>
          <button
            type="button"
            className={styles.segmentBtn}
            data-active={workPlaneMode === 'plane' || undefined}
            onClick={() => setWorkPlaneMode('plane')}
          >
            <Layers size={13} /> Reference Plane
          </button>
          <button
            type="button"
            className={styles.segmentBtn}
            data-active={workPlaneMode === '3points' || undefined}
            onClick={() => setWorkPlaneMode('3points')}
          >
            <Target size={13} /> 3 Points
          </button>
        </div>
        <span className={styles.toolbarSpacer} />
        {workPlaneMode === 'surface' && (
          <span className={styles.optionText} style={{ color: 'var(--text)', fontWeight: 500 }}>
            Click any solid face or imported mesh surface to align the work plane.
          </span>
        )}
        {workPlaneMode === 'plane' && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={styles.optionText} style={{ color: 'var(--text)', fontWeight: 500 }}>Quick select:</span>
            {PLANE_IDS.map((id) => (
              <TextButton key={id} onClick={() => setWorkPlane({ kind: 'plane', id, offset: planes[id] })}>
                {PLANE_LABELS[id]} ({planes[id]} mm)
              </TextButton>
            ))}
            <span className={styles.optionText}>or click a plane in 3D.</span>
          </div>
        )}
        {workPlaneMode === '3points' && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className={styles.badge} style={{ background: workPlanePoints.length === 0 ? 'var(--accent)' : 'var(--bg-panel)', color: workPlanePoints.length === 0 ? '#fff' : 'inherit' }}>
              1. Origin {workPlanePoints[0] ? `✓ (${workPlanePoints[0].map((v) => Math.round(v)).join(', ')})` : ''}
            </span>
            <span className={styles.badge} style={{ background: workPlanePoints.length === 1 ? 'var(--accent)' : 'var(--bg-panel)', color: workPlanePoints.length === 1 ? '#fff' : 'inherit' }}>
              2. X-Axis {workPlanePoints[1] ? `✓ (${workPlanePoints[1].map((v) => Math.round(v)).join(', ')})` : ''}
            </span>
            <span className={styles.badge} style={{ background: workPlanePoints.length === 2 ? 'var(--accent)' : 'var(--bg-panel)', color: workPlanePoints.length === 2 ? '#fff' : 'inherit' }}>
              3. Plane (XY)
            </span>
            {workPlanePoints.length > 0 && (
              <TextButton onClick={() => clearWorkPlanePoints()} title="Reset picked points">
                Reset points
              </TextButton>
            )}
          </div>
        )}
        <TextButton onClick={() => cancelSettingWorkPlane()} title="Cancel work plane setup">
          <X size={13} /> Cancel
        </TextButton>
      </div>
    );
  }
  return (
    <div className={styles.optionsBar} data-testid="options-bar">
      <span className={styles.optionsTool}>
        <ToolIcon tool={tool} size={14} /> {tool === 'select' ? ({ translate: 'Move', rotate: 'Rotate', scale: 'Scale' } as const)[gizmoMode] : TOOL_LABELS[tool]}
      </span>
      {(sketching || tool === 'select') && (
        <>
          <label className={styles.option}>
            Grid
            <NumberField value={options.grid} unit="mm" precision={0} min={0} onCommit={(grid) => setToolOptions({ grid })} ariaLabel="Sketch grid" />
          </label>
          <label className={styles.optionCheck}>
            <input type="checkbox" checked={options.snap} onChange={(event) => setToolOptions({ snap: event.target.checked })} /> Snap
          </label>
        </>
      )}
      {tool === 'polygon' && (
        <label className={styles.option}>
          Sides
          <NumberField value={options.sides} precision={0} min={3} max={24} onCommit={(sides) => setToolOptions({ sides: Math.round(sides) })} ariaLabel="Polygon sides" />
        </label>
      )}
      {sketching && (
        <>
          <span className={styles.optionText}>
            {edgeOn
              ? 'The work plane is edge-on in this view · orbit, switch view, or use Set work plane to draw here'
              : `Drawing on the work plane (${planeLabel(workPlane)}) · ${sketch && samePlane(sketch.plane, workPlane) ? `editing ${sketch.name}` : 'drawing starts a new sketch'}`}
          </span>
          <TextButton onClick={() => addSketch(drawingPlane)} title="Start a new, empty sketch on this plane">
            <Plus size={12} /> New sketch
          </TextButton>
          {tool === 'line' && (
            <label className={styles.optionCheck} title="Each line starts where the previous one ended (Esc ends the chain)">
              <input type="checkbox" checked={options.chain} onChange={(event) => setToolOptions({ chain: event.target.checked })} data-testid="draw-chain" /> Chain
            </label>
          )}
          {(tool === 'line' || tool === 'polyline' || tool === 'arc' || tool === 'rect') && (
            <label className={styles.option} title="Corners of drawn curves are rounded with this radius (0 = sharp)">
              Radius
              <NumberField value={options.drawRadius} unit="mm" precision={0} min={0} onCommit={(drawRadius) => setToolOptions({ drawRadius: Math.max(0, drawRadius) })} ariaLabel="Draw corner radius" />
            </label>
          )}
          {(tool === 'line' || tool === 'polyline') && (
            <label className={styles.option} title="Place the curve this far to the left of where it is drawn (negative = right)">
              Offset
              <NumberField value={options.drawOffset} unit="mm" precision={0} onCommit={(drawOffset) => setToolOptions({ drawOffset })} ariaLabel="Draw offset" />
            </label>
          )}
          {tool === 'arc' && (
            <Segmented<'three-point' | 'center' | 'tangent'> value={options.arcMode} onChange={(arcMode) => setToolOptions({ arcMode })} ariaLabel="Arc mode" options={[{ value: 'three-point', label: 'Start-end-through' }, { value: 'center', label: 'Centre-ends' }, { value: 'tangent', label: 'Tangent' }]} data-testid="draw-arc-mode" />
          )}
          {tool === 'circle' && (
            <Segmented<'center' | '2p' | '3p'> value={options.circleMode} onChange={(circleMode) => setToolOptions({ circleMode })} ariaLabel="Circle mode" options={[{ value: 'center', label: 'Centre-radius' }, { value: '2p', label: '2 points' }, { value: '3p', label: '3 points' }]} data-testid="draw-circle-mode" />
          )}
          {tool === 'polyline' && (
            <label className={styles.optionCheck} title="The next segment is an arc tangent to the previous one (T while drawing)">
              <input type="checkbox" checked={options.tangentArc} onChange={(event) => setToolOptions({ tangentArc: event.target.checked })} /> Tangent arc (T)
            </label>
          )}
          {tool === 'polyline' && (
            <label className={styles.optionCheck} title="The next segment is an arc: click its end, then a point it passes through (A while drawing)">
              <input type="checkbox" checked={options.arc} onChange={(event) => setToolOptions({ arc: event.target.checked })} /> Arc (A)
            </label>
          )}
          {tool === 'offset' && (
            <label className={styles.option}>
              Distance
              <NumberField value={options.offset} unit="mm" precision={0} onCommit={(offset) => setToolOptions({ offset })} ariaLabel="Offset distance" />
            </label>
          )}
          <span className={styles.optionText}>
            {tool === 'line'
              ? 'Click a start and end point · type a length and Enter · Shift locks 45° directions'
              : tool === 'arc' && options.arcMode === 'tangent'
              ? 'Click the end of a curve to continue it smoothly (or a start, then the direction) · then the arc end'
              : tool === 'arc' && options.arcMode === 'center'
              ? 'Click the centre, the start (radius), then the end · or type the angle and Enter'
              : tool === 'polyline' || tool === 'arc'
              ? 'Click points · Enter or double-click closes · Backspace removes a point · Shift for 45°'
              : tool === 'circle' && options.circleMode === '3p'
              ? 'Click three points on the circle'
              : tool === 'circle' && options.circleMode === '2p'
              ? 'Click the two ends of a diameter · or type the diameter and Enter'
              : tool === 'ellipse'
              ? 'Click the centre, the end of one axis, then the other radius · type a value and Enter'
              : tool === 'spline'
              ? 'Click for corners · press and drag for smooth points with handles · click the first point to close · Enter or double-click finishes · Backspace removes a point'
              : tool === 'freehand'
                ? 'Drag a stroke; it is simplified into a closed outline on release'
                : tool === 'knife'
                  ? 'Click two snapped points to add a segment on the picked sketch surface · shortcut J'
                : tool === 'offset'
                  ? 'Click a shape to add a copy grown (positive) or shrunk (negative) by the distance'
                  : 'Drag to draw · type a size (e.g. 1200x800) and Enter · Alt from the centre'}
          </span>
        </>
      )}
      {tool === 'select' && sketch && (
        <>
          <label className={styles.option} title="Rounds every convex corner of the sketch region">
            Corners
            <ParamNumber path={fieldPath('sketch', sketch.id, 'cornerRadius')} value={sketch.cornerRadius ?? 0} unit="mm" precision={0} min={0} onCommit={(cornerRadius) => updateSketch(sketch.id, { cornerRadius })} ariaLabel="Corner radius" />
          </label>
          <TextButton onClick={() => inspectSelectedLoop(modelingStore.getState())} title="Highlight a closed line loop or its open endpoints (Ctrl+Shift+Alt)">
            Check loop
          </TextButton>
          {!sketchEdit && (
            <TextButton onClick={() => enterSketchEdit(sketch.id)} data-testid="sketch-edit-enter" title="Edit this sketch in isolation (double-click a curve); Finish keeps the changes as one undo step">
              <PencilRuler size={12} /> {selection?.kind === 'feature' ? 'Edit profile' : 'Edit sketch'}
            </TextButton>
          )}
          {(selection?.kind === 'shape' || selection?.kind === 'curve-point') && (() => {
            const shape = sketch.shapes.find((item) => item.id === selection.shapeId);
            return shape ? <CurveDimensions sketchId={sketch.id} shape={shape} pointIndex={selection.kind === 'curve-point' ? selection.pointIndex : null} /> : null;
          })()}
          {selection?.kind === 'shape' && <span className={styles.optionText}>Drag grips to reshape (joined ends follow) · double-click a segment to add a point{sketch.shapes.find((item) => item.id === selection.shapeId)?.kind === 'polyline' ? ' · Tab steps through its points' : ''} · MV / CO / RO / MM / TR edit curves.</span>}
          {selection?.kind === 'curve-point' && <span className={styles.optionText} data-testid="curve-point-hint">Point {selection.pointIndex + 1} of {(() => { const shape = sketch.shapes.find((item) => item.id === selection.shapeId); return shape?.kind === 'polyline' ? shape.points.length : '?'; })()} · Tab / Shift+Tab next / previous point · drag its gizmo or type X / Y · Delete removes it.</span>}
        </>
      )}
      {(MODIFY_TOOLS.includes(tool) || tool === 'pickline') && (
        <>
          {(tool === 'smove' || tool === 'scopy' || tool === 'srotate' || tool === 'sscale' || tool === 'smirror' || tool === 'pickline') && (
            <label className={styles.optionCheck}>
              <input type="checkbox" checked={options.snap} onChange={(event) => setToolOptions({ snap: event.target.checked })} /> Snap
            </label>
          )}
          {tool === 'scopy' && (
            <label className={styles.option} title="Copies placed at 1×, 2×, … the picked offset (an array)">
              Copies
              <NumberField value={options.modify.copies} precision={0} min={1} max={100} onCommit={(copies) => setToolOptions({ modify: { ...options.modify, copies: Math.max(1, Math.round(copies)) } })} ariaLabel="Number of copies" />
            </label>
          )}
          {tool === 'smirror' && (
            <label className={styles.optionCheck}><input type="checkbox" checked={options.modify.mirrorCopy} onChange={(event) => setToolOptions({ modify: { ...options.modify, mirrorCopy: event.target.checked } })} /> Copy</label>
          )}
          {tool === 'srotate' && (
            <label className={styles.optionCheck}><input type="checkbox" checked={options.modify.rotateCopy} onChange={(event) => setToolOptions({ modify: { ...options.modify, rotateCopy: event.target.checked } })} /> Copy</label>
          )}
          {tool === 'trim' && (
            <Segmented<'corner' | 'segment'> value={options.modify.trimMode} onChange={(trimMode) => setToolOptions({ modify: { ...options.modify, trimMode } })} ariaLabel="Trim mode" options={[{ value: 'corner', label: 'To corner' }, { value: 'segment', label: 'Delete piece' }]} />
          )}
          {tool === 'fillet' && (
            <>
              <Segmented<'fillet' | 'chamfer'> value={options.modify.filletMode} onChange={(filletMode) => setToolOptions({ modify: { ...options.modify, filletMode } })} ariaLabel="Corner mode" options={[{ value: 'fillet', label: 'Fillet' }, { value: 'chamfer', label: 'Chamfer' }]} />
              <label className={styles.option}>
                {options.modify.filletMode === 'fillet' ? 'Radius' : 'Distance'}
                <NumberField value={options.modify.filletSize} unit="mm" precision={0} min={0} onCommit={(filletSize) => setToolOptions({ modify: { ...options.modify, filletSize: Math.max(0, filletSize) } })} ariaLabel="Fillet size" />
              </label>
            </>
          )}
          {tool === 'pickline' && (
            <label className={styles.option} title="Place picked lines this far to the left of the picked edge (negative = right)">
              Offset
              <NumberField value={options.drawOffset} unit="mm" precision={0} onCommit={(drawOffset) => setToolOptions({ drawOffset })} ariaLabel="Pick offset" />
            </label>
          )}
          <span className={styles.optionText} data-testid="modify-instruction">
            {tool === 'pickline' ? 'Click an edge of a body or a curve of another sketch to copy it into this sketch' : modifyInstruction(modelingStore.getState(), hasCurveSelection)}
          </span>
        </>
      )}
      {tool === 'pushpull' && (
        <>
          <label className={styles.option}>
            Distance
            <NumberField value={extrude.distance} unit="mm" precision={0} onCommit={(distance) => setExtrude({ distance })} ariaLabel="Push/pull distance" />
          </label>
          <TextButton primary disabled={selection?.kind !== 'face'} onClick={() => viewportRef.current?.tools.solid.commit()} data-testid="pushpull-commit">
            <Hand size={12} /> {extrude.distance >= 0 ? 'Pull out' : 'Push in'}
          </TextButton>
          <span className={styles.optionText}>{selection?.kind === 'face' ? 'Drag the arrow in a 3D pane (out adds, in cuts), or type a distance and press Enter' : 'Click a face of a body in a 3D pane'}</span>
        </>
      )}
      {tool === 'revolve' && (
        <>
          <span className={styles.badge}>1. Axis {revolveAxisReady ? '✓' : '— select an open curve'}</span>
          {revolveAxisReady && <TextButton onClick={() => setRevolve({ axisRef: null, profile: null })}>Change axis</TextButton>}
          <span className={styles.badge}>2. Profile {revolveProfileReady ? '✓' : '— select a closed loop'}</span>
          {revolveAxisReady && revolveProfileReady && (
            <>
              <label className={styles.option}>3. Angle <NumberField value={revolve.angle} suffix="°" precision={0} min={1} max={360} onCommit={(angle) => setRevolve({ angle })} ariaLabel="Revolve angle" /></label>
              <Segmented<Extrude['op']> value={revolve.op} onChange={(op) => setRevolve({ op })} ariaLabel="Revolve operation" options={OP_OPTIONS} />
              {revolve.op !== 'new' && bodyOptions.length > 0 && <label className={styles.option}>Into <SelectField value={targetValue(revolve.target)} options={bodyOptions} onChange={(target) => setRevolve({ target })} ariaLabel="Revolve target body" /></label>}
              <TextButton primary onClick={() => viewportRef.current?.tools.solid.commit()} data-testid="revolve-commit"><RefreshCw size={12} /> Create revolve</TextButton>
            </>
          )}
          <span className={styles.optionText}>{!revolveAxisReady ? 'Step 1 of 3 · click or draw an open axis curve in the viewport, or select it in Layers.' : !revolveProfileReady ? 'Step 2 of 3 · click the closed profile to revolve.' : 'Step 3 of 3 · set the angle and operation, then create.'}</span>
        </>
      )}
      {tool === 'mirror' && (
        <>
          <label className={styles.option}>
            Across
            <SelectField value={mirror.axis} options={AXIS_OPTIONS} onChange={(axis) => setMirror({ axis })} ariaLabel="Mirror axis" />
          </label>
          <label className={styles.option}>
            at
            <NumberField value={mirror.offset} unit="mm" precision={0} onCommit={(offset) => setMirror({ offset })} ariaLabel="Mirror plane position" />
          </label>
          <label className={styles.optionCheck}>
            <input type="checkbox" checked={mirror.keepOriginal} onChange={(event) => setMirror({ keepOriginal: event.target.checked })} /> Keep original
          </label>
          <TextButton primary disabled={!selectedBody} onClick={applyMirror} data-testid="mirror-apply">
            <FlipHorizontal2 size={12} /> Mirror {selectedBody?.name ?? ''}
          </TextButton>
          <span className={styles.optionText}>{selectedBody ? 'The plane is perpendicular to the axis, in the body\u2019s own frame' : 'Select a body to mirror'}</span>
        </>
      )}
      {tool === 'pattern' && (
        <>
          <Segmented<'linear' | 'radial'>
            value={pattern.mode}
            onChange={(mode) => setPattern({ mode })}
            ariaLabel="Pattern mode"
            options={[
              { value: 'linear', label: 'Linear' },
              { value: 'radial', label: 'Radial' },
            ]}
          />
          <label className={styles.option}>
            Count
            <NumberField value={pattern.count} precision={0} min={1} max={200} onCommit={(count) => setPattern({ count: Math.round(count) })} ariaLabel="Pattern count" />
          </label>
          {pattern.mode === 'linear' ? (
            vec3Fields('Step', pattern.step, (step) => setPattern({ step }))
          ) : (
            <>
              <label className={styles.option}>
                Axis
                <SelectField value={pattern.axis} options={AXIS_OPTIONS} onChange={(axis) => setPattern({ axis })} ariaLabel="Pattern axis" />
              </label>
              {vec3Fields('Centre', pattern.center, (center) => setPattern({ center }))}
              <label className={styles.option}>
                Sweep
                <NumberField value={pattern.angle} suffix="°" precision={0} min={1} max={360} onCommit={(angle) => setPattern({ angle })} ariaLabel="Pattern sweep" />
              </label>
            </>
          )}
          <TextButton primary disabled={!selectedBody} onClick={applyPattern} data-testid="pattern-apply">
            <Copy size={12} /> Repeat {selectedBody?.name ?? ''}
          </TextButton>
          {!selectedBody && <span className={styles.optionText}>Select a body to repeat</span>}
        </>
      )}
      {tool === 'boolean' && (
        <>
          <Segmented<'union' | 'subtract' | 'intersect'> value={boolean.op} onChange={(op) => setBoolean({ op })} ariaLabel="Boolean operation" options={BOOLEAN_OPTIONS} />
          <label className={styles.option}>
            Tool
            <SelectField
              value={boolean.tool && bodies.some((body) => body.id === boolean.tool) ? boolean.tool : ''}
              options={[{ value: '', label: 'Pick a body…' }, ...bodyOptions.filter((option) => option.value !== selectedBody?.id)]}
              onChange={(toolId) => setBoolean({ tool: toolId || null })}
              ariaLabel="Boolean tool body"
            />
          </label>
          <TextButton primary disabled={!selectedBody || !boolean.tool || boolean.tool === selectedBody.id} onClick={applyBoolean} data-testid="boolean-apply">
            <Combine size={12} /> Apply to {selectedBody?.name ?? '…'}
          </TextButton>
          <span className={styles.optionText}>{selectedBody ? `Click another body (the tool) or pick it above; it is hidden and kept for editing` : 'Select the body to change first, then click the tool body'}</span>
        </>
      )}
      {tool === 'extrude' && (
        <>
          <span className={styles.badge} data-testid="extrude-profile-summary">1. Profile {extrudeProfileReady ? extrudeProfileText(extrudeSummary) : '— select curves or loops'}</span>
          {extrudeSummary.picked && <TextButton onClick={() => viewportRef.current?.tools.solid.resetRegions()}>Reset regions</TextButton>}
          {fixLabel && (
            <TextButton onClick={healProfiles} data-testid="extrude-heal" title="Extend near-miss line ends to their corner, trim lines that overshoot a corner and remove duplicate curves">
              Fix: {fixLabel}
            </TextButton>
          )}
          {extrudeProfileReady && (
            <>
              <label className={styles.option}>2. Distance <NumberField value={extrude.distance} unit="mm" precision={0} onCommit={(distance) => setExtrude({ distance })} ariaLabel="Extrude distance" /></label>
              <label className={styles.optionCheck}><input type="checkbox" checked={extrude.symmetric} onChange={(event) => setExtrude({ symmetric: event.target.checked })} /> Symmetric</label>
              {extrude.op === 'new' && extrudeSummary.faces > 1 && <label className={styles.optionCheck} title="Make one body per region instead of one body for the whole profile"><input type="checkbox" checked={extrude.separate} onChange={(event) => setExtrude({ separate: event.target.checked })} data-testid="extrude-separate" /> Body per region</label>}
              <Segmented<Extrude['op']> value={extrude.op} onChange={(op) => setExtrude({ op })} ariaLabel="Extrude operation" options={OP_OPTIONS} />
              {extrude.op !== 'new' && bodyOptions.length > 0 && <label className={styles.option}>Into <SelectField value={extrude.target && bodies.some((body) => body.id === extrude.target) ? extrude.target : bodies[bodies.length - 1]!.id} options={bodyOptions} onChange={(target) => setExtrude({ target })} ariaLabel="Extrude target body" /></label>}
              <TextButton primary onClick={() => viewportRef.current?.tools.solid.commit()} data-testid="extrude-commit"><ArrowUpFromLine size={12} /> Create {extrudeProfileClosed ? 'solid' : 'surface'} extrusion</TextButton>
              <TextButton onClick={() => setExtrude({ profile: null, profiles: [] })}>Change profile</TextButton>
            </>
          )}
          <span className={styles.optionText}>{extrudeProfileReady ? 'Shift/Ctrl+click to add curves · click inside a region to include or leave it out · drag the arrow or type a distance.' : 'Step 1 of 2 · click curves (Shift/Ctrl+click or window-select for more). Loops inside loops become openings; crossing lines close on their own.'}</span>
        </>
      )}
      {tool === 'sweep' && (
        <>
          <span className={styles.badge}>1. Path {sweepPathReady ? '✓' : '— select an open curve'}</span>
          {sweepPathReady && <TextButton onClick={() => setSweep({ path: null, profile: null })}>Change path</TextButton>}
          <span className={styles.badge}>2. Profile {sweepProfileReady ? '✓' : '— select a closed loop'}</span>
          {sweepPathReady && sweepProfileReady && (
            <>
              <Segmented<Extrude['op']> value={sweep.op} onChange={(op) => setSweep({ op })} ariaLabel="Sweep operation" options={OP_OPTIONS} />
              {sweep.op !== 'new' && bodyOptions.length > 0 && <label className={styles.option}>Into <SelectField value={targetValue(sweep.target)} options={bodyOptions} onChange={(target) => setSweep({ target })} ariaLabel="Sweep target body" /></label>}
              <TextButton primary onClick={() => viewportRef.current?.tools.solid.commit()} data-testid="sweep-commit"><Spline size={12} /> Create sweep</TextButton>
            </>
          )}
          <span className={styles.optionText}>{!sweepPathReady ? 'Step 1 of 3 · click or draw an open path.' : !sweepProfileReady ? 'Step 2 of 3 · select a closed profile; it will orient to the path.' : 'Step 3 of 3 · choose the operation, then create.'}</span>
        </>
      )}
      {tool === 'paint' && (
        <>
          <label className={styles.option}>
            Material
            <SelectField value={materials[options.paintMaterial] ? options.paintMaterial : (materialOptions[0]?.value ?? options.paintMaterial)} options={materialOptions} onChange={(paintMaterial) => setToolOptions({ paintMaterial })} ariaLabel="Paint material" />
          </label>
          <span className={styles.optionText}>Click a body to give it this material</span>
        </>
      )}
      {numericEntry && (
        <span className={styles.numericEntry} title="Typed value; Enter applies it">
          {numericEntry}
        </span>
      )}
    </div>
  );
}

function extrudeProfileText(summary: ExtrudeSummary): string {
  const parts: string[] = [];
  if (summary.solids) parts.push(`${summary.faces} region${summary.faces === 1 ? '' : 's'} → solid`);
  if (summary.openings) parts.push(`${summary.openings} opening${summary.openings === 1 ? '' : 's'}`);
  if (summary.surfaces) parts.push(`${summary.surfaces} open curve${summary.surfaces === 1 ? '' : 's'} → surface`);
  if (summary.groups > 1) parts.push(`${summary.groups} sketches`);
  if (summary.openEnds && summary.solids) parts.push(`${summary.openEnds} loose end${summary.openEnds === 1 ? '' : 's'} ignored`);
  return '✓ ' + parts.join(' · ');
}

// ---- layers ---------------------------------------------------------------------------------

function NodeRow({ layer, node, depth, onSelect }: { layer: Layer; node: LayerNode; depth: number; onSelect: (selection: SelectedItem, event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  const selection = useModeling((s) => s.selection);
  const selectionSet = useModeling((s) => s.selectionSet);
  const setNodeVisible = useModeling((s) => s.setNodeVisible);
  const [open, setOpen] = useState(depth < 1);
  const candidate: SelectedItem = { kind: 'node', layerId: layer.id, nodeId: node.id };
  const selected = selectionSet.some((item) => selectionKey(item) === selectionKey(candidate)) || (selectionSet.length === 0 && selection?.kind === 'node' && selection.nodeId === node.id);
  // A node picked in the viewport is revealed even inside a collapsed branch.
  const expanded = open || (selection?.kind === 'node' && findNode(node.children, selection.nodeId) !== null);
  return (
    <>
      <li className={styles.treeRow} data-selected={selected || undefined} data-hidden={!node.visible || undefined} style={{ paddingInlineStart: 8 + depth * 14 }}>
        {node.children.length > 0 ? (
          <button type="button" className={styles.treeToggle} onClick={() => setOpen(!expanded)} aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className={styles.treeToggle} />
        )}
        <button type="button" className={styles.treeName} onClick={(event) => onSelect(candidate, event)}>
          {node.name}
        </button>
        <IconButton label={node.visible ? 'Hide' : 'Show'} onClick={() => setNodeVisible(layer.id, node.id, !node.visible)}>
          {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </IconButton>
      </li>
      {expanded && node.children.map((child) => <NodeRow key={child.id} layer={layer} node={child} depth={depth + 1} onSelect={onSelect} />)}
    </>
  );
}

function TreeLabel({
  id,
  name,
  renamingId,
  renameDraft,
  onStartRename,
  onChangeDraft,
  onCommitRename,
  onCancelRename,
  onClick,
}: {
  id: string;
  name: string;
  renamingId: string | null;
  renameDraft: string;
  onStartRename: (id: string, name: string) => void;
  onChangeDraft: (val: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  if (renamingId === id) {
    return (
      <input
        className={styles.renameInput}
        value={renameDraft}
        autoFocus
        onChange={(e) => onChangeDraft(e.target.value)}
        onBlur={onCommitRename}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') onCommitRename();
          if (e.key === 'Escape') onCancelRename();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <button
      type="button"
      className={styles.treeName}
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartRename(id, name);
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') {
          e.stopPropagation();
          onStartRename(id, name);
        }
      }}
      title="Click to select, double-click or F2 to rename"
    >
      {name}
    </button>
  );
}

interface LoopItem {
  id: string;
  name: string;
  shapeIds: string[];
  loopIndex: number;
}

/** Features of a body that take a profile from this sketch. */
function profileFeatures(body: Body, sketchId: string): Extract<Feature, { kind: 'extrude' | 'revolve' | 'sweep' }>[] {
  return body.features.filter((feature): feature is Extract<Feature, { kind: 'extrude' | 'revolve' | 'sweep' }> => (feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') && feature.profile === sketchId);
}

/** The body is listed under this loop: one of its profiles lies wholly in it (legacy: any loop). */
function bodyFitsLoop(body: Body, sketchId: string, loop: LoopItem): boolean {
  return profileFeatures(body, sketchId).some((feature) => !feature.profileShapes?.length || feature.profileShapes.every((id) => loop.shapeIds.includes(id)));
}

/** One of the body's profiles uses a curve of this loop. */
function bodyUsesLoop(body: Body, sketchId: string, loop: LoopItem): boolean {
  return profileFeatures(body, sketchId).some((feature) => feature.profileShapes?.some((id) => loop.shapeIds.includes(id)));
}

/** The loops of a sketch a set of profile curves uses. */
function profileLoops(sketch: Sketch, shapeIds: readonly string[]): LoopItem[] {
  return extractSketchLoops(sketch).filter((loop) => loop.shapeIds.some((id) => shapeIds.includes(id)));
}

/** How many loops the body's profiles take from this sketch (the largest feature). */
function bodyProfileCount(body: Body, sketch: Sketch): number {
  return Math.max(1, ...profileFeatures(body, sketch.id).map((feature) => profileLoops(sketch, feature.profileShapes ?? []).length));
}

function extractSketchLoops(sketch: Sketch): LoopItem[] {
  const loops: LoopItem[] = [];
  let index = 0;
  for (const shape of sketch.shapes) {
    if (shape.kind === 'rect') {
      loops.push({ id: `${sketch.id}-loop-${index}`, name: shape.name ?? 'Rectangle Loop', shapeIds: [shape.id], loopIndex: index++ });
    } else if (shape.kind === 'circle') {
      loops.push({ id: `${sketch.id}-loop-${index}`, name: shape.name ?? 'Circle Loop', shapeIds: [shape.id], loopIndex: index++ });
    } else if (shape.kind === 'polygon') {
      loops.push({ id: `${sketch.id}-loop-${index}`, name: shape.name ?? 'Polygon Loop', shapeIds: [shape.id], loopIndex: index++ });
    } else if (shape.kind === 'polyline' && shape.closed !== false) {
      loops.push({ id: `${sketch.id}-loop-${index}`, name: shape.name ?? 'Polyline Loop', shapeIds: [shape.id], loopIndex: index++ });
    }
  }
  const stitched = stitchedLineLoops(sketch.shapes);
  for (const loop of stitched) {
    const named = sketch.shapes.find((shape) => loop.shapeIds.includes(shape.id))?.name;
    loops.push({ id: `${sketch.id}-loop-${index}`, name: named ?? `Line Loop (${loop.shapeIds.length} segments)`, shapeIds: loop.shapeIds, loopIndex: index++ });
  }
  const usedShapeIds = new Set(loops.flatMap((l) => l.shapeIds));
  for (const shape of sketch.shapes) {
    if (!usedShapeIds.has(shape.id)) {
      loops.push({ id: `${sketch.id}-loop-${index}`, name: shapeLabel(shape), shapeIds: [shape.id], loopIndex: index++ });
    }
  }
  return loops;
}

function LayersPanel({
  assetId,
  onError,
  projectReference,
}: {
  assetId: string;
  onError: (message: string) => void;
  projectReference?: { name: string; visible: boolean; onToggle: () => void };
}) {
  const layers = useModeling((s) => s.layers);
  const bodies = useModeling((s) => s.bodies);
  const bodyInfo = useModeling((s) => s.bodyInfo);
  const updateBody = useModeling((s) => s.updateBody);
  const sketches = useModeling((s) => s.sketches);
  const updateSketch = useModeling((s) => s.updateSketch);
  const updateShape = useModeling((s) => s.updateShape);
  const renameBody = useModeling((s) => s.renameBody);
  const renameSketch = useModeling((s) => s.renameSketch);
  const renameFeature = useModeling((s) => s.renameFeature);
  const renameLayer = useModeling((s) => s.renameLayer);
  const [openBodies, setOpenBodies] = useState<Record<string, boolean>>({});
  const [openSketches, setOpenSketches] = useState<Record<string, boolean>>({});
  const [openLoops, setOpenLoops] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renamingType, setRenamingType] = useState<'layer' | 'sketch' | 'body' | 'feature' | 'loop' | 'camera' | null>(null);
  const [renamingExtraId, setRenamingExtraId] = useState<string | null>(null);
  const [showWorkPlaneMenu, setShowWorkPlaneMenu] = useState(false);

  const cameras = useModeling((s) => s.cameras);
  const planes = useModeling((s) => s.planes);
  const selection = useModeling((s) => s.selection);
  const selectionSet = useModeling((s) => s.selectionSet);
  const select = useModeling((s) => s.select);
  const selectMany = useModeling((s) => s.selectMany);
  const addLayer = useModeling((s) => s.addLayer);
  const updateLayer = useModeling((s) => s.updateLayer);
  const fitPlanes = useModeling((s) => s.fitPlanes);
  const addCamera = useModeling((s) => s.addCamera);
  const updateCamera = useModeling((s) => s.updateCamera);
  const setPreviewCamera = useModeling((s) => s.setPreviewCamera);
  const planeVisible = useModeling((s) => s.planeVisible);
  const setPlaneVisible = useModeling((s) => s.setPlaneVisible);
  const workPlane = useModeling((s) => s.workPlane);
  const workPlaneVisible = useModeling((s) => s.workPlaneVisible);
  const setWorkPlaneVisible = useModeling((s) => s.setWorkPlaneVisible);
  const setWorkPlane = useModeling((s) => s.setWorkPlane);
  const settingWorkPlane = useModeling((s) => s.settingWorkPlane);
  const startSettingWorkPlane = useModeling((s) => s.startSettingWorkPlane);
  const cancelSettingWorkPlane = useModeling((s) => s.cancelSettingWorkPlane);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangeAnchorRef = useRef<string | null>(null);
  const allCamerasVisible = cameras.every((camera) => camera.visible);
  const allPlanesVisible = PLANE_IDS.every((id) => planeVisible[id]);
  const [openLayers, setOpenLayers] = useState<Record<string, boolean>>({});
  const selectedInSet = (candidate: SelectedItem) => selectionSet.some((item) => selectionKey(item) === selectionKey(candidate)) || (selectionSet.length === 0 && selection ? selectionKey(selection) === selectionKey(candidate) : false);

  const startRename = (id: string, name: string, type: 'layer' | 'sketch' | 'body' | 'feature' | 'loop' | 'camera', extraId?: string) => {
    setRenamingId(id);
    setRenameDraft(name);
    setRenamingType(type);
    setRenamingExtraId(extraId ?? null);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const val = renameDraft.trim();
    if (val) {
      if (renamingType === 'layer') renameLayer(renamingId, val);
      else if (renamingType === 'sketch') renameSketch(renamingId, val);
      else if (renamingType === 'body') renameBody(renamingId, val);
      else if (renamingType === 'feature' && renamingExtraId) renameFeature(renamingExtraId, renamingId, val);
      else if (renamingType === 'loop' && renamingExtraId) {
        const sketch = sketches.find((item) => item.id === renamingExtraId);
        const loop = sketch && extractSketchLoops(sketch).find((item) => item.id === renamingId);
        const first = loop && sketch?.shapes.find((shape) => shape.id === loop.shapeIds[0]);
        if (sketch && first) updateShape(sketch.id, { ...first, name: val });
      }
      else if (renamingType === 'camera') updateCamera(renamingId, { name: val });
    }
    setRenamingId(null);
  };

  const importFiles = async (files: FileList | null) => {
    if (!files) return;
    const first = modelingStore.getState().layers.length === 0;
    for (const file of Array.from(files)) {
      try {
        const bytes = await file.arrayBuffer();
        const id = newLayerId();
        const layer = await modelingScene.importModel(bytes, file.name, id);
        addLayer(layer);
        await modelingStorage.saveFile(assetId, id, bytes);
      } catch (error) {
        onError(error instanceof Error ? error.message : `Could not import ${file.name}`);
      }
    }
    // The first model decides where the view planes start: just outside it, showing all of it.
    const bounds = modelingScene.bounds();
    if (first && bounds) fitPlanes([bounds.max.x, bounds.max.y, bounds.max.z]);
  };

  const userSketches = sketches.filter((s) => !s.id.startsWith('sketch-face-'));
  const standaloneBodies = bodies.filter((b) => !userSketches.some((s) => b.features.some((f) => (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'sweep') && f.profile === s.id)));
  const rangeItems: SelectedItem[] = [];
  const rangeKeys = new Set<string>();
  const addRangeItem = (item: SelectedItem) => {
    const key = selectionKey(item);
    if (!rangeKeys.has(key)) {
      rangeKeys.add(key);
      rangeItems.push(item);
    }
  };
  const addNodes = (layer: Layer, nodes: LayerNode[]) => nodes.forEach((node) => {
    addRangeItem({ kind: 'node', layerId: layer.id, nodeId: node.id });
    addNodes(layer, node.children);
  });
  layers.forEach((layer) => {
    addRangeItem({ kind: 'layer', id: layer.id });
    if (openLayers[layer.id] ?? true) addNodes(layer, layer.nodes);
  });
  userSketches.forEach((sketch) => {
    addRangeItem({ kind: 'sketch', id: sketch.id });
    if (!(openSketches[sketch.id] ?? true)) return;
    const childBodies = bodies.filter((body) => body.features.some((feature) => (feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') && feature.profile === sketch.id));
    extractSketchLoops(sketch).forEach((loop) => {
      addRangeItem({ kind: 'loop', sketchId: sketch.id, loopIndex: loop.loopIndex, shapeIds: loop.shapeIds });
      if (!(openLoops[loop.id] ?? true)) return;
      loop.shapeIds.forEach((shapeId) => addRangeItem({ kind: 'shape', sketchId: sketch.id, shapeId }));
      childBodies.filter((body) => body.features.some((feature) => {
        if ((feature.kind !== 'extrude' && feature.kind !== 'revolve' && feature.kind !== 'sweep') || feature.profile !== sketch.id) return false;
        return !feature.profileShapes?.length || feature.profileShapes.every((id) => loop.shapeIds.includes(id));
      })).forEach((body) => {
        addRangeItem({ kind: 'body', id: body.id });
        if (openBodies[body.id] ?? true) body.features.forEach((feature) => addRangeItem({ kind: 'feature', bodyId: body.id, featureId: feature.id }));
      });
    });
    const loops = extractSketchLoops(sketch);
    childBodies.filter((body) => !loops.some((loop) => bodyFitsLoop(body, sketch.id, loop))).forEach((body) => {
      addRangeItem({ kind: 'body', id: body.id });
      if (openBodies[body.id] ?? true) body.features.forEach((feature) => addRangeItem({ kind: 'feature', bodyId: body.id, featureId: feature.id }));
    });
  });
  standaloneBodies.forEach((body) => {
    addRangeItem({ kind: 'body', id: body.id });
    if (openBodies[body.id] ?? true) body.features.forEach((feature) => addRangeItem({ kind: 'feature', bodyId: body.id, featureId: feature.id }));
  });
  cameras.forEach((camera) => addRangeItem({ kind: 'camera', id: camera.id, part: 'eye' }));
  addRangeItem({ kind: 'workplane' });
  PLANE_IDS.forEach((id) => addRangeItem({ kind: 'plane', id }));
  const selectLayerRange = (candidate: SelectedItem, event: ReactMouseEvent<HTMLButtonElement>) => {
    const key = selectionKey(candidate);
    if (event.shiftKey) {
      const anchorKey = rangeAnchorRef.current ?? (selection ? selectionKey(selection) : key);
      const start = rangeItems.findIndex((item) => selectionKey(item) === anchorKey);
      const end = rangeItems.findIndex((item) => selectionKey(item) === key);
      if (start >= 0 && end >= 0) {
        selectMany(rangeItems.slice(Math.min(start, end), Math.max(start, end) + 1), event.ctrlKey || event.metaKey);
        return;
      }
    }
    select(candidate, event.ctrlKey || event.metaKey);
    rangeAnchorRef.current = key;
  };

  /** A body row with its features (and the curves driving them), indented by `depth`. */
  const renderBody = (body: Body, depth: number, meta?: string) => {
                                const bodyOpen = openBodies[body.id] ?? true;
                                const isBodySelected = selectedInSet({ kind: 'body', id: body.id });
                                const error = bodyInfo[body.id]?.error;

                                return (
                                  <li key={body.id} className={styles.treeItem}>
                                    <div
                                      className={styles.treeRow}
                                      style={{ paddingInlineStart: depth }}
                                      data-selected={isBodySelected || undefined}
                                      data-hidden={!body.visible || undefined}
                                      data-testid={`body-${body.id}`}
                                    >
                                      {body.features.length > 0 ? (
                                        <button type="button" className={styles.treeToggle} onClick={() => setOpenBodies({ ...openBodies, [body.id]: !bodyOpen })} aria-label={bodyOpen ? 'Collapse' : 'Expand'}>
                                          {bodyOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                        </button>
                                      ) : (
                                        <span className={styles.treeToggle} />
                                      )}
                                      <ShapeIcon shape={shapeOf(body)} />
                                      <TreeLabel
                                        id={body.id}
                                        name={body.name}
                                        renamingId={renamingId}
                                        renameDraft={renameDraft}
                                        onStartRename={(id, name) => startRename(id, name, 'body')}
                                        onChangeDraft={setRenameDraft}
                                        onCommitRename={commitRename}
                                        onCancelRename={() => setRenamingId(null)}
                                        onClick={(event) => selectLayerRange({ kind: 'body', id: body.id }, event)}
                                      />
                                      {meta && <span className={styles.treeMeta} data-testid={`body-meta-${body.id}`}>{meta}</span>}
                                      {error && (
                                        <span className={styles.badge} title={error.message}>
                                          <TriangleAlert size={12} />
                                        </span>
                                      )}
                                      <IconButton label={body.visible ? 'Hide body' : 'Show body'} onClick={() => updateBody(body.id, { visible: !body.visible })}>
                                        {body.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                                      </IconButton>
                                    </div>

                                    {bodyOpen && (
                                      <ul className={styles.treeSub}>
                                        {body.features.map((feature) => (
                                          <Fragment key={feature.id}>
                                          <li
                                            key={feature.id}
                                            className={styles.treeRow}
                                            style={{ paddingInlineStart: depth + 16 }}
                                            data-selected={selectedInSet({ kind: 'feature', bodyId: body.id, featureId: feature.id }) || undefined}
                                          >
                                            <span className={styles.treeToggle} />
                                            <FeatureIcon feature={feature} />
                                            <TreeLabel
                                              id={feature.id}
                                              name={feature.name ?? featureLabel(feature, sketches, bodies)}
                                              renamingId={renamingId}
                                              renameDraft={renameDraft}
                                              onStartRename={(_id, name) => startRename(feature.id, name, 'feature', body.id)}
                                              onChangeDraft={setRenameDraft}
                                              onCommitRename={commitRename}
                                              onCancelRename={() => setRenamingId(null)}
                                              onClick={(event) => selectLayerRange({ kind: 'feature', bodyId: body.id, featureId: feature.id }, event)}
                                            />
                                            {error?.featureId === feature.id && (
                                              <span className={styles.badge} title={error.message}>
                                                <TriangleAlert size={12} />
                                              </span>
                                            )}
                                          </li>
                                          <FeatureDriverRows feature={feature} depth={depth + 30} onSelect={select} sketches={sketches} />
                                          </Fragment>
                                        ))}
                                      </ul>
                                    )}
                                  </li>
                                );
  };

  return (
    <Panel
      title="Layers"
      action={
        <TextButton onClick={() => inputRef.current?.click()} data-testid="import-model">
          <Upload size={13} /> Import GLB
        </TextButton>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept=".glb,.gltf"
        multiple
        hidden
        onChange={(event) => {
          void importFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <div className={styles.treeGroup}>Model Layers</div>
      {projectReference && (
        <ul className={styles.tree}>
          <li className={styles.treeRow} data-hidden={!projectReference.visible || undefined} data-testid="project-reference-layer">
            <span className={styles.treeToggle} />
            <Lock size={13} className="u-muted" />
            <span className={styles.treeName} title="Locked project reference: available for snapping and work-plane picking">
              {projectReference.name}
            </span>
            <span className={styles.treeMeta}>Locked reference</span>
            <IconButton label={projectReference.visible ? 'Hide project reference' : 'Show project reference'} onClick={projectReference.onToggle}>
              {projectReference.visible ? <Eye size={13} /> : <EyeOff size={13} />}
            </IconButton>
          </li>
        </ul>
      )}
      {layers.length === 0 && !projectReference ? (
        <p className={styles.empty}>No layers yet. Import a GLB, or use Solids to add your first shape.</p>
      ) : layers.length > 0 ? (
        <ul className={styles.tree}>
          {layers.map((layer) => {
            const open = openLayers[layer.id] ?? true;
            const selected = selectedInSet({ kind: 'layer', id: layer.id });
            return (
              <li key={layer.id} className={styles.treeItem}>
                <div className={styles.treeRow} data-selected={selected || undefined} data-hidden={!layer.visible || undefined}>
                  <button type="button" className={styles.treeToggle} onClick={() => setOpenLayers({ ...openLayers, [layer.id]: !open })} aria-label={open ? 'Collapse' : 'Expand'}>
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <Box size={13} className="u-muted" />
                  <TreeLabel
                    id={layer.id}
                    name={layer.name}
                    renamingId={renamingId}
                    renameDraft={renameDraft}
                    onStartRename={(id, name) => startRename(id, name, 'layer')}
                    onChangeDraft={setRenameDraft}
                    onCommitRename={commitRename}
                    onCancelRename={() => setRenamingId(null)}
                    onClick={(event) => selectLayerRange({ kind: 'layer', id: layer.id }, event)}
                  />
                  <IconButton label={layer.visible ? 'Hide layer' : 'Show layer'} onClick={() => updateLayer(layer.id, { visible: !layer.visible })}>
                    {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </IconButton>
                </div>
                {open && (
                  <ul className={styles.tree}>
                    {layer.nodes.map((node) => (
                      <NodeRow key={node.id} layer={layer} node={node} depth={1} onSelect={selectLayerRange} />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className={styles.treeGroup}>Sketches &amp; Components</div>
      {userSketches.length === 0 ? (
        <p className={styles.empty}>No sketches yet. Pick a sketch tool to draw on a face or work plane.</p>
      ) : (
        <ul className={styles.tree}>
          {userSketches.map((sketch) => {
            const loops = extractSketchLoops(sketch);
            const sketchOpen = openSketches[sketch.id] ?? true;
            const isSketchSelected = selectedInSet({ kind: 'sketch', id: sketch.id });
            const childBodies = bodies.filter((b) => b.features.some((f) => (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'sweep') && f.profile === sketch.id));
            // Solids made from several profiles of this sketch at once are listed after the loops.
            const multiBodies = childBodies.filter((body) => !loops.some((loop) => bodyFitsLoop(body, sketch.id, loop)));

            return (
              <li key={sketch.id} className={styles.treeItem}>
                <div className={styles.treeRow} data-selected={isSketchSelected || undefined} data-hidden={!sketch.visible || undefined} data-testid={`sketch-${sketch.id}`}>
                  <button type="button" className={styles.treeToggle} onClick={() => setOpenSketches({ ...openSketches, [sketch.id]: !sketchOpen })} aria-label={sketchOpen ? 'Collapse' : 'Expand'}>
                    {sketchOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <PencilRuler size={13} className="u-muted" />
                  <TreeLabel
                    id={sketch.id}
                    name={sketch.name}
                    renamingId={renamingId}
                    renameDraft={renameDraft}
                    onStartRename={(id, name) => startRename(id, name, 'sketch')}
                    onChangeDraft={setRenameDraft}
                    onCommitRename={commitRename}
                    onCancelRename={() => setRenamingId(null)}
                    onClick={(event) => selectLayerRange({ kind: 'sketch', id: sketch.id }, event)}
                  />
                  <span className={styles.treeMeta}>
                    {planeLabel(sketch.plane)} (fixed) · {loops.length} loop{loops.length === 1 ? '' : 's'}
                  </span>
                  <IconButton label={sketch.visible ? 'Hide sketch' : 'Show sketch'} onClick={() => updateSketch(sketch.id, { visible: !sketch.visible })}>
                    {sketch.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </IconButton>
                </div>
                {sketchOpen && (
                  <ul className={styles.treeSub}>
                    {loops.length === 0 && <p className={styles.empty} style={{ paddingInlineStart: 18 }}>Empty sketch</p>}
                    {loops.map((loop) => {
                      const loopOpen = openLoops[loop.id] ?? true;
                      const loopBodies = childBodies.filter((body) => body.features.some((feature) => {
                        if ((feature.kind !== 'extrude' && feature.kind !== 'revolve' && feature.kind !== 'sweep') || feature.profile !== sketch.id) return false;
                        const ids = feature.profileShapes;
                        return !ids?.length || ids.every((id) => loop.shapeIds.includes(id));
                      }));
                      const loopSelection: SelectedItem = { kind: 'loop', sketchId: sketch.id, loopIndex: loop.loopIndex, shapeIds: loop.shapeIds };
                      const isLoopSelected = selectedInSet(loopSelection);
                      const loopDisplayName = loop.name;

                      return (
                        <li key={loop.id} className={styles.treeItem}>
                          <div
                            className={styles.treeRow}
                            style={{ paddingInlineStart: 18 }}
                            data-selected={isLoopSelected || undefined}
                            data-testid={`loop-${loop.id}`}
                          >
                            {loop.shapeIds.length > 0 || loopBodies.length > 0 ? (
                              <button type="button" className={styles.treeToggle} onClick={() => setOpenLoops({ ...openLoops, [loop.id]: !loopOpen })} aria-label={loopOpen ? 'Collapse' : 'Expand'}>
                                {loopOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              </button>
                            ) : (
                              <span className={styles.treeToggle} />
                            )}
                            <Spline size={13} className="u-muted" />
                            <TreeLabel
                              id={loop.id}
                              name={loopDisplayName}
                              renamingId={renamingId}
                              renameDraft={renameDraft}
                              onStartRename={(id, name) => startRename(id, name, 'loop', sketch.id)}
                              onChangeDraft={setRenameDraft}
                              onCommitRename={commitRename}
                              onCancelRename={() => setRenamingId(null)}
                              onClick={(event) => selectLayerRange(loopSelection, event)}
                            />
                            <span className={styles.treeMeta}>
                              {loop.shapeIds.length} seg
                              {multiBodies.filter((body) => bodyUsesLoop(body, sketch.id, loop)).map((body) => ` · profile of ${body.name}`).join('')}
                            </span>
                          </div>

                          {loopOpen && (loop.shapeIds.length > 0 || loopBodies.length > 0) && (
                            <ul className={styles.treeSub}>
                              {loop.shapeIds.map((shapeId, curveIndex) => {
                                const curve = sketch.shapes.find((shape) => shape.id === shapeId);
                                if (!curve) return null;
                                return (
                                  <li key={shapeId} className={styles.treeRow} style={{ paddingInlineStart: 34 }} data-selected={selectedInSet({ kind: 'shape', sketchId: sketch.id, shapeId }) || undefined}>
                                    <span className={styles.treeToggle} />
                                    <PenLine size={12} className="u-muted" />
                                    <button type="button" className={styles.treeName} onClick={(event) => selectLayerRange({ kind: 'shape', sketchId: sketch.id, shapeId }, event)}>{curve.name ?? `Curve ${curveIndex + 1}`}</button>
                                    <span className={styles.treeMeta}>{curve.kind}</span>
                                  </li>
                                );
                              })}
                              {loopBodies.map((body) => renderBody(body, 34))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                    {multiBodies.map((body) => renderBody(body, 18, `${bodyProfileCount(body, sketch)} profiles`))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {standaloneBodies.length > 0 && (
        <>
          <div className={styles.treeGroup}>Solids</div>
          <ul className={styles.tree}>
            {standaloneBodies.map((body) => {
              const error = bodyInfo[body.id]?.error;
              const open = openBodies[body.id] ?? true;
              return (
                <li key={body.id} className={styles.treeItem}>
                  <div className={styles.treeRow} data-selected={selectedInSet({ kind: 'body', id: body.id }) || undefined} data-hidden={!body.visible || undefined} data-testid={`body-${body.id}`}>
                    <button type="button" className={styles.treeToggle} onClick={() => setOpenBodies({ ...openBodies, [body.id]: !open })} aria-label={open ? 'Collapse' : 'Expand'}>
                      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <ShapeIcon shape={shapeOf(body)} />
                    <TreeLabel
                      id={body.id}
                      name={body.name}
                      renamingId={renamingId}
                      renameDraft={renameDraft}
                      onStartRename={(id, name) => startRename(id, name, 'body')}
                      onChangeDraft={setRenameDraft}
                      onCommitRename={commitRename}
                      onCancelRename={() => setRenamingId(null)}
                      onClick={(event) => selectLayerRange({ kind: 'body', id: body.id }, event)}
                    />
                    {error && (
                      <span className={styles.badge} title={error.message}>
                        <TriangleAlert size={12} />
                      </span>
                    )}
                    <IconButton label={body.visible ? 'Hide body' : 'Show body'} onClick={() => updateBody(body.id, { visible: !body.visible })}>
                      {body.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                    </IconButton>
                  </div>
                  {open && (
                    <ul className={styles.treeSub}>
                      {body.features.map((feature) => (
                        <Fragment key={feature.id}>
                        <li className={styles.treeRow} style={{ paddingInlineStart: 22 }} data-selected={selectedInSet({ kind: 'feature', bodyId: body.id, featureId: feature.id }) || undefined}>
                          <span className={styles.treeToggle} />
                          <FeatureIcon feature={feature} />
                          <TreeLabel
                            id={feature.id}
                            name={feature.name ?? featureLabel(feature, sketches, bodies)}
                            renamingId={renamingId}
                            renameDraft={renameDraft}
                            onStartRename={(_id, name) => startRename(feature.id, name, 'feature', body.id)}
                            onChangeDraft={setRenameDraft}
                            onCommitRename={commitRename}
                            onCancelRename={() => setRenamingId(null)}
                            onClick={(event) => selectLayerRange({ kind: 'feature', bodyId: body.id, featureId: feature.id }, event)}
                          />
                          {error?.featureId === feature.id && (
                            <span className={styles.badge} title={error.message}>
                              <TriangleAlert size={12} />
                            </span>
                          )}
                        </li>
                        <FeatureDriverRows feature={feature} depth={36} onSelect={select} sketches={sketches} />
                        </Fragment>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className={styles.treeGroup}>
        Cameras
        <span className={styles.groupActions}>
          {cameras.length > 0 && (
            <IconButton label={allCamerasVisible ? 'Hide all cameras' : 'Show all cameras'} onClick={() => cameras.forEach((camera) => updateCamera(camera.id, { visible: !allCamerasVisible }))}>
              {allCamerasVisible ? <Eye size={13} /> : <EyeOff size={13} />}
            </IconButton>
          )}
          <TextButton onClick={() => addCamera()} data-testid="add-camera">
            <Video size={12} /> Add
          </TextButton>
        </span>
      </div>
      {cameras.length === 0 ? (
        <p className={styles.empty}>No cameras. Add one, move it with the gizmo, right-click (or long-press) it to pilot.</p>
      ) : (
        <ul className={styles.tree}>
          {cameras.map((camera) => (
            <li key={camera.id} className={styles.treeRow} data-selected={selectedInSet({ kind: 'camera', id: camera.id, part: 'eye' }) || undefined} data-hidden={!camera.visible || undefined}>
              <span className={styles.treeToggle} />
              <Camera size={13} className="u-muted" />
              <TreeLabel
                id={camera.id}
                name={camera.name}
                renamingId={renamingId}
                renameDraft={renameDraft}
                onStartRename={(id, name) => startRename(id, name, 'camera')}
                onChangeDraft={setRenameDraft}
                onCommitRename={commitRename}
                onCancelRename={() => setRenamingId(null)}
                onClick={(event) => selectLayerRange({ kind: 'camera', id: camera.id, part: 'eye' }, event)}
              />
              <IconButton label={camera.preview ? 'Preview camera (thumbnail)' : 'Use as preview camera'} active={camera.preview} onClick={() => setPreviewCamera(camera.id)} data-testid={`preview-camera-${camera.id}`}>
                <ImageIcon size={13} />
              </IconButton>
              <IconButton label={camera.visible ? 'Hide camera' : 'Show camera'} onClick={() => updateCamera(camera.id, { visible: !camera.visible })}>
                {camera.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.treeGroup}>
        View planes
        <span className={styles.groupActions}>
          <IconButton label={allPlanesVisible ? 'Hide all planes' : 'Show all planes'} onClick={() => PLANE_IDS.forEach((id) => setPlaneVisible(id, !allPlanesVisible))}>
            {allPlanesVisible ? <Eye size={13} /> : <EyeOff size={13} />}
          </IconButton>
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <TextButton
              primary={settingWorkPlane}
              onClick={() => {
                if (settingWorkPlane) {
                  cancelSettingWorkPlane();
                } else {
                  setShowWorkPlaneMenu(!showWorkPlaneMenu);
                }
              }}
              title="Choose Surface, Reference Plane, or 3 Points"
              data-testid="set-work-plane"
            >
              <Focus size={12} /> {settingWorkPlane ? 'Cancel' : 'Set plane'}
            </TextButton>
            {showWorkPlaneMenu && !settingWorkPlane && (
              <div className={styles.treeSubMenu}>
                <button
                  type="button"
                  onClick={() => {
                    setShowWorkPlaneMenu(false);
                    startSettingWorkPlane('surface');
                  }}
                >
                  <Focus size={13} /> Surface / Face
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowWorkPlaneMenu(false);
                    startSettingWorkPlane('plane');
                  }}
                >
                  <Layers size={13} /> Reference plane
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowWorkPlaneMenu(false);
                    startSettingWorkPlane('3points');
                  }}
                >
                  <Target size={13} /> 3 Points (Origin, X, Plane)
                </button>
              </div>
            )}
          </div>
          <TextButton
            onClick={() => {
              const bounds = modelingScene.bounds();
              if (bounds) fitPlanes([bounds.max.x, bounds.max.y, bounds.max.z]);
            }}
            title="Move the planes just outside the model"
          >
            Reset
          </TextButton>
        </span>
      </div>
      <ul className={styles.tree}>
        <li className={styles.treeRow} data-selected={selectedInSet({ kind: 'workplane' }) || undefined} data-hidden={!workPlaneVisible || undefined} data-testid="work-plane-row">
          <span className={styles.treeToggle} />
          <span className={styles.swatch} style={{ background: `#${WORK_PLANE_COLOR.toString(16).padStart(6, '0')}` }} />
          <button type="button" className={styles.treeName} onClick={(event) => selectLayerRange({ kind: 'workplane' }, event)}>
            Work plane
          </button>
          <span className={styles.treeMeta}>{workPlane.kind === 'plane' ? `${PLANE_LABELS[workPlane.id]} · ${workPlane.offset} mm` : 'Model surface'}</span>
          <IconButton label={workPlaneVisible ? 'Hide work plane' : 'Show work plane'} onClick={() => setWorkPlaneVisible(!workPlaneVisible)}>
            {workPlaneVisible ? <Eye size={13} /> : <EyeOff size={13} />}
          </IconButton>
        </li>
        {PLANE_IDS.map((id) => (
          <li key={id} className={styles.treeRow} data-selected={selectedInSet({ kind: 'plane', id }) || undefined} data-hidden={!planeVisible[id] || undefined}>
            <span className={styles.treeToggle} />
            <span className={styles.swatch} style={{ background: `#${PLANE_COLORS[id].toString(16).padStart(6, '0')}` }} />
            <button type="button" className={styles.treeName} onClick={(event) => (settingWorkPlane ? setWorkPlane({ kind: 'plane', id, offset: planes[id] }) : selectLayerRange({ kind: 'plane', id }, event))}>
              {PLANE_LABELS[id]}
            </button>
            <span className={styles.treeMeta}>{planes[id]} mm</span>
            <IconButton label={planeVisible[id] ? 'Hide plane' : 'Show plane'} onClick={() => setPlaneVisible(id, !planeVisible[id])}>
              {planeVisible[id] ? <Eye size={13} /> : <EyeOff size={13} />}
            </IconButton>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---- inspector ------------------------------------------------------------------------------

function Vec3Fields({ label, value, suffix, precision = 0, onCommit, path }: { label: string; value: [number, number, number]; suffix?: string; precision?: number; onCommit: (next: [number, number, number]) => void; /** Field path prefix: each axis can then be driven by a formula. */ path?: string }) {
  const axes = ['X', 'Y', 'Z'] as const;
  return (
    <div className={styles.row3}>
      {axes.map((axis, index) => (
        <Field key={axis} label={`${label} ${axis}`}>
          <ParamNumber
            path={path ? `${path}/${index}` : null}
            ariaLabel={`${label} ${axis}`}
            value={value[index]!}
            unit={suffix ? undefined : 'mm'}
            suffix={suffix}
            precision={precision}
            onCommit={(v) => {
              const next = [...value] as [number, number, number];
              next[index] = v;
              onCommit(next);
            }}
          />
        </Field>
      ))}
    </div>
  );
}

/** Kernel timings for the spike: how long the WASM took to start and the last evaluation took. */
function useKernelStats() {
  const [, bump] = useState(0);
  useEffect(() => kernel.onStats(() => bump((n) => n + 1)), []);
  return kernel.stats;
}

function BodyInspector({ body }: { body: Body }) {
  const info = useModeling((s) => s.bodyInfo[body.id]);
  const materials = useModeling((s) => s.materials);
  const updateBody = useModeling((s) => s.updateBody);
  const updateFeature = useModeling((s) => s.updateFeature);
  const setBodyPlacement = useModeling((s) => s.setBodyPlacement);
  const removeBody = useModeling((s) => s.removeBody);
  const convertBodyToSolid = useModeling((s) => s.convertBodyToSolid);
  const stats = useKernelStats();
  const primitive = body.features[0]?.kind === 'primitive' ? body.features[0] : null;
  const parametric = body.features.some((feature) => feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep');
  const materialOptions = Object.entries(materials)
    .map(([value, material]) => ({ value, label: material.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const ms = (value: number | null) => (value === null ? '—' : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`);
  return (
    <>
      <Field label="Name">
        <TextField value={body.name} onCommit={(name) => updateBody(body.id, { name })} ariaLabel="Body name" />
      </Field>
      <ToggleRow label="Visible" value={body.visible} onChange={(visible) => updateBody(body.id, { visible })} />
      <ToggleRow label="Part of the low LOD" value={body.lowLod} onChange={(lowLod) => updateBody(body.id, { lowLod })} />
      <Field label="Material">
        <SelectField value={materials[body.material] ? body.material : materialOptions[0]?.value ?? body.material} options={materialOptions} onChange={(material) => updateBody(body.id, { material })} ariaLabel="Body material" />
      </Field>
      {info?.error && (
        <p className={styles.errorNote} role="alert">
          <TriangleAlert size={13} /> {info.error.message}
        </p>
      )}
      {primitive && (
        <>
          <div className={styles.treeGroup}>Shape</div>
          <Field label="Shape">
            <SelectField value={primitive.shape} options={SHAPE_OPTIONS} onChange={(shape) => updateFeature(body.id, primitive.id, { shape })} ariaLabel="Primitive shape" />
          </Field>
          <div className={styles.row3}>
            {(['Width', 'Height', 'Depth'] as const).map((label, index) => (
              <Field key={label} label={label}>
                <ParamNumber
                  path={fieldPath('feature', body.id, primitive.id, 'size', index)}
                  ariaLabel={label}
                  value={primitive.size[index]!}
                  unit="mm"
                  precision={0}
                  min={1}
                  disabled={primitive.shape !== 'box' && index === 2}
                  onCommit={(value) => {
                    const size = [...primitive.size] as [number, number, number];
                    size[index] = value;
                    // Round shapes are as deep as they are wide; a sphere is as tall too.
                    if (primitive.shape !== 'box') size[2] = size[0];
                    if (primitive.shape === 'sphere') size[1] = size[0];
                    updateFeature(body.id, primitive.id, { size });
                  }}
                />
              </Field>
            ))}
          </div>
        </>
      )}
      <div className={styles.treeGroup}>Placement</div>
      <Vec3Fields label="Position" path={fieldPath('body', body.id, 'placement', 'position')} value={body.placement.position} onCommit={(position) => setBodyPlacement(body.id, { ...body.placement, position })} />
      <Vec3Fields label="Rotation" path={fieldPath('body', body.id, 'placement', 'rotation')} value={body.placement.rotation} suffix="°" onCommit={(rotation) => setBodyPlacement(body.id, { ...body.placement, rotation })} />
      <Vec3Fields label="Scale" value={body.placement.scale ?? [1, 1, 1]} suffix="×" precision={2} onCommit={(scale) => setBodyPlacement(body.id, { ...body.placement, scale: scale.map((value) => Math.max(0.01, value)) as [number, number, number] })} />
      <dl className={styles.facts}>
        <dt>Triangles</dt>
        <dd>{info ? info.triangles.toLocaleString() : '…'}</dd>
        <dt>Volume</dt>
        <dd>{info ? `${(info.volume / 1e9).toFixed(3)} m³` : '…'}</dd>
        <dt>Kernel</dt>
        <dd title="Time to start the Manifold worker / time of the last evaluation">
          {ms(stats.initMs)} start · {ms(stats.lastMs)} eval
        </dd>
      </dl>
      {parametric && (
        <TextButton onClick={() => {
          const mesh = modelingScene.bodyMeshData(body.id);
          if (mesh) convertBodyToSolid(body.id, mesh.positions, mesh.indices);
        }} title="Bake the current result and remove its profile, axis, and path links">
          <Box size={13} /> Free / Convert to Solid
        </TextButton>
      )}
      <TextButton onClick={() => removeBody(body.id)}>
        <Trash2 size={13} /> Delete body
      </TextButton>
    </>
  );
}

function SketchInspector({ sketch }: { sketch: Sketch }) {
  const updateSketch = useModeling((s) => s.updateSketch);
  const removeSketch = useModeling((s) => s.removeSketch);
  const removeShape = useModeling((s) => s.removeShape);
  const select = useModeling((s) => s.select);
  const bodies = useModeling((s) => s.bodies);
  const setTool = useSelectTool();
  const users = bodies.filter((body) => body.features.some((feature) => (feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sweep') && feature.profile === sketch.id));
  const bounds = shapesBounds(sketch.shapes);
  return (
    <>
      <Field label="Name">
        <TextField value={sketch.name} onCommit={(name) => updateSketch(sketch.id, { name })} ariaLabel="Sketch name" />
      </Field>
      <ToggleRow label="Visible" value={sketch.visible} onChange={(visible) => updateSketch(sketch.id, { visible })} />
      <dl className={styles.facts}>
        <dt>Plane</dt>
        <dd>{sketch.plane.kind === 'plane' ? `${PLANE_LABELS[sketch.plane.id]} at ${sketch.plane.offset} mm` : 'Face of a body'} (fixed)</dd>
        <dt>Size</dt>
        <dd>{bounds ? `${Math.round(bounds.max[0] - bounds.min[0])} × ${Math.round(bounds.max[1] - bounds.min[1])} mm` : '—'}</dd>
        <dt>Used by</dt>
        <dd>{users.length > 0 ? users.map((body) => body.name).join(', ') : '—'}</dd>
      </dl>
      <Field label="Corner radius">
        <NumberField value={sketch.cornerRadius ?? 0} unit="mm" precision={0} min={0} onCommit={(cornerRadius) => updateSketch(sketch.id, { cornerRadius })} ariaLabel="Corner radius" />
      </Field>
      <div className={styles.treeGroup}>Shapes</div>
      {sketch.shapes.length === 0 ? (
        <p className={styles.empty}>Empty. Draw with the sketch tools in a 2D pane.</p>
      ) : (
        <ul className={styles.tree}>
          {sketch.shapes.map((shape) => (
            <li key={shape.id} className={styles.treeRow}>
              <span className={styles.treeToggle} />
              <button type="button" className={styles.treeName} onClick={() => select({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id })}>
                {shapeLabel(shape)}
              </button>
              <IconButton label="Delete shape" onClick={() => removeShape(sketch.id, shape.id)}>
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        <TextButton primary onClick={() => setTool('extrude')}>
          <ArrowUpFromLine size={13} /> Extrude
        </TextButton>
        <TextButton onClick={() => removeSketch(sketch.id)}>
          <Trash2 size={13} /> Delete sketch
        </TextButton>
      </div>
    </>
  );
}

function ShapeInspector({ sketch, shape }: { sketch: Sketch; shape: Shape2D }) {
  const updateShape = useModeling((s) => s.updateShape);
  const removeShape = useModeling((s) => s.removeShape);
  const select = useModeling((s) => s.select);
  const set = (patch: Partial<Shape2D>) => updateShape(sketch.id, { ...shape, ...patch } as Shape2D);
  const at = (...field: (string | number)[]) => fieldPath('shape', sketch.id, shape.id, ...field);
  const mm = (label: string, value: number, onCommit: (value: number) => void, min?: number, field: (string | number)[] = [label.toLowerCase()], scale?: number) => (
    <Field key={label} label={label}>
      <ParamNumber path={at(...field)} scale={scale} value={value} unit="mm" precision={0} min={min} onCommit={onCommit} ariaLabel={label} />
    </Field>
  );
  return (
    <>
      <p className={styles.empty}>
        In{' '}
        <button type="button" className={styles.link} onClick={() => select({ kind: 'sketch', id: sketch.id })}>
          {sketch.name}
        </button>{' '}
        ({planeLabel(sketch.plane)})
      </p>
      <Field label="Offset (grow / shrink)">
        <ParamNumber path={at('offset')} value={shape.offset ?? 0} unit="mm" precision={0} onCommit={(offset) => set({ offset })} ariaLabel="Shape offset" />
      </Field>
      {shape.kind === 'rect' && (
        <>
          <FieldRow>
            {mm('X', shape.x, (x) => set({ x }))}
            {mm('Y', shape.y, (y) => set({ y }))}
          </FieldRow>
          <FieldRow>
            {mm('Width', shape.width, (width) => set({ width }), 1)}
            {mm('Height', shape.height, (height) => set({ height }), 1)}
          </FieldRow>
        </>
      )}
      {(shape.kind === 'circle' || shape.kind === 'polygon') && (
        <>
          <FieldRow>
            {mm('Centre X', shape.cx, (cx) => set({ cx }), undefined, ['cx'])}
            {mm('Centre Y', shape.cy, (cy) => set({ cy }), undefined, ['cy'])}
          </FieldRow>
          <FieldRow>
            {mm(shape.kind === 'circle' ? 'Diameter' : 'Radius', shape.kind === 'circle' ? shape.radius * 2 : shape.radius, (value) => set({ radius: shape.kind === 'circle' ? value / 2 : value }), 1, ['radius'], shape.kind === 'circle' ? 0.5 : undefined)}
            {shape.kind === 'polygon' ? (
              <Field label="Sides">
                <ParamNumber path={at('sides')} value={shape.sides} precision={0} min={3} max={24} onCommit={(sides) => set({ sides: Math.round(sides) })} ariaLabel="Sides" />
              </Field>
            ) : (
              <span />
            )}
          </FieldRow>
          {shape.kind === 'polygon' && (
            <Field label="Rotation">
              <ParamNumber path={at('rotation')} value={shape.rotation} suffix="°" precision={0} onCommit={(rotation) => set({ rotation })} ariaLabel="Rotation" />
            </Field>
          )}
        </>
      )}
      {shape.kind === 'polyline' && (
        <ul className={styles.tree}>
          {shape.points.map(([x, y], index) => (
            <li key={index} className={styles.row3}>
              <span className={styles.treeMeta}>{index + 1}</span>
              <ParamNumber
                path={at('points', index, 0)}
                ariaLabel={`Point ${index + 1} X`}
                value={x}
                unit="mm"
                precision={0}
                onCommit={(value) => set({ points: shape.points.map((point, i) => (i === index ? [value, point[1]] : point)) })}
              />
              <ParamNumber
                path={at('points', index, 1)}
                ariaLabel={`Point ${index + 1} Y`}
                value={y}
                unit="mm"
                precision={0}
                onCommit={(value) => set({ points: shape.points.map((point, i) => (i === index ? [point[0], value] : point)) })}
              />
            </li>
          ))}
        </ul>
      )}
      <TextButton onClick={() => removeShape(sketch.id, shape.id)}>
        <Trash2 size={13} /> Delete shape
      </TextButton>
    </>
  );
}

function FeatureInspector({ body, feature }: { body: Body; feature: Feature }) {
  const sketches = useModeling((s) => s.sketches);
  const bodies = useModeling((s) => s.bodies);
  const info = useModeling((s) => s.bodyInfo[body.id]);
  const updateFeature = useModeling((s) => s.updateFeature);
  const removeFeature = useModeling((s) => s.removeFeature);
  const select = useModeling((s) => s.select);
  const set = (patch: Partial<Feature>) => updateFeature(body.id, feature.id, patch);
  const at = (...field: (string | number)[]) => fieldPath('feature', body.id, feature.id, ...field);
  const sketchOptions = sketches.map((sketch) => ({ value: sketch.id, label: `${sketch.name} (${planeLabel(sketch.plane)})` }));
  const error = info?.error?.featureId === feature.id ? info.error : null;
  return (
    <>
      <p className={styles.empty}>
        Feature {body.features.indexOf(feature) + 1} of{' '}
        <button type="button" className={styles.link} onClick={() => select({ kind: 'body', id: body.id })}>
          {body.name}
        </button>
      </p>
      {error && (
        <p className={styles.errorNote} role="alert">
          <TriangleAlert size={13} /> {error.message}
        </p>
      )}
      {feature.kind === 'extrude' && (
        <>
          <Field label="Profile">
            <SelectField value={feature.profile} options={sketchOptions.length > 0 ? sketchOptions : [{ value: feature.profile, label: 'Missing sketch' }]} onChange={(profile) => set({ profile })} ariaLabel="Extrude profile" />
          </Field>
          <FieldRow>
            <Field label="Distance">
              <ParamNumber path={at('distance')} value={feature.distance} unit="mm" precision={0} onCommit={(distance) => set({ distance })} ariaLabel="Extrude distance" />
            </Field>
            <Field label="Operation">
              <SelectField value={feature.op} options={OP_OPTIONS} onChange={(op) => set({ op })} ariaLabel="Extrude operation" />
            </Field>
          </FieldRow>
          <ToggleRow label="Symmetric (both sides of the plane)" value={feature.symmetric ?? false} onChange={(symmetric) => set({ symmetric })} />
        </>
      )}
      {feature.kind === 'primitive' && (
        <>
          <Field label="Shape">
            <SelectField value={feature.shape} options={SHAPE_OPTIONS} onChange={(shape) => set({ shape })} ariaLabel="Primitive shape" />
          </Field>
          <div className={styles.row3}>
            {(['Width', 'Height', 'Depth'] as const).map((label, index) => (
              <Field key={label} label={label}>
                <ParamNumber
                  path={at('size', index)}
                  ariaLabel={label}
                  value={feature.size[index]!}
                  unit="mm"
                  precision={0}
                  min={1}
                  onCommit={(value) => {
                    const size = [...feature.size] as [number, number, number];
                    size[index] = value;
                    set({ size });
                  }}
                />
              </Field>
            ))}
          </div>
          <Vec3Fields label="Offset" path={at('placement', 'position')} value={feature.placement.position} onCommit={(position) => set({ placement: { ...feature.placement, position } })} />
        </>
      )}
      {feature.kind === 'transform' && (
        <>
          <Vec3Fields label="Move" path={at('translate')} value={feature.translate ?? [0, 0, 0]} onCommit={(translate) => set({ translate })} />
          <Vec3Fields label="Rotate" path={at('rotate')} value={feature.rotate ?? [0, 0, 0]} suffix="°" onCommit={(rotate) => set({ rotate })} />
        </>
      )}
      {feature.kind === 'revolve' && (
        <>
          <Field label="Profile">
            <SelectField value={feature.profile} options={sketchOptions.length > 0 ? sketchOptions : [{ value: feature.profile, label: 'Missing sketch' }]} onChange={(profile) => set({ profile })} ariaLabel="Revolve profile" />
          </Field>
          <FieldRow>
            <Field label="Axis origin u">
              <ParamNumber path={at('axis', 'origin', 0)} ariaLabel="Axis origin u" value={feature.axis.origin[0]} unit="mm" precision={0} onCommit={(u) => set({ axis: { ...feature.axis, origin: [u, feature.axis.origin[1]] } })} />
            </Field>
            <Field label="Axis origin v">
              <ParamNumber path={at('axis', 'origin', 1)} ariaLabel="Axis origin v" value={feature.axis.origin[1]} unit="mm" precision={0} onCommit={(v) => set({ axis: { ...feature.axis, origin: [feature.axis.origin[0], v] } })} />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Direction u">
              <NumberField value={feature.axis.direction[0]} precision={2} onCommit={(u) => set({ axis: { ...feature.axis, direction: [u, feature.axis.direction[1]] } })} />
            </Field>
            <Field label="Direction v">
              <NumberField value={feature.axis.direction[1]} precision={2} onCommit={(v) => set({ axis: { ...feature.axis, direction: [feature.axis.direction[0], v] } })} />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Angle">
              <ParamNumber path={at('angle')} ariaLabel="Revolve angle" value={feature.angle} suffix="°" precision={0} min={1} max={360} onCommit={(angle) => set({ angle })} />
            </Field>
            <Field label="Operation">
              <SelectField value={feature.op} options={OP_OPTIONS} onChange={(op) => set({ op })} ariaLabel="Revolve operation" />
            </Field>
          </FieldRow>
        </>
      )}
      {feature.kind === 'mirror' && (
        <>
          <FieldRow>
            <Field label="Across axis">
              <SelectField value={feature.axis} options={AXIS_OPTIONS} onChange={(axis) => set({ axis })} ariaLabel="Mirror axis" />
            </Field>
            <Field label="At">
              <ParamNumber path={at('offset')} ariaLabel="Mirror position" value={feature.offset} unit="mm" precision={0} onCommit={(offset) => set({ offset })} />
            </Field>
          </FieldRow>
          <ToggleRow label="Keep the original" value={feature.keepOriginal} onChange={(keepOriginal) => set({ keepOriginal })} />
        </>
      )}
      {feature.kind === 'pattern' && (
        <>
          <FieldRow>
            <Field label="Mode">
              <SelectField<'linear' | 'radial'>
                value={feature.mode}
                options={[
                  { value: 'linear', label: 'Linear' },
                  { value: 'radial', label: 'Radial' },
                ]}
                onChange={(mode) => updateFeature(body.id, feature.id, mode === 'linear' ? { kind: 'pattern', id: feature.id, mode: 'linear', count: feature.count, step: [200, 0, 0] } : { kind: 'pattern', id: feature.id, mode: 'radial', count: feature.count, axis: 'y', center: [0, 0, 0], angle: 360 })}
                ariaLabel="Pattern mode"
              />
            </Field>
            <Field label="Count">
              <ParamNumber path={at('count')} ariaLabel="Pattern count" value={feature.count} precision={0} min={1} max={200} onCommit={(count) => set({ count: Math.round(count) })} />
            </Field>
          </FieldRow>
          {feature.mode === 'linear' ? (
            <Vec3Fields label="Step" path={at('step')} value={feature.step} onCommit={(step) => set({ step })} />
          ) : (
            <>
              <FieldRow>
                <Field label="Axis">
                  <SelectField value={feature.axis} options={AXIS_OPTIONS} onChange={(axis) => set({ axis })} ariaLabel="Pattern axis" />
                </Field>
                <Field label="Sweep">
                  <ParamNumber path={at('angle')} ariaLabel="Pattern sweep" value={feature.angle} suffix="°" precision={0} min={1} max={360} onCommit={(angle) => set({ angle })} />
                </Field>
              </FieldRow>
              <Vec3Fields label="Centre" path={at('center')} value={feature.center} onCommit={(center) => set({ center })} />
            </>
          )}
        </>
      )}
      {feature.kind === 'boolean' && (
        <FieldRow>
          <Field label="Operation">
            <SelectField value={feature.op} options={BOOLEAN_OPTIONS} onChange={(op) => set({ op })} ariaLabel="Boolean operation" />
          </Field>
          <Field label="Tool body">
            <SelectField value={feature.tool} options={bodies.filter((item) => item.id !== body.id).map((item) => ({ value: item.id, label: item.name })).concat(bodies.some((item) => item.id === feature.tool) ? [] : [{ value: feature.tool, label: 'Missing body' }])} onChange={(tool) => set({ tool })} ariaLabel="Boolean tool body" />
          </Field>
        </FieldRow>
      )}
      <TextButton onClick={() => removeFeature(body.id, feature.id)}>
        <Trash2 size={13} /> Delete feature
      </TextButton>
    </>
  );
}

/** The asset's materials: a swatch list, the selected one's PBR values, and paint. */
function MaterialsPanel() {
  const materials = useModeling((s) => s.materials);
  const updateMaterial = useModeling((s) => s.updateMaterial);
  const paintMaterial = useModeling((s) => s.toolOptions.paintMaterial);
  const setToolOptions = useModeling((s) => s.setToolOptions);
  const selection = useModeling((s) => s.selection);
  const updateBody = useModeling((s) => s.updateBody);
  const setTool = useSelectTool();
  const entries = Object.entries(materials).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const current = materials[paintMaterial] ? paintMaterial : (entries[0]?.[0] ?? paintMaterial);
  const material = materials[current];
  const selectedBody = selection?.kind === 'body' ? selection.id : null;
  const addMaterial = () => {
    const base = material ?? { name: 'Material', color: '#9a9aa3', roughness: 0.8, metalness: 0, opacity: 1 };
    const id = `material-${Date.now().toString(36)}`;
    updateMaterial(id, { ...base, name: `${base.name} copy` });
    setToolOptions({ paintMaterial: id });
  };
  return (
    <Panel
      title="Materials"
      defaultOpen={false}
      action={
        <TextButton onClick={addMaterial} title="Duplicate the selected material as a new one">
          <Plus size={12} /> Add
        </TextButton>
      }
    >
      <div className={styles.swatches}>
        {entries.map(([id, item]) => (
          <button key={id} type="button" className={styles.swatchButton} data-active={id === current || undefined} title={item.name} onClick={() => setToolOptions({ paintMaterial: id })} data-testid={`material-${id}`}>
            <span className={styles.swatchChip} style={{ background: item.color, opacity: Math.max(0.35, item.opacity) }} />
          </button>
        ))}
      </div>
      {material && (
        <>
          <Field label="Name">
            <TextField value={material.name} onCommit={(name) => updateMaterial(current, { name })} ariaLabel="Material name" />
          </Field>
          <Field label="Colour">
            <ColorField value={material.color} onCommit={(color) => color && updateMaterial(current, { color })} ariaLabel="Material colour" />
          </Field>
          <div className={styles.row3}>
            <Field label="Roughness">
              <NumberField value={material.roughness} precision={2} min={0} max={1} step={0.05} onCommit={(roughness) => updateMaterial(current, { roughness })} />
            </Field>
            <Field label="Metalness">
              <NumberField value={material.metalness} precision={2} min={0} max={1} step={0.05} onCommit={(metalness) => updateMaterial(current, { metalness })} />
            </Field>
            <Field label="Opacity">
              <NumberField value={material.opacity} precision={2} min={0.05} max={1} step={0.05} onCommit={(opacity) => updateMaterial(current, { opacity })} />
            </Field>
          </div>
          <div className={styles.actions}>
            <TextButton primary disabled={!selectedBody} onClick={() => selectedBody && updateBody(selectedBody, { material: current })} title="Give the selected body this material">
              Apply to body
            </TextButton>
            <TextButton onClick={() => setTool('paint')}>
              <PaintBucket size={13} /> Paint (K)
            </TextButton>
          </div>
        </>
      )}
    </Panel>
  );
}

function InspectorPanel({ assetId }: { assetId: string }) {
  const selection = useModeling((s) => s.selection);
  const layers = useModeling((s) => s.layers);
  const bodies = useModeling((s) => s.bodies);
  const sketches = useModeling((s) => s.sketches);
  const cameras = useModeling((s) => s.cameras);
  const planes = useModeling((s) => s.planes);
  const workPlane = useModeling((s) => s.workPlane);
  const moveWorkPlane = useModeling((s) => s.moveWorkPlane);
  const workPlaneLocked = useModeling((s) => s.workPlaneLocked);
  const setWorkPlaneLocked = useModeling((s) => s.setWorkPlaneLocked);
  const flipWorkPlane = useModeling((s) => s.flipWorkPlane);
  const rotateWorkPlane = useModeling((s) => s.rotateWorkPlane);
  const resetWorkPlane = useModeling((s) => s.resetWorkPlane);
  const modelSize = useModeling((s) => s.modelSize);
  const updateLayer = useModeling((s) => s.updateLayer);
  const removeLayer = useModeling((s) => s.removeLayer);
  const setNodeVisible = useModeling((s) => s.setNodeVisible);
  const updateCamera = useModeling((s) => s.updateCamera);
  const removeCamera = useModeling((s) => s.removeCamera);
  const setPreviewCamera = useModeling((s) => s.setPreviewCamera);
  const setPlane = useModeling((s) => s.setPlane);
  const setPane = useModeling((s) => s.setPane);
  const activePane = useModeling((s) => s.activePane);
  const select = useModeling((s) => s.select);

  let body: ReactNode;
  let title = 'Inspector';
  if (selection?.kind === 'body') {
    const selected = findBody(bodies, selection.id);
    if (selected) {
      title = 'Body';
      body = <BodyInspector body={selected} />;
    }
  } else if (selection?.kind === 'feature') {
    const selected = findBody(bodies, selection.bodyId);
    const feature = selected?.features.find((item) => item.id === selection.featureId);
    if (selected && feature) {
      title = featureTitle(feature);
      body = <FeatureInspector body={selected} feature={feature} />;
    }
  } else if (selection?.kind === 'sketch') {
    const sketch = findSketch(sketches, selection.id);
    if (sketch) {
      title = 'Sketch';
      body = <SketchInspector sketch={sketch} />;
    }
  } else if (selection?.kind === 'shape' || selection?.kind === 'curve-point') {
    const sketch = findSketch(sketches, selection.sketchId);
    const shape = sketch?.shapes.find((item) => item.id === selection.shapeId);
    if (sketch && shape) {
      title = selection.kind === 'curve-point' ? `Point ${selection.pointIndex + 1}` : shapeLabel(shape).split(' ')[0]!;
      body = <ShapeInspector sketch={sketch} shape={shape} />;
    }
  } else if (selection?.kind === 'face') {
    const selected = findBody(bodies, selection.bodyId);
    if (selected) {
      title = 'Face';
      body = (
        <>
          <p className={styles.empty}>
            Face {selection.faceId} of{' '}
            <button type="button" className={styles.link} onClick={() => select({ kind: 'body', id: selected.id })}>
              {selected.name}
            </button>
          </p>
          <p className={styles.empty}>Push/pull: drag the arrow in a 3D pane, or type a distance in the options bar and press Enter. Pulling out adds material, pushing in cuts.</p>
        </>
      );
    }
  } else if (selection?.kind === 'layer') {
    const layer = layers.find((item) => item.id === selection.id);
    if (layer) {
      title = 'Layer';
      const count = (nodes: LayerNode[]): [number, number] => nodes.reduce<[number, number]>((sum, node) => [sum[0] + 1 + count(node.children)[0], sum[1] + node.triangles + count(node.children)[1]], [0, 0]);
      const [nodeCount, triangles] = count(layer.nodes);
      body = (
        <>
          <Field label="Name">
            <TextField value={layer.name} onCommit={(name) => updateLayer(layer.id, { name })} ariaLabel="Layer name" />
          </Field>
          <ToggleRow label="Visible" value={layer.visible} onChange={(visible) => updateLayer(layer.id, { visible })} />
          <ToggleRow label="Part of the low LOD" value={layer.lowLod} onChange={(lowLod) => updateLayer(layer.id, { lowLod })} />
          <Field label="Import scale">
            <NumberField value={layer.scale} suffix="×" precision={3} min={0.0001} onCommit={(scale) => updateLayer(layer.id, { scale, size: modelingScene.setLayerScale(layer.id, scale) })} ariaLabel="Import scale" />
          </Field>
          <dl className={styles.facts}>
            <dt>Size</dt>
            <dd>
              {layer.size[0]} × {layer.size[2]} × {layer.size[1]} mm
            </dd>
            <dt>Nodes</dt>
            <dd>{nodeCount}</dd>
            <dt>Triangles</dt>
            <dd>{triangles.toLocaleString()}</dd>
          </dl>
          <TextButton
            onClick={() => {
              modelingScene.removeLayer(layer.id);
              removeLayer(layer.id);
              void modelingStorage.deleteFile(assetId, layer.id);
            }}
          >
            <Trash2 size={13} /> Delete layer
          </TextButton>
        </>
      );
    }
  } else if (selection?.kind === 'node') {
    const layer = layers.find((item) => item.id === selection.layerId);
    const node = layer ? findNode(layer.nodes, selection.nodeId) : null;
    if (layer && node) {
      title = node.triangles > 0 ? 'Mesh' : 'Node';
      body = (
        <>
          <dl className={styles.facts}>
            <dt>Name</dt>
            <dd>{node.name}</dd>
            <dt>Layer</dt>
            <dd>{layer.name}</dd>
            <dt>Children</dt>
            <dd>{node.children.length}</dd>
            {node.triangles > 0 && (
              <>
                <dt>Vertices</dt>
                <dd>{node.vertices.toLocaleString()}</dd>
                <dt>Triangles</dt>
                <dd>{node.triangles.toLocaleString()}</dd>
                <dt>Materials</dt>
                <dd>{node.materials.join(', ') || '—'}</dd>
              </>
            )}
          </dl>
          <ToggleRow label="Visible" value={node.visible} onChange={(visible) => setNodeVisible(layer.id, node.id, visible)} />
        </>
      );
    }
  } else if (selection?.kind === 'plane') {
    title = PLANE_LABELS[selection.id];
    const axis = PLANE_AXIS[selection.id];
    body = (
      <>
        <Field label={`Position along ${axis.toUpperCase()}`}>
          <NumberField value={planes[selection.id]} unit="mm" precision={0} onCommit={(value) => setPlane(selection.id, value)} ariaLabel="Plane position" />
        </Field>
        <p className={styles.empty}>The {selection.id} view looks at this plane and cuts the model there. Drag it in 3D or type the position.</p>
      </>
    );
  } else if (selection?.kind === 'reference') {
    const target = selection.target;
    title = target.kind === 'vertex' ? 'Project vertex' : target.kind === 'edge' ? 'Project edge' : 'Project face';
    const trace = () => {
      const state = modelingStore.getState();
      const shapes = traceOntoPlane(state.workPlane, target, newShapeId);
      if (!shapes.length) {
        window.alert('This part is edge-on to the work plane, so tracing it would give a flat line. Put the work plane on the face first (Work plane on face), then trace.');
        return;
      }
      const sketchId = state.sketches.find((sketch) => samePlane(sketch.plane, state.workPlane))?.id ?? state.addSketch(state.workPlane);
      for (const shape of shapes) modelingStore.getState().addShape(sketchId, shape);
      modelingStore.getState().select({ kind: 'sketch', id: sketchId });
    };
    body = (
      <>
        <dl className={styles.facts}>
          {topologyFacts(target).map((fact) => (
            <Fragment key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></Fragment>
          ))}
        </dl>
        <div className={styles.actions}>
          {target.kind === 'face' ? (
            <TextButton disabled={workPlaneLocked} onClick={() => modelingStore.getState().setWorkPlane(planeOnFace(target))}><PencilRuler size={13} /> Work plane on face</TextButton>
          ) : (
            <TextButton disabled={workPlaneLocked} onClick={() => modelingStore.getState().setWorkPlane(planeThroughPoint(modelingStore.getState().workPlane, target.kind === 'vertex' ? target.point : target.a))}><PencilRuler size={13} /> Move work plane here</TextButton>
          )}
          {target.kind !== 'vertex' && <TextButton onClick={trace}><PenLine size={13} /> Trace onto work plane</TextButton>}
        </div>
        <p className={styles.empty}>The project is a locked reference: pick its parts to place the work plane or trace outlines to model from. Its vertices and edges are also snap targets while drawing.</p>
      </>
    );
  } else if (selection?.kind === 'workplane') {
    const frame = workPlane.kind === 'custom' ? workPlane : null;
    const planePosition = workPlane.kind === 'plane' ? workPlane.offset : dot(planeFrame(workPlane).origin, planeFrame(workPlane).normal);
    title = 'Work plane';
    body = (
      <>
        <dl className={styles.facts}>
          <dt>Matched to</dt>
          <dd>{workPlane.kind === 'plane' ? PLANE_LABELS[workPlane.id] : 'Model surface'}</dd>
          {workPlane.kind === 'plane' ? (
            <><dt>Position</dt><dd>{workPlane.offset} mm</dd></>
          ) : (
            <><dt>Origin</dt><dd>{frame!.origin.map((value) => Math.round(value)).join(', ')} mm</dd><dt>Normal</dt><dd>{frame!.normal.map((value) => value.toFixed(2)).join(', ')}</dd></>
          )}
        </dl>
        <Field label="Offset along normal">
          <NumberField
            value={planePosition}
            unit="mm"
            precision={0}
            onCommit={(value) => {
              const current = modelingStore.getState().workPlane;
              const frameNow = planeFrame(current);
              const currentPosition = current.kind === 'plane' ? current.offset : dot(frameNow.origin, frameNow.normal);
              moveWorkPlane(value - currentPosition);
            }}
            ariaLabel="Work plane offset"
          />
        </Field>
        <ToggleRow label="Lock work plane" value={workPlaneLocked} onChange={setWorkPlaneLocked} />
        <FieldRow>
          <Field label="Rotate local X">
            <NumberField value={0} suffix="°" precision={1} onCommit={(degrees) => degrees && rotateWorkPlane('x', degrees)} ariaLabel="Rotate work plane around local X" />
          </Field>
          <Field label="Rotate local Y">
            <NumberField value={0} suffix="°" precision={1} onCommit={(degrees) => degrees && rotateWorkPlane('y', degrees)} ariaLabel="Rotate work plane around local Y" />
          </Field>
        </FieldRow>
        <div className={styles.actions}>
          <TextButton disabled={workPlaneLocked} onClick={() => flipWorkPlane()}>Flip normal</TextButton>
          <TextButton disabled={workPlaneLocked} onClick={() => resetWorkPlane('top')}>Reset to Top</TextButton>
          <TextButton onClick={() => setPane(activePane, 'workplane')}><PencilRuler size={13} /> Look square-on</TextButton>
        </div>
        <p className={styles.empty}>Offsets, flips and rotations preserve the current camera. Draw from the existing perspective view; “Look square-on” is optional.</p>
      </>
    );
  } else if (selection?.kind === 'camera') {
    const camera = cameras.find((item) => item.id === selection.id);
    if (camera) {
      title = 'Camera';
      body = (
        <>
          <Field label="Name">
            <TextField value={camera.name} onCommit={(name) => updateCamera(camera.id, { name })} ariaLabel="Camera name" />
          </Field>
          <ToggleRow label="Preview camera (thumbnail)" value={camera.preview} onChange={(on) => on && setPreviewCamera(camera.id)} />
          <Vec3Fields label="Eye" value={camera.eye} onCommit={(eye) => updateCamera(camera.id, { eye })} />
          <Vec3Fields label="Aim" value={camera.aim} onCommit={(aim) => updateCamera(camera.id, { aim })} />
          <FieldRow>
            <Field label="Field of view">
              <NumberField value={camera.fov} suffix="°" precision={0} min={10} max={140} onCommit={(fov) => updateCamera(camera.id, { fov })} />
            </Field>
          </FieldRow>
          <div className={styles.actions}>
            <TextButton primary onClick={() => setPane(activePane, `camera:${camera.id}`)}>
              Pilot in active pane
            </TextButton>
            <TextButton onClick={() => removeCamera(camera.id)}>
              <Trash2 size={13} /> Delete
            </TextButton>
          </div>
        </>
      );
    }
  }
  if (!body) {
    body = (
      <>
        <p className={styles.empty}>Select a body, feature, sketch, shape, layer, camera, reference plane, or work plane to see its settings.</p>
        <dl className={styles.facts}>
          <dt>Model size</dt>
          <dd>{modelSize[0] > 0 ? `${modelSize[0]} × ${modelSize[2]} × ${modelSize[1]} mm` : '—'}</dd>
          <dt>Bodies</dt>
          <dd>{bodies.length}</dd>
          <dt>Sketches</dt>
          <dd>{sketches.length}</dd>
          <dt>Layers</dt>
          <dd>{layers.length}</dd>
          <dt>Cameras</dt>
          <dd>{cameras.length}</dd>
        </dl>
      </>
    );
  }
  return <Panel title={title} storageKey="inspector" defaultOpen={false}>{body}</Panel>;
}

/** Whether Delete (key or touch button) has something to remove. */
function deletableSelection(selection: ModelingState['selection']): boolean {
  const kind = selection?.kind;
  return kind === 'body' || kind === 'face' || kind === 'feature' || kind === 'sketch' || kind === 'shape';
}

/** Removes the selected body, feature, sketch or shape; false when nothing removable is selected. */
/** The selected curves grouped by sketch (shapes, loops and the shape of a selected point). */
function selectedCurves(state: ModelingState): Map<string, Set<string>> {
  const items = state.selectionSet.length ? state.selectionSet : state.selection ? [state.selection] : [];
  const bySketch = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.kind !== 'shape' && item.kind !== 'loop' && item.kind !== 'curve-point') continue;
    const ids = bySketch.get(item.sketchId) ?? new Set<string>();
    for (const id of item.kind === 'loop' ? item.shapeIds : [item.shapeId]) ids.add(id);
    bySketch.set(item.sketchId, ids);
  }
  return bySketch;
}

/** Copied curves (Ctrl+C), pasted into the edited sketch or the work plane's sketch (Ctrl+V). */
let curveClipboard: { plane: SketchPlane; shapes: Shape2D[] } | null = null;

function copyCurves(state: ModelingState): boolean {
  const curves = selectedCurves(state);
  const [first] = curves;
  if (!first) return false;
  const [sketchId, ids] = first;
  const sketch = findSketch(state.sketches, sketchId);
  if (!sketch) return false;
  curveClipboard = { plane: sketch.plane, shapes: sketch.shapes.filter((shape) => ids.has(shape.id)) };
  return true;
}

/**
 * Adds copies of curves to a sketch (one undo step) and selects them. Pasting onto the curves'
 * own place offsets the copies by one grid step (or 100 mm) so they can be seen and moved.
 */
function placeCurves(state: ModelingState, sketchId: string, shapes: Shape2D[], shift: boolean): void {
  const sketch = findSketch(state.sketches, sketchId);
  if (!sketch || !shapes.length) return;
  const step = shift ? state.toolOptions.grid || 100 : 0;
  const copies = shapes.map((shape) => ({ ...moveShape(shape, [step, -step]), id: newShapeId() }));
  state.setSketchShapes({ [sketchId]: [...sketch.shapes, ...copies] });
  modelingStore.getState().selectMany(copies.map((shape) => ({ kind: 'shape', sketchId, shapeId: shape.id })));
}

/** Ctrl+D: duplicates the selected curves in their sketch, offset so the copies are visible. */
function duplicateCurves(state: ModelingState): boolean {
  const curves = selectedCurves(state);
  const [first] = curves;
  if (!first) return false;
  const [sketchId, ids] = first;
  const sketch = findSketch(state.sketches, sketchId);
  if (!sketch) return false;
  placeCurves(state, sketchId, sketch.shapes.filter((shape) => ids.has(shape.id)), true);
  return true;
}

function pasteCurves(state: ModelingState): boolean {
  if (!curveClipboard) return false;
  const targetId = state.sketchEdit?.sketchId ?? state.sketches.find((sketch) => samePlane(sketch.plane, state.workPlane))?.id ?? state.addSketch(state.workPlane);
  const target = findSketch(modelingStore.getState().sketches, targetId);
  if (!target) return false;
  const shapes = samePlane(target.plane, curveClipboard.plane)
    ? curveClipboard.shapes
    : curveClipboard.shapes.map((shape) => {
        const { id, name, offset } = shape;
        const points = shapeContour(shape).map((point) => toPlane(target.plane, toWorld(curveClipboard!.plane, point)));
        return { kind: 'polyline' as const, id, points, ...(name ? { name } : {}), ...(offset ? { offset } : {}), ...(shape.kind === 'polyline' && shape.closed === false ? { closed: false } : {}) };
      });
  const overlaps = shapes.some((shape) => target.shapes.some((existing) => JSON.stringify({ ...existing, id: '' }) === JSON.stringify({ ...shape, id: '' })));
  placeCurves(modelingStore.getState(), target.id, shapes, overlaps);
  return true;
}

/**
 * Selects the next (step 1) or previous (-1) point of the selected curve: from the curve itself
 * the first (or last) point, from a point the one after it, wrapping round. False when nothing
 * with points is selected.
 */
function cycleCurvePoint(state: ModelingState, step: 1 | -1): boolean {
  const selection = state.selection;
  if (state.selectionSet.length > 1 || (selection?.kind !== 'shape' && selection?.kind !== 'curve-point')) return false;
  const shape = findSketch(state.sketches, selection.sketchId)?.shapes.find((item) => item.id === selection.shapeId);
  if (shape?.kind !== 'polyline' || !shape.points.length) return false;
  const count = shape.points.length;
  const pointIndex = selection.kind === 'curve-point' ? (selection.pointIndex + step + count) % count : step > 0 ? 0 : count - 1;
  state.select({ kind: 'curve-point', sketchId: selection.sketchId, shapeId: selection.shapeId, pointIndex });
  return true;
}

function deleteSelection(state: ModelingState): boolean {
  const selection = state.selection;
  // A selected point of a polyline: remove that vertex (keeping at least a segment / triangle).
  if (selection?.kind === 'curve-point' && state.selectionSet.length <= 1) {
    const sketch = findSketch(state.sketches, selection.sketchId);
    const shape = sketch?.shapes.find((item) => item.id === selection.shapeId);
    if (sketch && shape?.kind === 'polyline' && shape.points.length > (shape.closed === false ? 2 : 3)) {
      const points = shape.points.filter((_, index) => index !== selection.pointIndex);
      const next: Shape2D = { ...shape, points };
      if (shape.bulges) (next as typeof shape).bulges = shape.bulges.filter((_, index) => index !== selection.pointIndex).slice(0, shape.closed === false ? points.length - 1 : points.length);
      if (shape.handles) (next as typeof shape).handles = shape.handles.filter((_, index) => index !== selection.pointIndex).slice(0, shape.closed === false ? points.length - 1 : points.length);
      state.setSketchShapes({ [sketch.id]: sketch.shapes.map((item) => (item.id === shape.id ? next : item)) });
      state.select({ kind: 'shape', sketchId: sketch.id, shapeId: shape.id });
      return true;
    }
  }
  // Several curves: remove them all in one undo step.
  const curves = selectedCurves(state);
  if (curves.size && (state.selectionSet.length > 1 || selection?.kind === 'loop')) {
    const changes: Record<string, Shape2D[]> = {};
    for (const [sketchId, ids] of curves) {
      const sketch = findSketch(state.sketches, sketchId);
      if (sketch) changes[sketchId] = sketch.shapes.filter((shape) => !ids.has(shape.id));
    }
    state.setSketchShapes(changes);
    state.select(null);
    return true;
  }
  if (selection?.kind === 'body' || selection?.kind === 'face') state.removeBody(selection.kind === 'body' ? selection.id : selection.bodyId);
  else if (selection?.kind === 'feature') state.removeFeature(selection.bodyId, selection.featureId);
  else if (selection?.kind === 'sketch') state.removeSketch(selection.id);
  else if (selection?.kind === 'shape') state.removeShape(selection.sketchId, selection.shapeId);
  else return false;
  return true;
}

// ---- viewport -------------------------------------------------------------------------------

function paneHint(view: PaneView, tool: Tool, touch: boolean): string {
  if (touch) {
    if (SKETCH_TOOLS.includes(tool)) return 'Tap corner to corner, or drag, to draw · two fingers pan · pinch to zoom';
    if (view === '3d') return tool === 'extrude' ? 'Drag the arrow to extrude · tap a shape to pick a profile' : 'One finger orbits · tap to select · two fingers pan · pinch to zoom';
    if (cameraOfPane(view)) return 'One finger moves this camera';
    return 'Tap to select · drag a shape to move it · one finger pans · pinch to zoom';
  }
  if (SKETCH_TOOLS.includes(tool)) return view === '3d' || cameraOfPane(view) ? 'Draw on the work plane · middle-drag orbit · Shift+middle pan · wheel zoom' : 'Draw here · Shift+middle to pan · wheel to zoom';
  if (view === '3d') return tool === 'extrude' ? 'Drag the arrow to extrude · click a shape to pick a profile' : 'Orbit · click to select · draw on faces with the work plane · drag gizmos to edit';
  if (cameraOfPane(view)) return 'Orbit to move this camera';
  return 'Click a shape or body · drag a shape to move it · Shift+middle to pan · cut at the plane';
}

function Viewport({ viewportRef }: { viewportRef: React.RefObject<ModelingViewport | null> }) {
  const layout = useModeling((s) => s.layout);
  const panes = useModeling((s) => s.panes);
  const styleByPane = useModeling((s) => s.styles);
  const lodByPane = useModeling((s) => s.lods);
  const setLod = useModeling((s) => s.setLod);
  const cameras = useModeling((s) => s.cameras);
  const activePane = useModeling((s) => s.activePane);
  const setPane = useModeling((s) => s.setPane);
  const setStyle = useModeling((s) => s.setStyle);
  const setActivePane = useModeling((s) => s.setActivePane);
  const tool = useModeling((s) => s.tool);
  const sketches = useModeling((s) => s.sketches);
  const bodies = useModeling((s) => s.bodies);
  const selection = useModeling((s) => s.selection);
  const select = useModeling((s) => s.select);
  const updateSketch = useModeling((s) => s.updateSketch);
  const preview = useModeling((s) => s.sketchPreview);
  const reuseLast = useModeling((s) => s.reuseLastToolOrAction);
  const { isTouch } = useTouchMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const count = paneCount(layout);
  const viewOptions: { value: PaneView; label: string }[] = [
    { value: '3d', label: '3D' },
    ...(Object.entries(ORTHO_VIEWS) as [OrthoViewId, (typeof ORTHO_VIEWS)[OrthoViewId]][]).map(([value, view]) => ({ value, label: view.label })),
    { value: 'workplane', label: 'Work plane' },
    ...cameras.map((camera) => ({ value: `camera:${camera.id}` as PaneView, label: camera.name })),
  ];
  const activeSketchId = selectedSketchId(selection, bodies) ?? '';
  const sketchOptions = activeSketchId
    ? sketches.map((sketch) => ({ value: sketch.id, label: `${sketch.name} · ${planeLabel(sketch.plane)}` }))
    : [{ value: '', label: sketches.length > 0 ? 'Choose active sketch' : 'No sketches' }, ...sketches.map((sketch) => ({ value: sketch.id, label: `${sketch.name} · ${planeLabel(sketch.plane)}` }))];

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const viewport = new ModelingViewport(container, modelingStore);
    viewportRef.current = viewport;
    if (window.__modeling) window.__modeling.viewport = viewport;
    const unsubscribe = modelingStore.subscribe(() => viewport.sync());
    return () => {
      unsubscribe();
      viewport.dispose();
      viewportRef.current = null;
    };
  }, [viewportRef]);

  const paneKey = panes.slice(0, count).join('|');
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const list = paneRefs.current.slice(0, count).flatMap((element, index) => (element ? [{ element, view: panes[index]! }] : []));
    viewport.configure(list);
    viewport.sync();
    // paneKey captures the visible pane views; `panes` itself changes identity on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, paneKey, viewportRef]);

  return (
    <div className={styles.viewportColumn}>
      <SketchEditBar />
      <OptionsBar viewportRef={viewportRef} />
      <div ref={containerRef} className={styles.viewport} data-layout={layout}>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          ref={(element) => {
            paneRefs.current[index] = element;
          }}
          className={styles.pane}
          data-active={activePane === index || undefined}
          onPointerDownCapture={() => setActivePane(index)}
        >
          <div className={styles.paneHeader}>
            <SelectField value={panes[index]!} options={viewOptions} onChange={(view) => setPane(index, view)} ariaLabel={`Pane ${index + 1} view`} />
            <SelectField value={styleByPane[index]!} options={STYLE_OPTIONS} onChange={(style) => setStyle(index, style)} ariaLabel={`Pane ${index + 1} style`} />
            <SelectField<Lod> value={lodByPane[index]!} options={LOD_OPTIONS} onChange={(lod) => setLod(index, lod)} ariaLabel={`Pane ${index + 1} level of detail`} />
            <span className={styles.activeSketchSelect} data-active={Boolean(activeSketchId) || undefined}>
              <SelectField value={activeSketchId} options={sketchOptions} onChange={(id) => {
                if (!id) return;
                const sketch = sketches.find((item) => item.id === id);
                if (sketch && !sketch.visible) updateSketch(id, { visible: true });
                select({ kind: 'sketch', id });
              }} ariaLabel={`Pane ${index + 1} active sketch`} />
            </span>
            <span className={styles.paneHint}>{paneHint(panes[index]!, tool, isTouch)}</span>
          </div>
        </div>
      ))}
      {isTouch && (
        <TouchActionBar
          placement="bottom"
          drawing={Boolean(preview?.drawing)}
          onDone={() => viewportRef.current?.tools.sketch.keyDown({ key: 'Enter' })}
          onUndoPoint={() => viewportRef.current?.tools.sketch.keyDown({ key: 'Backspace' })}
          onCancel={() => {
            const sketchTool = viewportRef.current?.tools.sketch;
            if (sketchTool?.active) sketchTool.keyDown({ key: 'Escape' });
            else if (tool !== 'select') modelingStore.getState().setTool('select');
            else select(null);
          }}
          hasSelection={deletableSelection(selection)}
          onDelete={() => deleteSelection(modelingStore.getState())}
          onRepeat={reuseLast}
          modifiers={['straight', 'snapOff', 'additive', 'selectArea']}
        />
      )}
      {preview?.inference?.screen && (
        <span
          className={styles.inferenceLabel}
          data-type={preview.inference.type}
          data-locked={preview.inference.locked || undefined}
          style={{ left: preview.inference.screen[0] + 14, top: preview.inference.screen[1] + 14 }}
        >
          <i />
          <span>{preview.inference.label}{preview.inference.measurement && <small>{preview.inference.measurement}</small>}</span>
        </span>
      )}
      </div>
    </div>
  );
}

function CameraContextMenu() {
  const menu = useModeling((s) => s.cameraMenu);
  const cameras = useModeling((s) => s.cameras);
  const close = useModeling((s) => s.openCameraMenu);
  const setPane = useModeling((s) => s.setPane);
  const removeCamera = useModeling((s) => s.removeCamera);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(`.${styles.menu}`)) close(null);
    };
    window.addEventListener('pointerdown', dismiss, true);
    return () => window.removeEventListener('pointerdown', dismiss, true);
  }, [menu, close]);
  if (!menu) return null;
  const camera = cameras.find((item) => item.id === menu.cameraId);
  if (!camera) return null;
  return (
    <div className={styles.menu} style={{ left: menu.x, top: menu.y }} role="menu">
      <div className={styles.menuTitle}>{camera.name}</div>
      <button type="button" role="menuitem" onClick={() => setPane(menu.paneIndex, `camera:${camera.id}`)}>
        Pilot in this pane
      </button>
      <button type="button" role="menuitem" onClick={() => removeCamera(camera.id)}>
        Delete camera
      </button>
    </div>
  );
}

// ---- app ------------------------------------------------------------------------------------

declare global {
  interface Window {
    /** Inspectable entry point for the modeling window (tests and debugging). */
    __modeling?: { store: typeof modelingStore; scene: typeof modelingScene; kernel: typeof kernel; viewport?: ModelingViewport | null };
  }
}

export function ModelingApp() {
  const { touchMode, isTouch, setTouchMode } = useTouchMode();
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const appMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!appMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!appMenuRef.current?.contains(event.target as Node)) setAppMenuOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [appMenuOpen]);
  const [panelOpen, setPanelOpen] = useState(false);
  const starterEmpty = useModeling((s) => !s.bodies.length && !s.layers.length && !s.sketches.length);
  const addStarter = useModeling((s) => s.addPrimitive);
  const [{ assetId, name: routeName, projectId }] = useState(routeParams);
  const [showProjectReference, setShowProjectReference] = useState(false);
  const [projectDoc, setProjectDoc] = useState<ArchaiDocument | null>(() => {
    if (!projectId) return null;
    try {
      const raw = window.localStorage.getItem(`doc:${projectId}`);
      if (!raw) return null;
      const parsed = parseDocument(raw);
      return parsed.ok ? parsed.document : null;
    } catch {
      return null;
    }
  });
  const [sendDropdownOpen, setSendDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const projectLinkRef = useRef<{ id: string; name: string } | undefined>(undefined);
  projectLinkRef.current = projectId ? { id: projectId, name: projectDoc?.meta.name ?? 'Project' } : undefined;

  useEffect(() => {
    // The viewport mounted first (child effects run before the parent's), so it is ready here.
    window.__modeling = { store: modelingStore, scene: modelingScene, kernel, viewport: viewportRef.current };
    const runtime = new BodyRuntime(modelingStore, modelingScene);
    return () => runtime.dispose();
  }, []);
  const layout = useModeling((s) => s.layout);
  const setLayout = useModeling((s) => s.setLayout);
  const name = useModeling((s) => s.metadata.name);
  const selectTool = useSelectTool();
  const canUndo = useModeling((s) => s.past.length > 0);
  const canRedo = useModeling((s) => s.future.length > 0);
  const undo = useModeling((s) => s.undo);
  const redo = useModeling((s) => s.redo);
  const viewportRef = useRef<ModelingViewport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saved' | 'saving'>('loading');
  const [packaging, setPackaging] = useState<string | null>(null);
  const showError = useCallback((message: string) => setError(message), []);

  const saveEditablePackageSource = async (state: ModelingState) => {
    const editableId = state.metadata.id.trim();
    if (!editableId) return;
    await modelingStorage.save(snapshotOf(editableId, state, projectLinkRef.current));
    if (editableId === assetId) return;
    for (const layer of state.layers) {
      const bytes = await modelingStorage.loadFile(assetId, layer.id);
      if (bytes) await modelingStorage.saveFile(editableId, layer.id, bytes);
    }
  };

  // Sync with project tab if linked
  useEffect(() => {
    if (!projectId) return;

    const channel = getProjectSyncChannel();
    if (!channel) return;

    channel.postMessage({ type: 'REQUEST_PROJECT_DOC', projectId });
    channel.postMessage({
      type: 'MODELING_SESSION_ANNOUNCE',
      projectId,
      assetId,
      name: modelingStore.getState().metadata.name || routeName || 'Asset',
    });

    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ProjectSyncMessage;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'PROJECT_DOC_UPDATE' && msg.projectId === projectId) {
        setProjectDoc(msg.doc);
      } else if (msg.type === 'REQUEST_MODELING_SESSIONS' && msg.projectId === projectId) {
        channel.postMessage({
          type: 'MODELING_SESSION_ANNOUNCE',
          projectId,
          assetId,
          name: modelingStore.getState().metadata.name || routeName || 'Asset',
        });
      } else if (msg.type === 'MODELING_SESSION_TERMINATE' && msg.projectId === projectId && msg.assetId === assetId) {
        showError('This modeling file was deleted from the project.');
      }
    };

    channel.addEventListener('message', onMessage);

    const onBeforeUnload = () => {
      channel.postMessage({
        type: 'MODELING_SESSION_CLOSED',
        projectId,
        assetId,
      });
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      channel.postMessage({
        type: 'MODELING_SESSION_CLOSED',
        projectId,
        assetId,
      });
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, [projectId, assetId, routeName, showError]);

  // Update grayed-out reference in 3D scene when toggled or project doc updates
  useEffect(() => {
    if (showProjectReference && projectDoc) {
      const group = createGrayedOutProjectGroup(projectDoc);
      modelingScene.setProjectReference(group);
    } else {
      modelingScene.setProjectReference(null);
    }
  }, [showProjectReference, projectDoc]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!sendDropdownOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setSendDropdownOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [sendDropdownOpen]);

  const doPackage = async () => {
    const state = modelingStore.getState();
    if (!state.cameras.some((camera) => camera.preview)) {
      showError(state.cameras.length === 0 ? 'Add a camera and tick it as the preview camera: its hidden-line view becomes the thumbnail.' : 'Tick one camera as the preview camera (image icon in Layers) before packaging.');
      return;
    }
    const hasLow = state.layers.some((layer) => layer.visible && layer.lowLod) || state.bodies.some((body) => body.visible && body.lowLod);
    if (!hasLow && !window.confirm('No layers are marked for the low level of detail.\n\nPackage without a low-poly model? Boards set to low LOD will show a plain box for this asset.')) {
      return;
    }
    setError(null);
    setPackaging('Packaging…');
    try {
      const { bytes, fileName } = await packageAsset(state, modelingScene, { includeLow: hasLow, onProgress: setPackaging });
      await saveEditablePackageSource(state);
      downloadCaiFile(bytes, fileName);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : 'Packaging failed');
    } finally {
      setPackaging(null);
    }
  };

  const doSendToProject = async () => {
    if (!projectId) return;
    const state = modelingStore.getState();
    if (!state.cameras.some((camera) => camera.preview)) {
      showError(
        state.cameras.length === 0
          ? 'Add a camera and tick it as the preview camera: its hidden-line view becomes the thumbnail.'
          : 'Tick one camera as the preview camera (image icon in Layers) before packaging.',
      );
      return;
    }
    const hasLow =
      state.layers.some((layer) => layer.visible && layer.lowLod) ||
      state.bodies.some((body) => body.visible && body.lowLod);
    setError(null);
    setPackaging('Sending to project…');
    try {
      const { bytes } = await packageAsset(state, modelingScene, {
        includeLow: hasLow,
        onProgress: setPackaging,
      });
      await saveEditablePackageSource(state);

      const bounds = modelingScene.bounds();
      const centre = bounds ? bounds.getCenter(new Vector3()) : new Vector3(0, 0, 0);
      const position = {
        x: Math.round(centre.x),
        y: Math.round(centre.z),
        elevation: Math.round(bounds ? bounds.min.y : 0),
      };

      const channel = getProjectSyncChannel();
      if (channel) {
        channel.postMessage({
          type: 'INSERT_MODELED_ASSET',
          projectId,
          assetId,
          name: state.metadata.name || 'Modeled Asset',
          caiBytes: bytes,
          position,
        });
        setStatus('saved');
        alert(`Model "${state.metadata.name || 'Modeled Asset'}" sent directly to project at (${position.x}mm, ${position.y}mm)!`);
      }
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : 'Sending to project failed');
    } finally {
      setPackaging(null);
      setSendDropdownOpen(false);
    }
  };

  useEffect(() => {
    document.title = `${name || 'New asset'} — ArchAI Modeling`;
  }, [name]);

  // Workspace shortcuts: tools, undo/redo, gizmo mode, delete the selection, and the numeric
  // entry / Enter / Escape of a live drag. Fields keep their keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const state = modelingStore.getState();
      const tools = viewportRef.current?.tools;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (state.tool === 'select' && event.ctrlKey && event.shiftKey && event.altKey) {
        inspectSelectedLoop(state);
        event.preventDefault();
        return;
      }
      if (tools?.sketch.active && !mod && tools.sketch.keyDown(event)) {
        event.preventDefault();
        return;
      }
      // Tab / Shift+Tab: step through the points of the selected curve.
      if (event.key === 'Tab' && !mod && !event.altKey && cycleCurvePoint(state, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        return;
      }
      if ((state.tool === 'extrude' || state.tool === 'pushpull' || state.tool === 'revolve' || state.tool === 'sweep') && !mod && tools) {
        if (/^[0-9.\-]$/.test(event.key)) {
          state.setNumericEntry(state.numericEntry + event.key);
          return;
        }
        if (event.key === 'Backspace' && state.numericEntry) {
          state.setNumericEntry(state.numericEntry.slice(0, -1));
          return;
        }
        if (event.key === 'Enter') {
          const typed = Number(state.numericEntry);
          if (state.numericEntry && Number.isFinite(typed) && typed !== 0) {
            if (state.tool === 'revolve') state.setToolOptions({ revolve: { ...state.toolOptions.revolve, angle: Math.min(360, Math.abs(typed)) } });
            else state.setToolOptions({ extrude: { ...state.toolOptions.extrude, distance: typed } });
          }
          state.setNumericEntry('');
          tools.solid.commit();
          return;
        }
      }
      if (event.key === 'Escape') {
        if (state.numericEntry) state.setNumericEntry('');
        else if (state.tool !== 'select') selectTool('select');
        else state.select(null);
        return;
      }
      if (!mod && !event.altKey && /^[a-z]$/.test(key)) {
        const now = performance.now();
        const sequence = now - keySequence.at < 900 ? keySequence.keys + key : key;
        keySequence.keys = sequence.slice(-2);
        keySequence.at = now;
        const pair = (Object.keys(TOOL_KEYS) as Tool[]).find((tool) => TOOL_KEYS[tool].length === 2 && TOOL_KEYS[tool].toLowerCase() === keySequence.keys);
        if (pair) {
          keySequence.keys = '';
          selectTool(pair);
          return;
        }
      }
      if (!mod && !event.altKey && event.key === 'Enter' && state.sketchEdit && !tools?.sketch.active) {
        state.finishSketchEdit();
        return;
      }
      if (!mod && !event.altKey) {
        const shortcut = (Object.keys(TOOL_KEYS) as Tool[]).find((tool) => TOOL_KEYS[tool].length === 1 && TOOL_KEYS[tool].toLowerCase() === key);
        if (shortcut) {
          selectTool(shortcut);
          return;
        }
      }
      if (mod && !event.shiftKey && (key === 'd' || key === 'c' || key === 'v')) {
        const handled = key === 'd' ? duplicateCurves(state) : key === 'c' ? copyCurves(state) : pasteCurves(state);
        if (handled) {
          event.preventDefault();
          return;
        }
      }
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
      } else if (mod && key === 'y') {
        event.preventDefault();
        state.redo();
      } else if (!mod && key === 'g') {
        state.setGizmoMode('translate');
      } else if (!mod && key === 't') {
        state.setGizmoMode('rotate');
      } else if (!mod && key === 's') {
        state.setGizmoMode('scale');
      } else if (!mod && key === 'x') {
        const next = state.gizmoMode === 'translate' ? 'rotate' : state.gizmoMode === 'rotate' ? 'scale' : 'translate';
        state.setGizmoMode(next);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (deleteSelection(state)) event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.shiftKey && event.altKey)) modelingStore.getState().setLoopCheck(null);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [selectTool]);

  // Restore the asset (state + GLB files), then autosave every change.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let unsubscribe = () => {};
    void (async () => {
      const store = modelingStore.getState();
      try {
        const saved = await modelingStorage.load(assetId);
        if (cancelled) return;
        if (saved) {
          const layers: Layer[] = [];
          for (const layer of saved.layers) {
            const bytes = await modelingStorage.loadFile(assetId, layer.id);
            if (!bytes) continue;
            const imported = await modelingScene.importModel(bytes, `${layer.name}.glb`, layer.id, layer.scale);
            // Keep the saved names and visibility; geometry facts come from the fresh import.
            const merge = (fresh: LayerNode[], old: LayerNode[]): LayerNode[] => fresh.map((node, index) => ({ ...node, name: old[index]?.name ?? node.name, visible: old[index]?.visible ?? true, lowLod: old[index]?.lowLod ?? layer.lowLod ?? false, children: merge(node.children, old[index]?.children ?? []) }));
            layers.push({ ...imported, name: layer.name, visible: layer.visible, nodes: merge(imported.nodes, layer.nodes) });
          }
          store.hydrate({ ...saved, layers });
        } else {
          const packageBuffer = await modelingStorage.loadFile(assetId, '__package__');
          if (packageBuffer) {
            const extracted = extractCaiPackage(new Uint8Array(packageBuffer));
            const model = extracted.models.glb;
            if (!model) throw new Error('This local .CAI package has no editable GLB model');
            const layerId = newLayerId();
            const buffer = model.bytes.buffer.slice(model.bytes.byteOffset, model.bytes.byteOffset + model.bytes.byteLength) as ArrayBuffer;
            const layer = await modelingScene.importModel(buffer, `${extracted.metadata.name}.glb`, layerId);
            await modelingStorage.saveFile(assetId, layerId, buffer);
            const cameras = (extracted.metadata.cameras ?? []).map((camera, index) => ({
              id: `camera-package-${index}`,
              name: camera.name,
              visible: true,
              preview: camera.preview ?? index === 0,
              eye: camera.eye,
              aim: camera.aim,
              fov: camera.fov,
            }));
            store.hydrate({
              metadata: {
                name: extracted.metadata.name,
                id: extracted.metadata.id,
                idEdited: true,
                category: extracted.metadata.category ?? 'Personal/My Assets',
                tags: extracted.metadata.tags?.join(', ') ?? '',
              },
              layers: [{ ...layer, name: `${extracted.metadata.name} package model` }],
              cameras,
            });
          } else if (routeName) {
            store.setMetadata({ name: routeName });
          }
        }
      } catch (caught) {
        showError(caught instanceof Error ? caught.message : 'Could not restore the asset');
      }
      if (cancelled) return;
      // An asset with nothing in it starts with a sketch on the original (ground) reference
      // plane, selected, so the draw tools work at once. Not an undo step.
      const opened = modelingStore.getState();
      if (opened.sketches.length === 0 && opened.bodies.length === 0 && opened.layers.length === 0) {
        const base: SketchPlane = { kind: 'plane', id: 'top', offset: 0 };
        if (!opened.workPlaneLocked) opened.setWorkPlane(base);
        const sketch = modelingStore.getState().sketches.find((item) => samePlane(item.plane, base)) ?? null;
        const sketchId = sketch?.id ?? modelingStore.getState().addSketch(base);
        modelingStore.getState().select({ kind: 'sketch', id: sketchId });
        modelingStore.setState({ past: [], future: [] });
      }
      // Persist the ownership link as soon as a model is opened from a project, even when the
      // user returns Home without making a geometry edit.
      if (projectLinkRef.current) await modelingStorage.save(snapshotOf(assetId, store, projectLinkRef.current));
      setStatus('ready');
      unsubscribe = modelingStore.subscribe((state, previous) => {
        const changed = (['metadata', 'layers', 'bodies', 'sketches', 'materials', 'cameras', 'planes', 'planeVisible', 'workPlane', 'workPlaneVisible', 'workPlaneLocked', 'layout', 'panes', 'styles', 'lods'] as const).some((key) => state[key] !== previous[key]);
        if (!changed) return;
        setStatus('saving');
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void modelingStorage
            .save(snapshotOf(assetId, modelingStore.getState(), projectLinkRef.current))
            .then(() => setStatus('saved'))
            .catch((caught: unknown) => showError(caught instanceof Error ? caught.message : 'Autosave failed'));
        }, 600);
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [assetId, routeName, showError]);

  // The asset size is measured from whatever is visible in the scene.
  useEffect(() => {
    const update = () => {
      const bounds = modelingScene.bounds();
      const size = bounds ? bounds.getSize(new Vector3()) : null;
      const next: [number, number, number] = size ? [Math.round(size.x), Math.round(size.y), Math.round(size.z)] : [0, 0, 0];
      const current = modelingStore.getState().modelSize;
      if (next.some((value, index) => value !== current[index])) modelingStore.getState().setModelSize(next);
    };
    update();
    return modelingScene.onChange(update);
  }, []);

  return (
    <div className={styles.app} data-touch-layout={isTouch || undefined} data-panel-open={panelOpen || undefined}>
      <header className={styles.topbar}>
        <div className={topBarStyles.appMenuAnchor} ref={appMenuRef} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setAppMenuOpen(false);
            appMenuRef.current?.querySelector('button')?.focus();
          }
        }}>
          <button type="button" className={topBarStyles.mark} aria-label="App menu" aria-expanded={appMenuOpen} aria-haspopup="menu" onClick={() => setAppMenuOpen((open) => !open)}>
            A <ChevronDown size={10} />
          </button>
          {appMenuOpen && <div className={topBarStyles.appMenu} role="menu" aria-label="Touch Screen Mode">
            <div className={topBarStyles.menuTitle}><Hand size={14} />Touch Screen Mode</div>
            {(['auto', 'on', 'off'] as const).map((mode) => <button key={mode} type="button" role="menuitemradio" aria-checked={touchMode === mode} onClick={() => { setTouchMode(mode); setAppMenuOpen(false); }}>
              <span>{mode === 'auto' ? 'Auto' : mode === 'on' ? 'On' : 'Off'}{mode === 'auto' && touchMode === 'auto' && <small className={topBarStyles.menuNote}>{isTouch ? 'touch' : 'mouse'}</small>}</span>
              {touchMode === mode && <span aria-hidden="true">✓</span>}
            </button>)}
          </div>}
        </div>
        <IconButton label="Go to Home Screen" onClick={() => openAppPath('/')} data-testid="modeling-go-home">
          <Home size={ICON} />
        </IconButton>
        <span className={styles.title}>{name || 'New asset'}</span>
        <span className={styles.status}>{status === 'loading' ? 'Loading…' : status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved locally' : 'Autosaves locally'}</span>
        <span className={styles.spacer} />
        <Segmented<Layout>
          value={layout}
          onChange={setLayout}
          ariaLabel="Viewport layout"
          options={[
            { value: 'single', label: <Square size={ICON} />, title: 'Single view' },
            { value: 'split-2', label: <Columns2 size={ICON} />, title: 'Two views' },
            { value: 'split-4', label: <Grid2x2 size={ICON} />, title: 'Four views' },
          ]}
        />
        <IconButton label="Frame model" onClick={() => viewportRef.current?.frameAll()}>
          <Focus size={ICON} />
        </IconButton>
        <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo} data-testid="modeling-undo">
          <Undo2 size={ICON} />
        </IconButton>
        <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo} data-testid="modeling-redo">
          <Redo2 size={ICON} />
        </IconButton>
        <span className={styles.spacer} />

        {projectId && (
          <TextButton
            onClick={() => openAppPath(`/${formatBoardId(projectDoc?.meta.name ?? 'project', projectId)}`)}
            title="Return to the linked project board"
            data-testid="return-to-project-board"
          >
            <ArrowLeft size={13} /> Project board
          </TextButton>
        )}

        {projectId && (
          <TextButton
            className={showProjectReference ? styles.projectRefActive : undefined}
            onClick={() => setShowProjectReference((v) => !v)}
            title="Toggle live reference view of the linked project (grayed out)"
            data-testid="toggle-project-reference"
          >
            <Eye size={13} /> {showProjectReference ? 'Hide Project View' : 'Show Project View'}
          </TextButton>
        )}

        {projectId ? (
          <div className={styles.packageDropdownWrapper} ref={dropdownRef}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <TextButton
                primary
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, marginRight: 1 }}
                disabled={packaging !== null}
                onClick={() => void doPackage()}
                title="Download the asset as a .CAI package"
                data-testid="package-cai"
              >
                <Package size={13} /> {packaging ?? 'Package .CAI'}
              </TextButton>
              <TextButton
                primary
                style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingLeft: 6, paddingRight: 6 }}
                disabled={packaging !== null}
                onClick={() => setSendDropdownOpen((open) => !open)}
                title="More packaging options"
                data-testid="package-cai-dropdown-btn"
              >
                <ChevronDown size={12} />
              </TextButton>
            </div>

            {sendDropdownOpen && (
              <div className={styles.packageDropdownMenu} role="menu">
                <button
                  type="button"
                  className={styles.dropdownMenuItem}
                  onClick={() => {
                    setSendDropdownOpen(false);
                    void doPackage();
                  }}
                >
                  <Download size={13} /> Package & Download .CAI
                </button>
                <button
                  type="button"
                  className={styles.dropdownMenuItem}
                  onClick={() => void doSendToProject()}
                  data-testid="send-to-project-btn"
                >
                  <Send size={13} /> Send Directly to Project
                </button>
              </div>
            )}
          </div>
        ) : (
          <TextButton primary disabled={packaging !== null} onClick={() => void doPackage()} title="Download the asset as a .CAI package" data-testid="package-cai">
            <Package size={13} /> {packaging ?? 'Package .CAI'}
          </TextButton>
        )}
      </header>
      {error && (
        <div className={styles.error} role="alert">
          {error}
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {isTouch && <div className={styles.touchWorkspaceBar}>
        <span><strong>Create your CAI model</strong><small>Add a solid → shape it → export .CAI</small></span>
        <TextButton onClick={() => setPanelOpen((open) => !open)} aria-expanded={panelOpen} aria-controls="modeling-properties"><Layers size={18} /> {panelOpen ? 'Hide properties' : 'Properties & layers'}</TextButton>
      </div>}
      {isTouch && starterEmpty && <div className={styles.touchStarter}>
        <span>Start with a shape</span>
        {PRIMITIVE_SHAPES.map((shape) => <button type="button" key={shape} onClick={() => addStarter(shape, nextPosition(shape))}><ShapeIcon shape={shape} size={20} />{PRIMITIVE_LABELS[shape]}</button>)}
      </div>}
      <main className={styles.main}>
        <CanvasToolbar viewportRef={viewportRef} />
        <Viewport viewportRef={viewportRef} />
        <aside id="modeling-properties" className={styles.right}>
          <LayersPanel
            assetId={assetId}
            onError={showError}
            projectReference={projectId && projectDoc ? { name: `${projectDoc.meta.name} project`, visible: showProjectReference, onToggle: () => setShowProjectReference((value) => !value) } : undefined}
          />
          <ParametersPanel />
          <InspectorPanel assetId={assetId} />
          <MaterialsPanel />
          <AssetPanel />
        </aside>
      </main>
      <StatusBar viewportRef={viewportRef} />
      <CameraContextMenu />
    </div>
  );
}
