import { Package, Activity, PenLine, Box, ChevronUp, Circle, Copy, Egg, FlipHorizontal2, Grid3x3, Shapes, Crosshair, FileText, Hand, Hexagon, Image as ImageIcon, LayoutTemplate, Library, MapPin, Move, MousePointer2, MoveRight, Network, Paintbrush, PenTool, RotateCw, Ruler, Scaling, Scissors, Slash, Slice, Spline, Square, SquareDashed, SquareRoundCorner, Sun, Type, Video, Volume2, Wind, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAppState, useDispatch } from '@/app/context';
import { archToolsByCategory, getArchTool } from '@/assets/arch-tools';
import { analysisOf } from '@/analysis/model';
import { formatShortcut, IS_MAC } from '@/commands';
import type { ToolId } from '@/store';
import { IconButton, Menu, type MenuContent } from './primitives';
import styles from './Toolbar.module.css';
import { useI18n } from './i18n';
import { DIAGRAM_TOOLS, diagramToolHint } from '@/diagrams/tools';
import { DIAGRAM_THEMES, THEMES } from '@/diagrams/model';
import { DraftingBar } from './DraftingBar';
import { AnnotationBar, ANNOTATE_TOOLS } from './AnnotationBar';

const ICON = 18;

interface ToolButton {
  tool: ToolId;
  command: string;
  label: string;
  shortcut?: string;
  icon: ReactNode;
}

/** Each section shows its first two tools; the rest open from the section's ▾ menu. */
const SECTIONS: { label: string; tools: ToolButton[] }[] = [
  {
    label: 'Navigate',
    tools: [
      { tool: 'select', command: 'tool-select', label: 'Select', shortcut: 'V', icon: <MousePointer2 size={ICON} /> },
      { tool: 'hand', command: 'tool-hand', label: 'Hand', shortcut: 'H', icon: <Hand size={ICON} /> },
    ],
  },
  {
    label: 'Draw and annotate',
    tools: [
      { tool: 'rect', command: 'tool-rect', label: 'Rectangle', shortcut: 'R', icon: <Square size={ICON} /> },
      { tool: 'line', command: 'tool-line', label: 'Line', shortcut: 'L', icon: <Slash size={ICON} /> },
      { tool: 'draw:circle', command: 'tool-circle', label: 'Circle', shortcut: 'C', icon: <Circle size={ICON} /> },
      { tool: 'draw:arc', command: 'tool-arc', label: 'Arc', shortcut: 'A', icon: <Spline size={ICON} /> },
      { tool: 'draw:polygon', command: 'tool-polygon', label: 'Polygon', shortcut: 'PG', icon: <Hexagon size={ICON} /> },
      { tool: 'draw:ellipse', command: 'tool-ellipse', label: 'Ellipse', shortcut: 'EL', icon: <Egg size={ICON} /> },
      { tool: 'draw:pen', command: 'tool-pen', label: 'Curve (pen)', shortcut: 'B', icon: <PenTool size={ICON} /> },
      { tool: 'point', command: 'tool-point', label: 'Point', shortcut: 'P', icon: <Crosshair size={ICON} /> },
      { tool: 'text', command: 'tool-text', label: 'Text', shortcut: 'T', icon: <Type size={ICON} /> },
      { tool: 'image', command: 'tool-image', label: 'Image', shortcut: 'I', icon: <ImageIcon size={ICON} /> },
      { tool: 'model', command: 'tool-model', label: '3D model (FBX, OBJ, GLB, STL...)', shortcut: 'Shift+M', icon: <Package size={ICON} /> },
      { tool: 'measure', command: 'tool-measure', label: 'Measure', shortcut: 'M', icon: <Ruler size={ICON} /> },
    ],
  },
  {
    label: 'Views and sheets',
    tools: [
      { tool: 'view3d', command: 'tool-view3d', label: '3D view', shortcut: 'Shift+3', icon: <Box size={ICON} /> },
      { tool: 'section', command: 'tool-section', label: 'Section view', shortcut: 'Shift+S', icon: <Scissors size={ICON} /> },
      { tool: 'camera', command: 'tool-camera', label: 'Camera view', shortcut: 'Shift+C', icon: <Video size={ICON} /> },
      { tool: 'paper', command: 'tool-paper', label: 'Paper', shortcut: 'Shift+P', icon: <FileText size={ICON} /> },
    ],
  },
];

