import { AlignCenter, AlignLeft, AlignRight, Link2, Unlink2 } from 'lucide-react';
import { BridgeInspector } from '@/bridge/BridgeInspector';
import { useEffect, useState } from 'react';
import { useApp, useAppState, useAppStateShallow, useDispatch } from '@/app/context';
import { elementLod, resizeRuleFor, wallEndsJoined } from '@/assets/arch-meta';
import { WALL_PATH_KEYS } from '@/assets/wall-path';
import { PathGeometryFields } from './PathGeometryFields';
import { GraphRunControls } from './GraphRunControls';
import { planRegionOf } from '@/layers/viewRig';
import { sectionOf, viewSettingsOf } from '@/view3d/useSceneView';
import { instanceElevationOf, levelElevationOf } from '@/view3d/geometry';
import type { CatalogAsset, SystemAssetType } from '@/catalog';
import { PAPER_SIZES, paperOf } from '@/commands/builtin/views';
import { parametricGraphOf } from '@/commands/builtin/parametric';
import { instanceParameterKeys, isSystemAssetType, resolveSystemParameters, sharedInstanceParameterDefinitions, systemDimensionParameters, SYSTEM_PARAMETER_DEFINITIONS } from '@/assets/system-assets';
import { elementGraphicOverrides, graphicType } from '@/graphics';
import { graphicTypeOfElement } from '@/assets/arch-meta';
import { UNITS, type Element, type Unit } from '@/document';
import { boundsOfIds, localBounds } from '@/geometry';
import { elementLabel } from './LayersTree';
import { ColorField, Divider, Field, FieldRow, IconButton, NumberField, Segmented, SelectField, TextButton, TextField, ToggleRow } from './primitives';
import { isLayerList, isProfile, LayersEditor, ProfileEditor, SystemConfigDialog, type ProfilePoint } from './SystemConfigDialog';
import styles from './Inspector.module.css';
import { AnalysisInspector } from '@/analysis/AnalysisInspector';
import { isPoint } from '@/document/point';
import { vrStopOf } from '@/document/vrStop';
import { takesMaterials } from '@/materials/slots';
import { meshOf } from '@/view3d/meshes';
import { GroupMeshNormals, MeshNormals } from './MeshNormals';
import { MaterialSlots } from './MaterialSlots';
import { CaiParameters } from './CaiParameters';
import { naturalSize } from '@/catalog/parametric';
import { isAnalysisElement } from '@/analysis/model';
import { useI18n } from './i18n';
import { SheetItemInspector } from '@/sheets/SheetInspector';
import { DiagramInspector } from '@/diagrams/DiagramInspector';
import { diagramOf } from '@/diagrams/model';
import { isSheetItem, northArrowOf, scaleBarOf, sheetViewOf, titleBlockOf } from '@/sheets/model';

const UNIT_LABELS: Record<Unit, string> = { mm: 'Millimetres', cm: 'Centimetres', m: 'Metres', in: 'Inches', ft: 'Feet' };
const VIEW_STYLE_OPTIONS = [
  { value: 'realistic', label: 'Realistic' },
  { value: 'hidden-line', label: 'Hidden line' },
  { value: 'shaded', label: 'Shaded' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'consistent', label: 'Colors' },
];

function InstanceProfileParameter({ parameterKey, label, value, spatial, disabled, onCommit }: { parameterKey: string; label: string; value: ProfilePoint[]; spatial: boolean; disabled: boolean; onCommit: (value: ProfilePoint[]) => void }) {
  const source = JSON.stringify(value);
  const [draft, setDraft] = useState<{ source: string; points: ProfilePoint[] }>(() => ({ source, points: value }));
  const points = draft.source === source ? draft.points : value;
  return (
    <div className={styles.profileParameter} data-testid={`instance-profile-${parameterKey}`}>
      <span className={styles.profileParameterLabel}>{label}{disabled ? ' · Graph' : ''}</span>
      <ProfileEditor
        value={points}
        spatial={spatial}
        disabled={disabled}
        onChange={(next) => {
          setDraft({ source, points: next });
          if (next.length >= 3) onCommit(next);
        }}
      />
    </div>
  );
}

function graphControlledKeys(elements: Readonly<Record<string, Element>>, elementId: string): Set<string> {
  const controlled = new Set<string>();
  for (const candidate of Object.values(elements)) {
    const graph = parametricGraphOf(candidate.meta?.['parametricGraph']);
    if (!graph || graph.executionMode === 'copy') continue;
    for (const node of graph.nodes.filter((item) => item.elementId === elementId)) {
      for (const key of Object.keys(node.inputValues ?? {})) controlled.add(key);
      for (const link of graph.links) {
        if (link.toNode === node.id && link.toSocket.startsWith('input:')) controlled.add(link.toSocket.slice('input:'.length));
      }
    }
  }
  return controlled;
}