/** Edit tools (Revit / AutoCAD), with their two-letter shortcuts. */
const MODIFY_TOOLS: ToolButton[] = [
  { tool: 'modify:move', command: 'tool-move', label: 'Move', shortcut: 'MV', icon: <Move size={16} /> },
  { tool: 'modify:copy', command: 'tool-copy', label: 'Copy', shortcut: 'CO', icon: <Copy size={16} /> },
  { tool: 'modify:rotate', command: 'tool-rotate', label: 'Rotate', shortcut: 'RO', icon: <RotateCw size={16} /> },
  { tool: 'modify:mirror', command: 'tool-mirror', label: 'Mirror', shortcut: 'MM', icon: <FlipHorizontal2 size={16} /> },
  { tool: 'modify:scale', command: 'tool-scale', label: 'Scale', shortcut: 'RE', icon: <Scaling size={16} /> },
  { tool: 'modify:array', command: 'tool-array', label: 'Array', shortcut: 'AR', icon: <Grid3x3 size={16} /> },
  { tool: 'modify:offset', command: 'tool-offset', label: 'Offset', shortcut: 'OF', icon: <SquareDashed size={16} /> },
  { tool: 'modify:trim', command: 'tool-trim', label: 'Trim / extend to corner', shortcut: 'TR', icon: <Scissors size={16} /> },
  { tool: 'modify:extend', command: 'tool-extend', label: 'Extend to boundary', shortcut: 'ET', icon: <MoveRight size={16} /> },
  { tool: 'modify:split', command: 'tool-split', label: 'Split', shortcut: 'SL', icon: <Slice size={16} /> },
  { tool: 'modify:fillet', command: 'tool-fillet', label: 'Fillet / chamfer', shortcut: 'FL', icon: <SquareRoundCorner size={16} /> },
  { tool: 'modify:match', command: 'tool-match', label: 'Match properties', shortcut: 'MA', icon: <Paintbrush size={16} /> },
];

const ANALYZE_TOOLS: ToolButton[] = [
  { tool: 'analysis-sun', command: 'tool-analysis-sun', label: 'Sun analysis', icon: <Sun size={16} /> },
  { tool: 'analysis-location', command: 'tool-analysis-location', label: 'Location', icon: <MapPin size={16} /> },
  { tool: 'analysis-wind', command: 'tool-analysis-wind', label: 'Wind analysis', icon: <Wind size={16} /> },
  { tool: 'analysis-noise', command: 'tool-analysis-noise', label: 'Noise analysis', icon: <Volume2 size={16} /> },
];

type MenuKind = 'build' | 'analyze' | 'diagram' | 'overflow' | 'modify' | 'annotate';
type OpenMenu = { kind: MenuKind; x: number; y: number; entries: MenuContent } | null;