function InstancePresetSelect({ element, type }: { element: Element; type: SystemAssetType }) {
  const { catalog } = useApp();
  const dispatch = useDispatch();
  const [presets, setPresets] = useState<CatalogAsset[]>([]);
  const [applying, setApplying] = useState(false);
  const arch = element.meta?.['arch'];
  const value = arch && typeof arch === 'object' && !Array.isArray(arch) && typeof arch['systemAssetId'] === 'string' ? arch['systemAssetId'] : '';

  useEffect(() => {
    let cancelled = false;
    const load = catalog.loadSystemTypes ? catalog.loadSystemTypes(type) : Promise.resolve<CatalogAsset[]>([]);
    void load.then((items) => !cancelled && setPresets(items)).catch(() => !cancelled && setPresets([]));
    return () => { cancelled = true; };
  }, [catalog, type]);

  const choose = async (assetId: string) => {
    const asset = presets.find((candidate) => candidate.id === assetId) ?? null;
    setApplying(true);
    try {
      await dispatch('apply-system-asset', {
        id: element.id,
        asset,
        parameters: asset?.systemParameters ?? {},
        instanceEditable: asset?.instanceEditable ?? [],
        applyTo: 'instance',
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <FieldRow single>
      <Field label="This instance preset">
        <SelectField
          value={value}
          options={[
            { value: '', label: `Default ${type.replace(/-/g, ' ')}` },
            ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
          ]}
          onChange={(next) => void choose(next)}
          ariaLabel="This instance preset"
          disabled={applying}
        />
      </Field>
    </FieldRow>
  );
}

/** Style, level of detail and (for sections) depth of one view portal; remembered on the portal. */
function ViewSettings({ portalId }: { portalId: string }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const { unit, precision } = doc.workspace;
  const settings = viewSettingsOf(doc, portalId);
  const cut = sectionOf(doc, portalId);
  const isSectionPortal = Boolean(cut);
  return (
    <div className={styles.section} data-testid="view-settings">
      <h3 className="u-section-title">{t('View')}</h3>
      <FieldRow>
        <Field label="Style">
          <SelectField
            value={settings.style ?? (isSectionPortal ? 'hidden-line' : 'default')}
            options={isSectionPortal ? VIEW_STYLE_OPTIONS : [{ value: 'default', label: `Board (${workspaceStyleLabel(doc.workspace.viewStyle)})` }, ...VIEW_STYLE_OPTIONS]}
            onChange={(style) => void dispatch('set-view3d-settings', { id: portalId, style: style === 'default' ? null : style })}
            ariaLabel="View style"
          />
        </Field>
        <Field label="Level of detail">
          <SelectField
            value={settings.lod ?? 'default'}
            options={[
              { value: 'default', label: `Board (${doc.workspace.lod})` },
              { value: 'high', label: 'High (3D models)' },
              { value: 'low', label: 'Low (boxes / low-poly)' },
            ]}
            onChange={(lod) => void dispatch('set-view3d-settings', { id: portalId, lod: lod === 'default' ? null : lod })}
            ariaLabel="Level of detail"
          />
        </Field>
      </FieldRow>
      {cut?.plan && (
        <FieldRow single>
          <Field label="Cut height above level">
            <NumberField value={cut.plan.cutHeight} unit={unit} precision={precision} min={1} onCommit={(cutHeight) => void dispatch('set-plan-cut-height', { id: portalId, cutHeight })} ariaLabel="Cut height" />
          </Field>
        </FieldRow>
      )}
      {isSectionPortal && (
        <FieldRow single>
          <Field label={cut?.plan ? 'Depth below cut (0 = everything)' : 'Section depth (0 = everything)'}>
            <NumberField value={settings.depth} unit={unit} precision={precision} min={0} onCommit={(depth) => void dispatch('set-view3d-settings', { id: portalId, depth })} ariaLabel="Section depth" />
          </Field>
        </FieldRow>
      )}
    </div>
  );
}

/** While a view is open full screen the Inspector is about that view, whatever is selected. */
function OpenViewInspector({ portalId }: { portalId: string }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const portal = doc.elements[portalId];
  if (!portal) return null;
  const view = (portal.meta?.['view3d'] as { cameraMode?: boolean; cameraId?: string; sectionLineId?: string } | undefined) ?? {};
  const cut = sectionOf(doc, portalId);
  const isSection = Boolean(cut) && !cut?.plan;
  const isCamera = Boolean(view.cameraMode || view.cameraId);
  return (
    <>
      <div className={styles.header}>
        <h2 className={styles.title}>{t(cut?.plan ? 'Plan view' : isSection ? 'Section view' : isCamera ? 'Camera view' : '3D view')}</h2>
        <span className={styles.subtitle}>{portal.name}</span>
      </div>
      <ViewSettings portalId={portalId} />
      <Divider />
      <div className={styles.actions}>
        {isSection && <TextButton onClick={() => void dispatch('flip-section-view', { id: portalId })}>Flip direction</TextButton>}
        <TextButton onClick={() => void dispatch('lock-view', { id: portalId })}>Lock view as image</TextButton>
        <TextButton onClick={() => void dispatch('close-view3d')}>Close view</TextButton>
      </div>
    </>
  );
}

function workspaceStyleLabel(style: string): string {
  return style === 'hidden-line' ? 'hidden line' : style;
}

export function Inspector() {
  const { t } = useI18n();
  const open = useAppState((s) => s.ui.panels.inspector);
  const selection = useAppStateShallow((s) => s.ui.selection);
  const openView = useAppState((s) => (s.ui.view3d.open ? s.ui.view3d.portalId : null));
  if (!open) return null;
  return (
    <aside className={`${styles.panel} u-panel`} aria-label={t('Inspector')} data-ui-scale data-testid="inspector">
      <div className={styles.scroll}>{openView ? <OpenViewInspector portalId={openView} /> : selection.length === 0 ? <WorkspaceInspector /> : <SelectionInspector ids={selection} />}</div>
    </aside>
  );
}

function WorkspaceInspector() {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const workspace = useAppState((s) => s.doc.workspace);
  const set = (patch: unknown) => void dispatch('set-workspace', patch);
  return (
    <>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('Workspace')}</h2>
      </div>
      <div className={styles.section}>
        <FieldRow single>
          <Field label="Background">
            <ColorField value={workspace.background} onCommit={(v) => v && set({ background: v })} ariaLabel="Background colour" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Units">
            <SelectField value={workspace.unit} options={UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] }))} onChange={(unit) => set({ unit })} ariaLabel="Units" />
          </Field>
          <Field label="Precision">
            <SelectField
              value={String(workspace.precision)}
              options={[0, 1, 2, 3, 4].map((p) => ({ value: String(p), label: String(p) }))}
              onChange={(p) => set({ precision: Number(p) })}
              ariaLabel="Precision"
            />
          </Field>
        </FieldRow>
      </div>
      <Divider />
      <div className={styles.section}>
        <ToggleRow label="Grid" value={workspace.grid.visible} onChange={(visible) => set({ grid: { visible } })} />
        <FieldRow single>
          <Field label="Grid size">
            <NumberField value={workspace.grid.size} unit={workspace.unit} precision={workspace.precision} min={1} onCommit={(size) => set({ grid: { size } })} ariaLabel="Grid size" />
          </Field>
        </FieldRow>
        <ToggleRow label="Snap to grid" value={workspace.snap.enabled} onChange={(enabled) => set({ snap: { enabled } })} />
      </div>
      <Divider />
      <div className={styles.section}>
        <h3 className="u-section-title">{t('Display')}</h3>
        <FieldRow>
          <Field label="View style">
            <SelectField
              value={workspace.viewStyle}
              options={VIEW_STYLE_OPTIONS}
              onChange={(viewStyle) => set({ viewStyle })}
              ariaLabel="View style"
            />
          </Field>
          <Field label="Level of detail">
            <SelectField
              value={workspace.lod}
              options={[
                { value: 'low', label: 'Low (3D: low-poly)' },
                { value: 'high', label: 'High (3D: full)' },
              ]}
              onChange={(lod) => set({ lod })}
              ariaLabel="Level of detail"
            />
          </Field>
        </FieldRow>
        <FieldRow single>
          <Field label="Board level (new elements start at)">
            <NumberField value={workspace.boardElevation ?? 0} unit={workspace.unit} precision={workspace.precision} onCommit={(boardElevation) => set({ boardElevation })} ariaLabel="Board level" />
          </Field>
        </FieldRow>
      </div>
      <Divider />
      <div className={styles.section}>
        <h3 className="u-section-title">{t('Views')}</h3>
        <div className={styles.actions}>
          <TextButton onClick={() => void dispatch('lock-plan-view')}>Lock plan view as image</TextButton>
          <TextButton onClick={() => void dispatch('create-view3d')}>Add 3D view</TextButton>
          <TextButton onClick={() => void dispatch('create-paper')}>Add paper</TextButton>
        </div>
      </div>
    </>
  );
}

function SelectionInspector({ ids }: { ids: string[] }) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  const doc = useAppState((s) => s.doc);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const { unit, precision } = doc.workspace;
  const elements = ids.map((id) => doc.elements[id]).filter((e): e is Element => Boolean(e));
  if (elements.length === 0) return null;
  const single = elements.length === 1 ? elements[0]! : null;
  const setProp = (key: string, value: unknown) => void dispatch('set-property', { ids, key, value });
  const systemSelections = elements.flatMap((element) => {
    const value = element.meta?.['arch'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || !isSystemAssetType(value['type'])) return [];
    return [{
      id: element.id,
      type: value['type'],
      parameters: resolveSystemParameters(value['type'], value['parameters']),
      instanceEditable: Array.isArray(value['instanceEditable']) ? value['instanceEditable'].filter((key): key is string => typeof key === 'string') : [],
    }];
  });
  const sharedInstanceDefinitions = !single && systemSelections.length === elements.length
    ? sharedInstanceParameterDefinitions(systemSelections).filter((definition) => definition.key !== 'elevation' && definition.kind !== 'layers' && definition.kind !== 'profile')
    : [];
  const graphControlledById = new Map(elements.map((element) => [element.id, graphControlledKeys(doc.elements, element.id)]));

  // System elements (walls, doors, stairs...) and annotations are drawn from the element
  // graphics of their type, so they show a "Display settings" button instead of a style section.
  const graphicTypeId = single ? graphicTypeOfElement(single) : null;
  const individualTypeId = single && !isSheetItem(single) && !diagramOf(single) ? (graphicTypeId ?? (single.kind === 'rect' || single.kind === 'line' || single.kind === 'text' || single.kind === 'image' ? single.kind : null)) : null;
  // Sheet items draw themselves: no fill/stroke to edit.
  const styled = graphicTypeId ? undefined : elements.find((e) => (e.kind === 'rect' || e.kind === 'line') && !isSheetItem(e) && !diagramOf(e));
  const style = styled && (styled.kind === 'rect' || styled.kind === 'line') ? styled.style : null;
  const text = graphicTypeId ? undefined : elements.find((e) => e.kind === 'text');
  const image = graphicTypeId ? undefined : elements.find((e) => e.kind === 'image');
  const rect = elements.find((e) => e.kind === 'rect');
  const line = elements.find((e) => e.kind === 'line');
  const archType = single?.meta?.['arch'] && typeof single.meta['arch'] === 'object' ? (single.meta['arch'] as { type?: string }).type : undefined;
  const arch = single?.meta?.['arch'] && typeof single.meta['arch'] === 'object' && !Array.isArray(single.meta['arch']) ? single.meta['arch'] as Record<string, unknown> : null;
  const facadeOpening = arch?.['opening'];
  const facadeWallId = facadeOpening && typeof facadeOpening === 'object' && !Array.isArray(facadeOpening) && typeof (facadeOpening as Record<string, unknown>)['wallId'] === 'string'
    ? String((facadeOpening as Record<string, unknown>)['wallId'])
    : null;
  const facadeHosted = archType === 'facade-element' && facadeWallId !== null && Boolean(doc.elements[facadeWallId]);
  const stairParent = single?.parentId && isSystemAssetType(archType) && archType === 'railing' && doc.elements[single.parentId]
    && (doc.elements[single.parentId]!.meta?.['arch'] as { type?: string } | undefined)?.type === 'stair'
    ? doc.elements[single.parentId]!
    : null;
  const instanceEditable = isSystemAssetType(archType) ? instanceParameterKeys(archType, arch?.['instanceEditable']) : [];
  const instanceParameters = isSystemAssetType(archType) ? resolveSystemParameters(archType, arch?.['parameters']) : {};
  const dimensions = isSystemAssetType(archType) ? systemDimensionParameters(archType, instanceParameters) : {};
  const widthParameter = dimensions.width;
  const lengthParameter = dimensions.height;
  const isWall = archType === 'wall';
  const isCurveWall = (archType === 'wall' || archType === 'curtain-wall') && line !== undefined;
  const wallJoined = single ? wallEndsJoined(single) : false;
  const isDoor = archType === 'door';
  const resizeRule = single ? resizeRuleFor(single) : 'all';
  const sizeLocked = resizeRule === 'none';
  const parametricComponent = single?.meta?.['parametricGraph'] ? single : single?.meta?.['parametricMarker'] && single.parentId ? doc.elements[single.parentId] : undefined;
  const isParametric = Boolean(parametricComponent?.meta?.['parametricGraph']);
  const levels = Object.values(doc.elements).filter((element) => levelElevationOf(element) !== null);
  const isLevel = single ? levelElevationOf(single) !== null : false;
  // A reference point's X / Y is where it points (its centre), not its symbol's corner.
  const pointCentre = single && isPoint(single) && single.kind === 'rect' ? single.width / 2 : 0;
  const levelConstraintValue = single?.meta?.['levelConstraint'];
  const levelConstraint = levelConstraintValue && typeof levelConstraintValue === 'object' && !Array.isArray(levelConstraintValue)
    && typeof levelConstraintValue['levelId'] === 'string'
    ? { levelId: levelConstraintValue['levelId'], offset: typeof levelConstraintValue['offset'] === 'number' ? levelConstraintValue['offset'] : 0 }
    : null;
  const linkedLevel = levelConstraint ? doc.elements[levelConstraint.levelId] : null;
  const levelLinked = Boolean(linkedLevel && levelElevationOf(linkedLevel) !== null);
  const canLinkLevel = Boolean(single && !isLevel && !single.meta?.['view3d'] && !single.meta?.['paper'] && !single.meta?.['sectionLine']);
  const graphControlled = single ? (graphControlledById.get(single.id) ?? new Set<string>()) : new Set<string>();

  const bounds = boundsOfIds(doc.elements, ids);
  const singleBox = single ? localBounds(doc.elements, single) : null;
  const sized = single && single.kind !== 'group' && single.kind !== 'line' ? single : null;
  const instanceDefinition = single?.kind === 'instance' ? doc.definitions[single.definitionId] : null;
  const naturalWidth = single?.kind === 'instance' && instanceDefinition ? naturalSize(instanceDefinition, single).width : 0;
  const uniformScale = single?.kind === 'instance' && naturalWidth ? (single.width / naturalWidth) * 100 : 100;

  return (
    <>
      <div className={styles.header}>
        <h2 className={styles.title}>{single ? t(kindTitle(single)) : t(`${elements.length} elements`)}</h2>
        {single?.kind === 'instance' && <span className={styles.subtitle}>{doc.definitions[single.definitionId]?.name}</span>}
      </div>

      {single?.kind === 'instance' && instanceDefinition && !isDoor && (
        <>
          <Divider />
          <div className={styles.section}>
            <FieldRow single>
              <Field label="Uniform scale">
                <NumberField
                  value={uniformScale}
                  suffix="%"
                  precision={1}
                  min={1}
                  onCommit={(scale) => void dispatch('set-uniform-asset-scale', { id: single.id, percent: scale })}
                  ariaLabel="Uniform scale"
                />
              </Field>
            </FieldRow>
          </div>
        </>
      )}

      {single && isSystemAssetType(archType) && (
        <>
          <Divider />
          <div className={styles.section} data-testid="system-configuration">
            <h3 className="u-section-title">{t('Configuration')}</h3>
            {archType === 'stair' && (
              <div className={styles.actions}>
                <TextButton onClick={() => void dispatch('add-stair-railing', { stairId: single.id, side: 'left' })}>Add left railing</TextButton>
                <TextButton onClick={() => void dispatch('add-stair-railing', { stairId: single.id, side: 'right' })}>Add right railing</TextButton>
              </div>
            )}
            {stairParent && (
              <FieldRow single>
                <Field label="Stair side">
                  <SelectField
                    value={single.meta?.['stairSide'] === 'left' ? 'left' : 'right'}
                    options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
                    onChange={(side) => void dispatch('set-stair-railing-side', { id: single.id, side })}
                    ariaLabel="Stair railing side"
                  />
                </Field>
              </FieldRow>
            )}
            {facadeHosted && (
              <div className={styles.actions}>
                <TextButton onClick={() => void dispatch('flip-facade-side', { id: single.id })}>Flip side</TextButton>
                <TextButton onClick={() => void dispatch('array-facade-along-wall', { id: single.id })}>Array along wall</TextButton>
              </div>
            )}
            <button type="button" className={styles.configurationButton} onClick={() => setConfigurationOpen(true)}>
              <span>{typeof arch?.['systemAssetName'] === 'string' && arch['systemAssetName'] !== 'Graph' ? arch['systemAssetName'] : `Default ${archType.replace(/-/g, ' ')}`}</span>
              <small>{t('View orthographic previews and parameters')}</small>
            </button>
            <InstancePresetSelect element={single} type={archType} />
          </div>
          {configurationOpen && <SystemConfigDialog element={single} type={archType} applyTo="type" onClose={() => setConfigurationOpen(false)} />}
        </>
      )}

      {single?.kind === 'group' && <GroupMeshNormals key={single.id} id={single.id} />}

      {single && meshOf(single) && (
        <>
          <Divider />
          <div className={styles.section} data-testid="model-settings">
            <h3 className="u-section-title">{t('3D model')}</h3>
            <MeshNormals key={single.id} id={single.id} />
            <FieldRow>
              <Field label="Units">
                <SelectField
                  value={meshOf(single)!.unit ?? 'mm'}
                  options={[{ value: 'mm', label: 'Millimetres' }, { value: 'cm', label: 'Centimetres' }, { value: 'm', label: 'Metres' }, { value: 'in', label: 'Inches' }, { value: 'ft', label: 'Feet' }]}
                  onChange={(unit) => void dispatch('set-model-units', { id: single.id, unit })}
                  ariaLabel="Model units"
                />
              </Field>
              <Field label="Up axis">
                <SelectField value={meshOf(single)!.up ?? 'y'} options={[{ value: 'y', label: 'Y up' }, { value: 'z', label: 'Z up' }]} onChange={(up) => void dispatch('set-model-units', { id: single.id, up })} ariaLabel="Model up axis" />
              </Field>
            </FieldRow>
          </div>
        </>
      )}

      {single && takesMaterials(single) && (
        <>
          <Divider />
          <div className={styles.section} data-testid="materials-section">
            <h3 className="u-section-title">{t('Materials')}</h3>
            <MaterialSlots element={single} />
          </div>
        </>
      )}

      {single && individualTypeId && (
        <>
          <Divider />
          <div className={styles.section} data-testid="display-settings">
            <h3 className="u-section-title">{t('Display')}</h3>
            <button type="button" className={styles.configurationButton} onClick={() => void dispatch('open-graphics', { type: individualTypeId })} data-testid="open-display-settings">
              <span>{t('Type defaults')}</span>
              <small>{t('Hidden line defaults for every')} {t(graphicType(individualTypeId)?.label ?? individualTypeId).toLowerCase()}</small>
            </button>
            <button type="button" className={styles.configurationButton} onClick={() => void dispatch('open-graphics', { type: individualTypeId, elementId: single.id })} data-testid="open-element-display-settings">
              <span>{t('This element')}</span>
              <small>{Object.keys(elementGraphicOverrides(single)).length > 0 ? t('Individual Hidden line overrides are active') : t('Override this element or keep the type defaults')}</small>
            </button>
            {isWall && line && (
              <div className={styles.jointRow}>
                <span>{t('Join with neighbouring walls')}</span>
                <IconButton
                  label={wallJoined ? 'Joints on (click to separate the ends)' : 'Joints off (click to join ends that touch)'}
                  active={wallJoined}
                  onClick={() => void dispatch('set-wall-joints', { id: line.id, enabled: !wallJoined })}
                  data-testid="wall-joints"
                >
                  {wallJoined ? <Link2 size={15} /> : <Unlink2 size={15} />}
                </IconButton>
              </div>
            )}
          </div>
        </>
      )}

      {single && isParametric && (
        <>
          <Divider />
          <div className={styles.section}>
            <h3 className="u-section-title">Parametric component</h3>
            <TextButton onClick={() => void dispatch('open-parametric-editor', { id: parametricComponent!.id })}>Open node graph</TextButton>
            <GraphRunControls componentId={parametricComponent!.id} />
          </div>
        </>
      )}

      {single && isSystemAssetType(archType) && instanceEditable.length > 0 && (
        <>
          <Divider />
          <div className={styles.section} data-testid="instance-parameters">
            <h3 className="u-section-title">{t('Instance parameters')}</h3>
            {SYSTEM_PARAMETER_DEFINITIONS[archType]
              .filter((definition) => instanceEditable.includes(definition.key) && (!definition.visibleWhen || definition.visibleWhen(instanceParameters)) && definition.key !== 'elevation' && !(archType === 'wall' && (WALL_PATH_KEYS as readonly string[]).includes(definition.key)))
              .map((definition) => {
                const value = instanceParameters[definition.key] ?? definition.defaultValue;
                const controlledByLevel = levelLinked && ['elevation', 'threshold', 'sill'].includes(definition.key);
                const controlled = graphControlled.has(`parameter:${definition.key}`) || controlledByLevel;
                if (definition.kind === 'layers') return <fieldset key={definition.key} disabled={controlled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><legend>{t(definition.label)}</legend><LayersEditor value={isLayerList(value) ? value : []} onChange={(next) => void dispatch('set-system-parameter', { id: single.id, key: definition.key, value: next })} /></fieldset>;
                if (definition.kind === 'profile') {
                  return (
                    <InstanceProfileParameter
                      key={definition.key}
                      parameterKey={definition.key}
                      label={t(definition.label)}
                      value={isProfile(value) ? value : []}
                      spatial={archType === 'curtain-wall'}
                      disabled={controlled}
                      onCommit={(next) => void dispatch('set-system-parameter', { id: single.id, key: definition.key, value: next })}
                    />
                  );
                }
                return (
                  <FieldRow single key={definition.key}>
                    <Field label={`${t(definition.label)}${controlledByLevel ? ' · Level' : controlled ? ' · Graph' : ''}`}>
                      {definition.kind === 'number' ? (
                        <NumberField value={Number(value)} unit={definition.unit === 'length' ? unit : undefined} precision={precision} disabled={controlled} onCommit={(next) => void dispatch('set-system-parameter', { id: single.id, key: definition.key, value: next })} ariaLabel={definition.label} />
                      ) : definition.kind === 'boolean' ? (
                        <ToggleRow label={definition.label} value={Boolean(value)} disabled={controlled} onChange={(next) => void dispatch('set-system-parameter', { id: single.id, key: definition.key, value: next })} />
                      ) : (
                        <SelectField value={String(value)} options={[...(definition.options ?? [])]} disabled={controlled} onChange={(next) => void dispatch('set-system-parameter', { id: single.id, key: definition.key, value: next })} ariaLabel={definition.label} />
                      )}
                    </Field>
                  </FieldRow>
                );
              })}
          </div>
        </>
      )}

      {!single && sharedInstanceDefinitions.length > 0 && (
        <>
          <Divider />
          <div className={styles.section} data-testid="shared-instance-parameters">
            <h3 className="u-section-title">{t('Common instance parameters')}</h3>
            <small className={styles.sectionHint}>{t('Only parameters shared by every selected element are shown.')}</small>
            {sharedInstanceDefinitions.map((definition) => {
              const values = systemSelections.map((selection) => selection.parameters[definition.key] ?? definition.defaultValue);
              const value = values[0] ?? definition.defaultValue;
              const mixed = values.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(value));
              const controlled = systemSelections.some((selection) => graphControlledById.get(selection.id)?.has(`parameter:${definition.key}`));
              const apply = (next: string | number | boolean) => void dispatch('set-system-parameter-batch', { ids: systemSelections.map((selection) => selection.id), key: definition.key, value: next });
              const label = `${definition.label}${controlled ? ' · Graph' : ''}`;
              return (
                <FieldRow single key={definition.key}>
                  <Field label={label}>
                    {definition.kind === 'number' ? (
                      <NumberField value={Number(value)} mixed={mixed} unit={definition.unit === 'length' ? unit : undefined} precision={precision} disabled={controlled} onCommit={apply} ariaLabel={definition.label} />
                    ) : definition.kind === 'boolean' ? (
                      <ToggleRow label={definition.label} value={Boolean(value)} mixed={mixed} disabled={controlled} onChange={apply} />
                    ) : (
                      <SelectField value={String(value)} mixed={mixed} options={[...(definition.options ?? [])]} disabled={controlled} onChange={apply} ariaLabel={definition.label} />
                    )}
                  </Field>
                </FieldRow>
              );
            })}
          </div>
        </>
      )}

      {single && canLinkLevel && (
        <>
          <Divider />
          <div className={styles.section} data-testid="elevation-reference">
            <h3 className="u-section-title">Elevation reference</h3>
            <FieldRow single>
              <Field label="Source">
                <SelectField
                  value={levelLinked ? 'level' : 'direct'}
                  options={[{ value: 'direct', label: 'Free' }, { value: 'level', label: 'Level + offset' }]}
                  disabled={graphControlled.has('levelId')}
                  onChange={(mode) => {
                    if (mode === 'direct') void dispatch('set-element-level-link', { id: single.id, levelId: null, offset: 0 });
                    else if (levels[0]) {
                      const elevation = levelElevationOf(levels[0]) ?? 0;
                      void dispatch('set-element-level-link', { id: single.id, levelId: levels[0].id, offset: instanceElevationOf(single) - elevation });
                    }
                  }}
                  ariaLabel="Elevation source"
                />
              </Field>
            </FieldRow>
            {levelLinked && linkedLevel && levelConstraint && <>
              <FieldRow single>
                <Field label="Level">
                  <SelectField value={linkedLevel.id} disabled={graphControlled.has('levelId')} options={levels.map((level) => ({ value: level.id, label: `${level.name ?? 'Level'} · ${String(levelElevationOf(level) ?? 0)} mm` }))} onChange={(levelId) => void dispatch('set-element-level-link', { id: single.id, levelId, offset: levelConstraint.offset })} ariaLabel="Linked level" />
                </Field>
              </FieldRow>
              <FieldRow single>
                <Field label="Offset">
                  <NumberField value={levelConstraint.offset} disabled={graphControlled.has('levelOffset')} unit={unit} precision={precision} onCommit={(offset) => void dispatch('set-element-level-link', { id: single.id, levelId: linkedLevel.id, offset })} ariaLabel="Level offset" />
                </Field>
              </FieldRow>
            </>}
            {!levelLinked && levels.length === 0 && <small>Draw a Level first to use Level + offset.</small>}
          </div>
        </>
      )}

      {single && (
        <div className={styles.section}>
          <FieldRow single>
            <Field label="Name">
              <TextField value={single.name ?? ''} disabled={graphControlled.has('name')} placeholder={elementLabel(single, doc)} onCommit={(name) => void dispatch('rename', { id: single.id, name })} ariaLabel="Name" />
            </Field>
          </FieldRow>
        </div>
      )}

      <div className={styles.section}>
        {single ? (
          <>
            {isCurveWall && line ? <PathGeometryFields element={line} controlled={graphControlled} /> : <FieldRow>
              <Field label={graphControlled.has('x') ? 'X · Graph' : 'X'}>
                <NumberField value={single.x + pointCentre} unit={unit} precision={precision} disabled={graphControlled.has('x')} onCommit={(x) => void dispatch('set-transform', { id: single.id, x: x - pointCentre })} ariaLabel="X" />
              </Field>
              <Field label={graphControlled.has('y') ? 'Y · Graph' : 'Y'}>
                <NumberField value={single.y + pointCentre} unit={unit} precision={precision} disabled={graphControlled.has('y')} onCommit={(y) => void dispatch('set-transform', { id: single.id, y: y - pointCentre })} ariaLabel="Y" />
              </Field>
            </FieldRow>}
            {!['door', 'window'].includes(archType ?? '') && <FieldRow single>
              <Field label={isLevel ? 'Level elevation' : levelLinked ? 'Elevation · Level' : graphControlled.has('elevation') || graphControlled.has('parameter:elevation') ? 'Elevation · Graph' : 'Elevation'}>
                <NumberField value={isLevel ? (levelElevationOf(single) ?? 0) : instanceElevationOf(single)} unit={unit} precision={precision} disabled={levelLinked || graphControlled.has('elevation') || graphControlled.has('parameter:elevation')} onCommit={(elevation) => void dispatch(isLevel ? 'set-level-elevation' : 'set-instance-elevation', isLevel ? { id: single.id, elevation } : { ids: [single.id], elevation })} ariaLabel="Elevation" />
              </Field>
            </FieldRow>}
            {vrStopOf(single) && (
              <FieldRow single>
                <Field label="VR facing">
                  <NumberField value={vrStopOf(single)!.heading} suffix="°" precision={0} onCommit={(heading) => void dispatch('set-vr-stop-heading', { id: single.id, heading })} ariaLabel="VR facing" />
                </Field>
              </FieldRow>
            )}
            {isLevel && (
              <div className={styles.actions}>
                <TextButton onClick={() => void dispatch('create-level-view', { id: single.id })}>Add plan view</TextButton>
              </div>
            )}
            {single.meta?.['planRegion'] && (
              <FieldRow single>
                <Field label="Cut height above level">
                  <NumberField value={planRegionOf(single).cutHeight} unit={unit} precision={precision} min={1} onCommit={(cutHeight) => void dispatch('set-plan-cut-height', { id: single.id, cutHeight })} ariaLabel="Cut height" />
                </Field>
              </FieldRow>
            )}
            {!isCurveWall && (!widthParameter || !lengthParameter) && <FieldRow>
              {!widthParameter && <Field label={graphControlled.has('width') || graphControlled.has('parameter:width') ? 'Width · 2D · Graph' : 'Width · 2D'}>
                <NumberField
                  value={sized ? sized.width : (singleBox?.width ?? 0)}
                  unit={unit}
                  precision={precision}
                  min={1}
                  disabled={sizeLocked || Boolean(widthParameter && !instanceEditable.includes(widthParameter)) || graphControlled.has('width') || graphControlled.has('parameter:width') || graphControlled.has('parameter:diameter')}
                  onCommit={(width) => void dispatch('set-transform', { id: single.id, width })}
                  ariaLabel="Width"
                />
              </Field>}
              {!lengthParameter && <Field label={graphControlled.has('height') || graphControlled.has('parameter:depth') ? 'Length · 2D · Graph' : 'Length · 2D'}>
                <NumberField
                  value={sized ? sized.height : (singleBox?.height ?? 0)}
                  unit={unit}
                  precision={precision}
                  min={1}
                  disabled={single.kind === 'text' || sizeLocked || resizeRule === 'width' || Boolean(lengthParameter && !instanceEditable.includes(lengthParameter)) || graphControlled.has('height') || graphControlled.has('parameter:depth')}
                  onCommit={(height) => void dispatch('set-transform', { id: single.id, height })}
                  ariaLabel="Height"
                />
              </Field>}
            </FieldRow>}
            {!isCurveWall && <FieldRow>
              <Field label={graphControlled.has('rotation') ? 'Rotation · Graph' : 'Rotation'}>
                <NumberField value={single.rotation} suffix="°" precision={1} step={1} disabled={graphControlled.has('rotation')} onCommit={(rotation) => void dispatch('set-transform', { id: single.id, rotation })} ariaLabel="Rotation" />
              </Field>
              <span />
            </FieldRow>}
          </>
        ) : (
          bounds && (
            <>
              <FieldRow>
                <Field label="X">
                  <NumberField value={bounds.x} unit={unit} precision={precision} onCommit={(x) => void dispatch('move-selection', { ids, dx: x - bounds.x, dy: 0 })} ariaLabel="X" />
                </Field>
                <Field label="Y">
                  <NumberField value={bounds.y} unit={unit} precision={precision} onCommit={(y) => void dispatch('move-selection', { ids, dx: 0, dy: y - bounds.y })} ariaLabel="Y" />
                </Field>
              </FieldRow>
              <FieldRow single>
                <Field label="Elevation">
                  <NumberField
                    value={instanceElevationOf(elements[0]!)}
                    mixed={elements.some((element) => instanceElevationOf(element) !== instanceElevationOf(elements[0]!))}
                    unit={unit}
                    precision={precision}
                    onCommit={(elevation) => void dispatch('set-instance-elevation', { ids, elevation })}
                    ariaLabel="Elevation"
                  />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Width">
                  <NumberField
                    value={bounds.width}
                    unit={unit}
                    precision={precision}
                    min={1}
                    onCommit={(width) => void dispatch('resize-selection', { ids, from: bounds, to: { ...bounds, width } })}
                    ariaLabel="Width"
                  />
                </Field>
                <Field label="Height">
                  <NumberField
                    value={bounds.height}
                    unit={unit}
                    precision={precision}
                    min={1}
                    onCommit={(height) => void dispatch('resize-selection', { ids, from: bounds, to: { ...bounds, height } })}
                    ariaLabel="Height"
                  />
                </Field>
              </FieldRow>
            </>
          )
        )}
      </div>

      {style && (
        <>
          <Divider />
          <div className={styles.section}>
            {rect && (
              <FieldRow single>
                <Field label="Fill">
                  <ColorField value={rect.style.fill} allowNone onCommit={(v) => setProp('fill', v)} ariaLabel="Fill" />
                </Field>
              </FieldRow>
            )}
            <FieldRow>
              <Field label={isWall ? 'Wall colour' : 'Stroke'}>
                <ColorField value={style.stroke} allowNone onCommit={(v) => setProp('stroke', v)} ariaLabel="Stroke" />
              </Field>
              <Field label={isWall ? 'Thickness' : 'Stroke width'}>
                <NumberField value={style.strokeWidth} unit={unit} precision={precision} min={0} disabled={isWall || archType === 'railing'} onCommit={(v) => setProp('strokeWidth', v)} ariaLabel="Stroke width" />
              </Field>
            </FieldRow>
            <FieldRow>
              {rect ? (
                <Field label="Corner radius">
                  <NumberField value={rect.radius} unit={unit} precision={precision} min={0} onCommit={(v) => setProp('radius', v)} ariaLabel="Corner radius" />
                </Field>
              ) : (
                <span />
              )}
              <Field label="Opacity">
                <NumberField value={style.opacity * 100} suffix="%" precision={0} step={5} min={0} max={100} onCommit={(v) => setProp('opacity', v / 100)} ariaLabel="Opacity" />
              </Field>
            </FieldRow>
            {line && !rect && !isWall && <ToggleRow label="Closed shape" value={line.closed} onChange={(v) => setProp('closed', v)} />}
            {line && isWall && (
              <div className={styles.jointRow}>
                <span>{t('Join with neighbouring walls')}</span>
                <IconButton
                  label={wallJoined ? 'Joints on (click to separate the ends)' : 'Joints off (click to join ends that touch)'}
                  active={wallJoined}
                  onClick={() => void dispatch('set-wall-joints', { id: line.id, enabled: !wallJoined })}
                  data-testid="wall-joints"
                >
                  {wallJoined ? <Link2 size={15} /> : <Unlink2 size={15} />}
                </IconButton>
              </div>
            )}
          </div>
        </>
      )}

      {text && (
        <>
          <Divider />
          <div className={styles.section}>
            <FieldRow>
              <Field label="Font size">
                <NumberField value={text.fontSize} unit={unit} precision={precision} min={1} onCommit={(v) => setProp('fontSize', v)} ariaLabel="Font size" />
              </Field>
              <Field label="Colour">
                <ColorField value={text.color} onCommit={(v) => v && setProp('color', v)} ariaLabel="Text colour" />
              </Field>
            </FieldRow>
            <FieldRow single>
              <Field label="Align">
                <Segmented
                  value={text.align}
                  options={[
                    { value: 'left', label: <AlignLeft size={14} />, title: 'Left' },
                    { value: 'center', label: <AlignCenter size={14} />, title: 'Centre' },
                    { value: 'right', label: <AlignRight size={14} />, title: 'Right' },
                  ]}
                  onChange={(v) => setProp('align', v)}
                  ariaLabel="Text alignment"
                />
              </Field>
            </FieldRow>
            {single && (
              <div className={styles.actions}>
                <TextButton onClick={() => void dispatch('begin-text-edit', { id: single.id })}>Edit text</TextButton>
              </div>
            )}
          </div>
        </>
      )}

      {image && !style && (
        <>
          <Divider />
          <div className={styles.section}>
            <FieldRow>
              <Field label="Opacity">
                <NumberField value={image.opacity * 100} suffix="%" precision={0} step={5} min={0} max={100} onCommit={(v) => setProp('opacity', v / 100)} ariaLabel="Opacity" />
              </Field>
              <span />
            </FieldRow>
          </div>
        </>
      )}

      {single && paperOf(single.meta) && (() => {
        const paper = paperOf(single.meta)!;
        return (
          <>
            <Divider />
            <div className={styles.section} data-testid="paper-section">
              <h3 className="u-section-title">{t('Paper')}</h3>
              <FieldRow single>
                <Field label="Title">
                  <TextField value={paper.title} onCommit={(title) => void dispatch('set-paper', { id: single.id, title })} ariaLabel="Paper title" />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Size">
                  <SelectField value={paper.size} options={[...Object.keys(PAPER_SIZES).map((size) => ({ value: size, label: size })), { value: 'custom', label: 'Custom' }]} onChange={(size) => size !== 'custom' && void dispatch('set-paper', { id: single.id, size })} ariaLabel="Paper size" />
                </Field>
                <Field label="Orientation">
                  <SelectField value={paper.orientation} options={[{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }]} onChange={(orientation) => void dispatch('set-paper', { id: single.id, orientation })} ariaLabel="Paper orientation" />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Scale 1:">
                  <NumberField value={paper.scale} precision={0} min={1} onCommit={(scale) => void dispatch('set-paper', { id: single.id, scale })} ariaLabel="Paper scale" />
                </Field>
                <Field label="Sheet no.">
                  <TextField value={paper.number} onCommit={(number) => void dispatch('set-paper', { id: single.id, number })} ariaLabel="Sheet number" />
                </Field>
              </FieldRow>
              <div className={styles.actions}>
                <TextButton onClick={() => void dispatch('open-sheet', { id: single.id })}>{t('Open sheet')}</TextButton>
                <TextButton primary onClick={() => void dispatch('open-export-dialog', { id: single.id })}>{t('Export…')}</TextButton>
              </div>
            </div>
          </>
        );
      })()}

      {single && isSheetItem(single) && <SheetItemInspector element={single} />}
      {single && diagramOf(single) && <DiagramInspector element={single} />}

      {single && (single.meta?.['cameraMarker'] || (single.meta?.['view3d'] as { cameraMode?: boolean; cameraId?: string } | undefined)?.cameraMode || (single.meta?.['view3d'] as { cameraId?: string } | undefined)?.cameraId) && (() => {
        const isPortal = Boolean(single.meta?.['view3d']);
        const portal = isPortal ? single : (single.meta?.['cameraMarker'] as { portalId?: string } | undefined)?.portalId ? doc.elements[(single.meta?.['cameraMarker'] as { portalId: string }).portalId] : null;
        const marker = !isPortal ? single : (single.meta?.['view3d'] as { cameraId?: string } | undefined)?.cameraId ? doc.elements[(single.meta?.['view3d'] as { cameraId: string }).cameraId] : null;
        const mMeta = (marker?.meta?.['cameraMarker'] as { eyeHeight?: number; targetHeight?: number; fov?: number } | undefined) ?? {};
        const vMeta = (portal?.meta?.['view3d'] as { camera?: { eyeHeight?: number; targetHeight?: number; fov?: number } } | undefined)?.camera ?? {};
        const eyeHeight = mMeta.eyeHeight ?? vMeta.eyeHeight ?? 1600;
        const targetHeight = mMeta.targetHeight ?? vMeta.targetHeight ?? 1600;
        const fov = mMeta.fov ?? vMeta.fov ?? 60;
        const targetId = portal?.id ?? single.id;

        return (
          <>
            <Divider />
            <div className={styles.section} data-testid="camera-section">
              <h3 className="u-section-title">{t('Camera Settings')}</h3>
              <FieldRow>
                <Field label="Eye height">
                  <NumberField
                    value={eyeHeight}
                    unit={unit}
                    precision={precision}
                    min={0}
                    onCommit={(v) => void dispatch('set-camera-settings', { id: targetId, eyeHeight: v })}
                    ariaLabel="Camera eye height"
                  />
                </Field>
                <Field label="Target height">
                  <NumberField
                    value={targetHeight}
                    unit={unit}
                    precision={precision}
                    min={0}
                    onCommit={(v) => void dispatch('set-camera-settings', { id: targetId, targetHeight: v })}
                    ariaLabel="Camera target height"
                  />
                </Field>
              </FieldRow>
              <FieldRow single>
                <Field label="Field of View (FOV)">
                  <NumberField
                    value={fov}
                    suffix="°"
                    precision={0}
                    min={15}
                    max={120}
                    onCommit={(v) => void dispatch('set-camera-settings', { id: targetId, fov: v })}
                    ariaLabel="Camera field of view"
                  />
                </Field>
              </FieldRow>
              <div className={styles.actions} style={{ marginTop: 4 }}>
                <TextButton onClick={() => void dispatch('set-camera-settings', { id: targetId, eyeHeight: 1600, targetHeight: 1600 })}>Eye level (1.6m)</TextButton>
                <TextButton onClick={() => void dispatch('set-camera-settings', { id: targetId, eyeHeight: 8000, targetHeight: 0 })}>Bird's eye (8m)</TextButton>
              </div>
            </div>
            {portal && (
              <div className={styles.actions}>
                <TextButton primary onClick={() => void dispatch('open-view3d', { id: portal.id })}>{t('Open camera view full screen')}</TextButton>
                <TextButton onClick={() => void dispatch('lock-view', { id: portal.id })}>{t('Lock view as image')}</TextButton>
              </div>
            )}
          </>
        );
      })()}

      {single?.kind === 'instance' && <CaiParameters element={single} controlled={graphControlled} />}
      {single && isAnalysisElement(single) && <AnalysisInspector element={single} />}
      {single?.meta?.['view3d'] && <ViewSettings portalId={single.id} />}
      {single?.meta?.['view3d'] && !((single.meta['view3d'] as { cameraMode?: boolean; cameraId?: string }).cameraMode || (single.meta['view3d'] as { cameraId?: string }).cameraId) ? (
        <div className={styles.actions}>
          <TextButton primary onClick={() => void dispatch('open-view3d', { id: single.id })}>{(single.meta['view3d'] as { cut?: unknown; sectionLineId?: unknown }).cut || (single.meta['view3d'] as { sectionLineId?: unknown }).sectionLineId ? 'Open section full screen' : (single.meta['view3d'] as { planRegionId?: unknown }).planRegionId ? 'Open plan full screen' : 'Open 3D workspace'}</TextButton>
          {Boolean((single.meta['view3d'] as { sectionLineId?: unknown }).sectionLineId) && <TextButton onClick={() => void dispatch('flip-section-view', { id: single.id })}>Flip direction</TextButton>}
          <TextButton onClick={() => void dispatch('lock-view', { id: single.id })}>Lock view as image</TextButton>
        </div>
      ) : null}
      {single?.kind === 'instance' && !isDoor && archType !== 'window' && (
        <>
          <div className={styles.section}>
            <FieldRow single>
              <Field label="Level of detail">
                <SelectField
                  value={elementLod(single) ?? 'view'}
                  options={[
                    { value: 'view', label: 'Follow the view' },
                    { value: 'high', label: 'Always high (3D model)' },
                    { value: 'low', label: 'Always low (low-poly / box in 3D)' },
                  ]}
                  onChange={(lod) => void dispatch('set-element-lod', { ids: [single.id], lod: lod === 'view' ? null : lod })}
                  ariaLabel="Element level of detail"
                />
              </Field>
            </FieldRow>
          </div>
          <div className={styles.actions}>
            <TextButton onClick={() => void dispatch('detach-instance', { ids: [single.id] })}>Detach from asset</TextButton>
          </div>
        </>
      )}
      {single?.kind === 'group' && (
        <div className={styles.actions}>
          <TextButton onClick={() => void dispatch('ungroup-selection', { ids: [single.id] })}>Ungroup</TextButton>
        </div>
      )}
      {!single && (
        <div className={styles.actions}>
          <TextButton onClick={() => void dispatch('group-selection', {})}>Group</TextButton>
          <TextButton onClick={() => void dispatch('create-asset-definition', {})}>Make asset</TextButton>
        </div>
      )}

      <BridgeInspector ids={ids} />
      <Divider />
      <div className={styles.section}>
        <ToggleRow label="Pinned" value={elements.every((e) => e.locked)} mixed={elements.some((e) => e.locked) && !elements.every((e) => e.locked)} onChange={(v) => setProp('locked', v)} />
        <ToggleRow label="Visible" value={elements.every((e) => e.visible)} mixed={elements.some((e) => e.visible) && !elements.every((e) => e.visible)} onChange={(v) => setProp('visible', v)} />
      </div>
      {single?.meta && (
        <div className={styles.chips} aria-label="Metadata">
          {Object.entries(single.meta).map(([key, value]) => (
            <span key={key} className={styles.chip}>
              {key}: {typeof value === 'object' && value !== null && !Array.isArray(value) ? ((value as { type?: string; kind?: string }).type ?? (value as { kind?: string }).kind ?? JSON.stringify(value)) : String(value)}
            </span>
          ))}
        </div>
      )}
    </>
  );
}