export function Toolbar() {
  const { t: tr } = useI18n();
  const dispatch = useDispatch();
  const tool = useAppState((s) => s.ui.tool);
  const leftTab = useAppState((s) => s.ui.panels.leftTab);
  const leftOpen = useAppState((s) => s.ui.panels.left);
  const running = useAppState((s) => Object.values(s.doc.elements).some((e) => analysisOf(e)?.active));
  const diagramTheme = useAppState((s) => s.doc.workspace.diagramTheme);
  const [menu, setMenu] = useState<OpenMenu>(null);

  const openMenu = (kind: MenuKind, anchor: HTMLElement, entries: MenuContent) => {
    const rect = anchor.getBoundingClientRect();
    setMenu({ kind, x: rect.left, y: rect.top - 8, entries });
  };

  const archActive = tool.startsWith('arch:');
  const archLabel = archActive ? (getArchTool(tool.slice(5))?.label ?? 'Build') : 'Build';
  const buildEntries: MenuContent = archToolsByCategory().flatMap(({ category, tools }) => [
    { title: category },
    ...tools.map((t) => ({
      id: `${category}:${t.id}`,
      label: t.label,
      shortcut: t.shortcut ? formatShortcut(t.shortcut, IS_MAC) : undefined,
      onSelect: () => void dispatch(`tool-arch-${t.id}`),
    })),
  ]);

  const analyzeActive = ANALYZE_TOOLS.find((t) => t.tool === tool || (tool === 'noise-emitter' && t.tool === 'analysis-noise'));
  const analyzeEntries: MenuContent = [
    ...ANALYZE_TOOLS.map((t) => ({ id: t.tool, label: t.label, icon: t.icon, onSelect: () => void dispatch(t.command) })),
    ...(running ? [{ separator: true as const }, { id: 'stop-analysis', label: 'Stop running analysis', onSelect: () => void dispatch('stop-analysis') }] : []),
  ];

  const modifyActive = MODIFY_TOOLS.find((t) => t.tool === tool);
  const modifyEntries: MenuContent = [
    ...MODIFY_TOOLS.map((t) => ({ id: t.tool, label: t.label, icon: t.icon, shortcut: t.shortcut, onSelect: () => void dispatch(t.command) })),
    { separator: true as const },
    { id: 'join-lines', label: 'Join lines', onSelect: () => void dispatch('join-lines') },
    { id: 'explode-selection', label: 'Explode', onSelect: () => void dispatch('explode-selection') },
  ];
  const diagramActive = DIAGRAM_TOOLS.find((t) => t.tool === tool);
  const diagramEntries: MenuContent = [
    ...DIAGRAM_TOOLS.map((t) => ({ id: t.tool, label: t.label, icon: t.icon(16), onSelect: () => void dispatch(t.command) })),
    { separator: true as const },
    { title: 'Theme' },
    ...DIAGRAM_THEMES.map((theme) => ({ id: `theme:${theme}`, label: `${THEMES[theme].label}${theme === diagramTheme ? '  ✓' : ''}`, onSelect: () => void dispatch('set-diagram-theme', { theme }) })),
  ];

  const annotateActive = ANNOTATE_TOOLS.find((t) => t.tool === tool);
  const annotateEntries: MenuContent = [
    ...ANNOTATE_TOOLS.map((t) => ({ id: t.tool, label: t.label, icon: t.icon(16), shortcut: t.shortcut ? formatShortcut(t.shortcut, IS_MAC) : undefined, onSelect: () => void dispatch(t.command) })),
    { separator: true as const },
    { id: 'new-annotation-layer', label: 'New annotation layer', onSelect: () => void dispatch('create-annotation-layer') },
  ];

  /** Icon-only menu button: shows the active tool's icon, names it in the tooltip. */
  const menuButton = (kind: MenuKind, label: string, icon: ReactNode, active: boolean, entries: MenuContent, testId: string, extra?: Record<string, unknown>) => (
    <button
      type="button"
      className={styles.build}
      data-active={active || undefined}
      aria-haspopup="menu"
      aria-expanded={menu?.kind === kind}
      aria-label={tr(label)}
      title={tr(label)}
      onClick={(e) => openMenu(kind, e.currentTarget, entries)}
      data-testid={testId}
      {...extra}
    >
      {icon}
      <ChevronUp size={12} />
    </button>
  );

  const toolButton = (t: ToolButton) => (
    <IconButton
      key={t.tool}
      size="large"
      label={t.shortcut ? `${tr(t.label)} (${t.shortcut})` : tr(t.label)}
      active={tool === t.tool}
      onClick={() => void dispatch(t.command)}
      data-testid={`tool-${t.tool}`}
    >
      {t.icon}
    </IconButton>
  );

  return (
    <>
      <div className={styles.toolbarContainer} data-ui-scale>
        <div className={styles.toolbar} role="toolbar" aria-label={tr('Tools')}>
          {SECTIONS.map((section, index) => {
            const shown = section.tools.slice(0, 2);
            const more = section.tools.slice(2);
            const activeMore = more.find((t) => t.tool === tool);
            return (
              <div key={section.label} className={styles.sectionWrap}>
                {index > 0 && <div className={styles.separator} />}
                <div className={styles.group} aria-label={tr(section.label)}>
                  {shown.map(toolButton)}
                  {more.length > 0 && (
                    <button
                      type="button"
                      className={styles.more}
                      data-active={activeMore ? true : undefined}
                      aria-haspopup="menu"
                      aria-label={tr(`More ${section.label.toLowerCase()} tools`)}
                      title={activeMore ? tr(activeMore.label) : tr('More tools')}
                      onClick={(e) =>
                        openMenu(
                          'overflow',
                          e.currentTarget,
                          more.map((t) => ({ id: t.tool, label: t.label, icon: t.icon, shortcut: t.shortcut ? formatShortcut(t.shortcut, IS_MAC) : undefined, onSelect: () => void dispatch(t.command) })),
                        )
                      }
                      data-testid={`tools-more-${index}`}
                    >
                      {activeMore?.icon}
                      <ChevronUp size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div className={styles.separator} />
          {menuButton('modify', modifyActive?.label ?? 'Modify', modifyActive ? modifyActive.icon : <Wrench size={ICON} />, Boolean(modifyActive), modifyEntries, 'tool-modify')}
          {menuButton('build', archLabel, <LayoutTemplate size={ICON} />, archActive, buildEntries, 'tool-build')}
          {menuButton('analyze', analyzeActive?.label ?? 'Analyze', analyzeActive ? analyzeActive.icon : <Activity size={ICON} />, Boolean(analyzeActive), analyzeEntries, 'tool-analyze', { 'data-running': running || undefined })}
          {menuButton('diagram', diagramActive?.label ?? 'Diagram', diagramActive ? diagramActive.icon(ICON) : <Shapes size={ICON} />, Boolean(diagramActive), diagramEntries, 'tool-diagram')}
          {menuButton('annotate', annotateActive?.label ?? 'Annotate', annotateActive ? annotateActive.icon(ICON) : <PenLine size={ICON} />, Boolean(annotateActive), annotateEntries, 'tool-annotate')}
          <IconButton
            size="large"
            label={`${tr('Parametric component')} (Shift+N)`}
            active={tool === 'parametric'}
            onClick={() => void dispatch('tool-parametric')}
            data-testid="tool-parametric"
          >
            <Network size={ICON} />
          </IconButton>
          <div className={styles.separator} />
          <IconButton
            size="large"
            label={`${tr('Asset library')} (${formatShortcut('Mod+Shift+A', IS_MAC)})`}
            active={leftOpen && leftTab === 'assets'}
            onClick={() => void dispatch(leftOpen && leftTab === 'assets' ? 'toggle-left-panel' : 'show-assets')}
            data-testid="tool-assets"
          >
            <Library size={ICON} />
          </IconButton>
        </div>
      </div>
      {menu && <UpMenu position={menu} entries={menu.entries} onClose={() => setMenu(null)} ariaLabel={menu.kind === 'build' ? 'Architecture tools' : menu.kind === 'analyze' ? 'Analysis tools' : menu.kind === 'diagram' ? 'Diagram tools' : menu.kind === 'modify' ? 'Modify tools' : menu.kind === 'annotate' ? 'Annotation tools' : 'More tools'} />}
      <DraftingBar />
      <AnnotationBar />
      <ToolHint />
    </>
  );
}

/** Anchors a menu above the toolbar (menus normally open downwards). */
function UpMenu({ position, entries, onClose, ariaLabel }: { position: { x: number; y: number }; entries: MenuContent; onClose: () => void; ariaLabel: string }) {
  return <Menu position={position} placement="above" entries={entries} onClose={onClose} ariaLabel={ariaLabel} />;
}

function ToolHint() {
  const { t } = useI18n();
  const tool = useAppState((s) => s.ui.tool);
  const selectionCount = useAppState((s) => s.ui.selection.length);
  let text: string | null = null;
  // Drafting and modify tools explain each step beside the cursor, with their options bar here.
  if (tool === 'rect' || tool.startsWith('draw:') || tool.startsWith('modify:') || tool.startsWith('annotate:') || (tool === 'select' && selectionCount > 1)) return null;
  else if (tool === 'point') text = 'Click to place reference points · set their height in the Inspector or move them in 3D · Esc when done';
  else if (tool === 'line') text = 'Click to add points · double-click or Enter to finish · Esc to cancel';
  else if (tool === 'text') text = 'Click to place text';
  else if (tool === 'image') text = 'Click to choose an image';
  else if (tool === 'model') text = 'Click to place a 3D model (FBX, OBJ, GLB, STL, DAE, 3DS, USDZ, 3DM...)';
  else if (tool === 'measure') text = 'Click the first point, then click the second point · Shift constrains angle';
  else if (tool === 'catalog') text = 'Move to preview the asset · click to place · Esc to cancel';
  else if (tool === 'view3d') text = 'Drag to place a 3D view portal · click for a default size · double-click the portal to open the 3D workspace';
  else if (tool === 'section') text = 'Click the two ends of the cut line · move its endpoints to update the section · flip direction from the viewport';
  else if (tool === 'camera') text = 'Click the eye position, then the aim point · drag either handle later to re-aim · heights & FOV in the Inspector';
  else if (tool === 'paper') text = 'Click for an A4 sheet at 1:50 · drag for a custom sheet · select it and export as PDF from the Inspector';
  else if (tool === 'ai-portal') text = 'Drag to draw an AI portal · click for a default size';
  else if (tool === 'parametric') text = 'Drag a rectangle for the graph origin; move or resize it on the board, and double-click to open its graph';
  else if (tool === 'analysis-sun') text = 'Click to place a sun analysis origin · set date, time and north in the Inspector, then link 3D views and Run';
  else if (tool === 'analysis-wind') text = 'Click to place a wind analysis origin · fetch real wind data or type speed and direction, link 3D views and Run';
  else if (tool === 'analysis-noise') text = 'Click to place a noise analysis origin · then add emitters, link 3D views and Run';
  else if (tool === 'analysis-location') text = 'Drag to draw the project location map · one per project · search an address in the Inspector';
  else if (tool === 'noise-emitter') text = 'Click to add noise emitters to the selected noise origin · Esc when done';
  else if (tool.startsWith('diagram:')) text = diagramToolHint(tool);
  else if (tool.startsWith('arch:')) {
    const arch = getArchTool(tool.slice(5));
    text = arch ? `${arch.label}: ${arch.description}` : null;
  }
  if (!text) return null;
  return (
    <div className={styles.hint} role="status" data-ui-scale>
      {t(text)}
    </div>
  );
}