function kindTitle(element: Element): string {
  if (element.meta?.['cameraMarker']) {
    return 'Camera';
  }
  if (element.meta?.['sectionLine']) {
    return 'Section Line';
  }
  if (element.meta?.['view3d']) {
    const v3d = element.meta['view3d'] as { cameraMode?: boolean; cameraId?: string; cut?: unknown; sectionLineId?: unknown };
    if (v3d.cameraMode || v3d.cameraId) return 'Camera View';
    if (v3d.cut || v3d.sectionLineId) return 'Section View';
    if ((v3d as { planRegionId?: unknown }).planRegionId) return 'Plan View';
    return '3D View';
  }
  if (element.meta?.['paper']) {
    return 'Paper Sheet';
  }
  const diagram = diagramOf(element);
  if (diagram) return diagram.kind[0]!.toUpperCase() + diagram.kind.slice(1);
  if (sheetViewOf(element)) return 'View Frame';
  if (titleBlockOf(element)) return 'Title Block';
  if (scaleBarOf(element)) return 'Scale Bar';
  if (northArrowOf(element)) return 'North Arrow';
  const arch = element.meta?.['arch'];
  if (arch && typeof arch === 'object' && !Array.isArray(arch) && typeof arch['type'] === 'string') {
    return arch['type'].replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  }
  switch (element.kind) {
    case 'rect':
      return 'Rectangle';
    case 'line':
      return 'Line';
    case 'text':
      return 'Text';
    case 'image':
      return 'Image';
    case 'group':
      return 'Group';
    case 'instance':
      return 'Asset instance';
  }
}
