// Live Bridge end to end with two real Blender processes (A and B), AutoCAD (C, accoreconsole,
// when installed) and the ArchAI desktop app.
//   1. npm run dev (Vite on 5173), npm run build:electron and
//      dotnet build plugins/autocad/Archai.AutoCAD.BridgeTest -c Release
//   2. node scripts/bridge-e2e.mjs [path to blender.exe] [path to accoreconsole.exe]
// ArchAI runs with a throwaway profile on ARCHAI_LIVE_PORT 47899 (an installed ArchAI keeps the
// normal port), the Blenders with a throwaway LOCALAPPDATA (the plugin's project links).
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const blender = process.argv[2] ?? 'C:/Program Files/Blender Foundation/Blender 4.2/blender.exe';
const accore = process.argv[3] ?? 'C:/Program Files/Autodesk/AutoCAD 2026/accoreconsole.exe';
const agentDll = join(repo, 'plugins/autocad/Archai.AutoCAD.BridgeTest/bin/Release/net8.0-windows/Archai.AutoCAD.BridgeTest.dll');
const PORT = 47899;
const work = mkdtempSync(join(tmpdir(), 'archai-bridge-e2e-'));
const stage = join(work, 'stage');
mkdirSync(join(stage, 'archai'), { recursive: true });
cpSync(join(repo, 'plugins/blender/archai'), join(stage, 'archai'), { recursive: true });
cpSync(join(repo, 'plugins/python/archai_core.py'), join(stage, 'archai/archai_core.py'));
const control = join(work, 'control.json');
const steps = { A: [], B: [], C: [] };
const send = (role, step) => {
  steps[role].push(step);
  writeFileSync(control, JSON.stringify(steps));
};
writeFileSync(control, JSON.stringify(steps));

let failures = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`);
};

const archai = await electron.launch({ cwd: repo, args: ['.', `--user-data-dir=${join(work, 'profile')}`], env: { ...process.env, ARCHAI_DEV_URL: 'http://localhost:5173', ARCHAI_LIVE_PORT: String(PORT) } });
const page = await archai.firstWindow();
page.on('pageerror', (error) => console.log('ARCHAI PAGE ERROR', error.message));
await page.waitForSelector('text=Meridian Tower', { timeout: 90000 });

const agents = {};
for (const role of ['A', 'B']) {
  const appdata = join(work, `appdata-${role}`);
  mkdirSync(appdata, { recursive: true });
  const child = spawn(blender, ['--background', '--factory-startup', '--python', join(repo, 'plugins/blender/test_bridge_agent.py'), '--', stage, role, control, join(work, `status-${role}.json`)], {
    // A Blender profile of its own: a factory-startup Blender with the user's profile would remove
    // the Python packages of the user's extensions.
    env: { ...process.env, ARCHAI_LIVE_PORT: String(PORT), LOCALAPPDATA: appdata, BLENDER_USER_CONFIG: join(appdata, 'config'), BLENDER_USER_SCRIPTS: join(appdata, 'scripts'), BLENDER_USER_EXTENSIONS: join(appdata, 'extensions'), BLENDER_USER_DATAFILES: join(appdata, 'datafiles') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  agents[role] = { child, log: () => log };
}

const blenderState = (role) => {
  const file = join(work, `status-${role}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};
const archaiState = () =>
  page.evaluate(() => {
    const s = window.__archai.store.getState();
    const bridge = s.doc.bridge ?? { sources: {}, elements: {}, conflicts: [], held: [], log: [] };
    const elements = Object.values(s.doc.elements).filter((e) => e.kind !== 'group').map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y, refs: Object.fromEntries(Object.entries(bridge.elements[e.id]?.refs ?? {}).map(([k, r]) => [k, { id: r.id, role: r.role }])) }));
    return { screen: s.ui.screen, project: s.doc.meta.name, elements, sources: Object.keys(bridge.sources), conflicts: bridge.conflicts, log: bridge.log.map((l) => l.text) };
  });
async function waitFor(label, predicate, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  check(label, false, `(timed out)`);
  return null;
}
const keyA = 'blender:C:/bridge-test/A.blend';
const keyB = 'blender:C:/bridge-test/B.blend';
const ofSource = (state, key) => state.elements.filter((e) => e.refs[key]?.role === 'origin');
const liveIn = (role) => (blenderState(role)?.objects ?? []).filter((o) => o.live);

try {
  // 1. Both Blenders connect; ArchAI opens a project for the first one, the second joins it.
  send('A', 'start');
  let state = await waitFor('A connects and sends its cube', async () => {
    const s = await archaiState();
    return ofSource(s, keyA).length === 1 ? s : null;
  }, 60000);
  check('A connected, project opened', Boolean(state), state ? `project "${state.project}"` : '');
  send('B', 'start');
  state = await waitFor('B connects and sends its column', async () => {
    const s = await archaiState();
    return ofSource(s, keyB).length === 1 ? s : null;
  }, 60000);
  check('B joined the same project', Boolean(state) && state.sources.length === 2);
  const wallId = ofSource(state, keyA)[0]?.id;
  const columnId = ofSource(state, keyB)[0]?.id;
  await waitFor('A receives B\'s column (one object)', () => liveIn('A').length === 1 && liveIn('A')[0].archai_id === columnId);
  await waitFor('B receives A\'s cube (one object)', () => liveIn('B').length === 1 && liveIn('B')[0].archai_id === wallId);
  check('each Blender has the other one\'s model', liveIn('A').length === 1 && liveIn('B').length === 1);
  check('received objects carry their source colour', liveIn('B')[0]?.color?.join() !== '1,1,1,1', JSON.stringify(liveIn('B')[0]?.color));

  // 2. A moves its cube: same element in ArchAI, B's copy follows (replaced, not duplicated).
  const xBefore = (await archaiState()).elements.find((e) => e.id === wallId).x;
  send('A', 'move');
  state = await waitFor('ArchAI moves the cube', async () => {
    const s = await archaiState();
    const wall = s.elements.find((e) => e.id === wallId);
    return wall && Math.abs(wall.x - xBefore - 2000) < 1 ? s : null;
  });
  check('A\'s move updated the same element in ArchAI', Boolean(state));
  await waitFor('B follows the move', () => {
    const cube = liveIn('B')[0];
    return liveIn('B').length === 1 && cube && Math.abs(cube.center[0] - 3) < 0.01;
  });
  check('B\'s view of the cube moved, still one object', liveIn('B').length === 1, JSON.stringify(liveIn('B')[0]?.center));

  // 3. ArchAI moves A's cube with the transform shared: A's own cube moves in Blender.
  await page.evaluate(([key, id]) => {
    const { executor } = window.__archai;
    executor.dispatchSync('bridge-set-source', { key, authority: { transform: 'shared' } });
    executor.dispatchSync('select', { ids: [id] });
    const result = executor.dispatchSync('move-selection', { ids: [id], dx: 1000, dy: 0 });
    if (!result.ok) throw new Error(result.error.message);
  }, [keyA, wallId]);
  const own = () => (blenderState('A')?.objects ?? []).find((o) => !o.live && !o.copy_of);
  await waitFor('A\'s cube moves where ArchAI moved it', () => own() && Math.abs(own().location[0] - 4) < 0.01);
  check('ArchAI\'s move reached A\'s own cube', Boolean(own()) && Math.abs(own().location[0] - 4) < 0.01, JSON.stringify(own()?.location));
  await new Promise((r) => setTimeout(r, 4000));
  state = await archaiState();
  check('no conflict after A caught up', state.conflicts.length === 0, JSON.stringify(state.conflicts));
  check('still one cube in ArchAI', ofSource(state, keyA).length === 1);

  // 4. A hides its cube: partial snapshot, nothing deleted in ArchAI.
  send('A', 'hide');
  await new Promise((r) => setTimeout(r, 5000));
  state = await archaiState();
  check('hiding in A deletes nothing in ArchAI', state.elements.some((e) => e.id === wallId));

  // 5. B deletes its column: deleted in ArchAI, removed from A.
  send('B', 'delete');
  state = await waitFor('ArchAI deletes the column', async () => {
    const s = await archaiState();
    return s.elements.some((e) => e.id === columnId) ? null : s;
  });
  check('deleting in B deleted the element in ArchAI', Boolean(state));
  await waitFor('A drops the column', () => liveIn('A').length === 0);
  check('A no longer shows the column', liveIn('A').length === 0);

  send('A', 'unhide');
  // 6. A's cube cannot be edited in B while it is A's: offering it is refused. Released into an
  //    ArchAI element first, it can be offered to B as an editable copy (names only): B makes it
  //    its own object, ArchAI links it, and B's rename comes back to the same element.
  const refused = await page.evaluate(([key, id]) => window.__archai.executor.dispatchSync('bridge-offer', { ids: [id], key, facets: ['metadata'] }).ok, [keyB, wallId]);
  check("another app cannot get an app's geometry to edit", refused === false);
  await page.evaluate(([key, id]) => {
    const { executor } = window.__archai;
    let r = executor.dispatchSync('bridge-convert', { ids: [id] });
    if (!r.ok) throw new Error(r.error.message);
    r = executor.dispatchSync('bridge-offer', { ids: [id], key, facets: ['metadata'] });
    if (!r.ok) throw new Error(r.error.message);
  }, [keyB, wallId]);
  const copyInB = () => (blenderState('B')?.objects ?? []).find((o) => o.copy_of === wallId);
  await waitFor('B creates an editable copy', () => copyInB() && !copyInB().live);
  check('B has an editable copy (not in ArchAI Live)', Boolean(copyInB()), JSON.stringify(copyInB()?.collections));
  state = await waitFor('ArchAI links the copy', async () => {
    const s = await archaiState();
    return s.elements.find((e) => e.id === wallId)?.refs[keyB]?.role === 'copy' ? s : null;
  });
  check('ArchAI linked B\'s copy to the same element (no new element)', Boolean(state) && state.elements.length === 1, state ? `${state.elements.length} elements` : '');
  send('B', 'rename-copy');
  state = await waitFor('B\'s rename reaches ArchAI', async () => {
    const s = await archaiState();
    return s.elements.find((e) => e.id === wallId)?.name === 'Copy renamed in B' ? s : null;
  });
  check('an offered facet edited in B updates the element', Boolean(state));

  // 7. Released, the cube is ArchAI's: A's rename of its own cube no longer changes it (and A's
  //    cube is not added again).
  send('A', 'rename');
  await new Promise((r) => setTimeout(r, 5000));
  state = await archaiState();
  check('the app no longer changes a released element', state.elements.find((e) => e.id === wallId)?.name === 'Copy renamed in B', state.elements.find((e) => e.id === wallId)?.name);
  check('nor adds it again', state.elements.length === 1, `${state.elements.length} elements`);

  // 8. AutoCAD joins: a third, different app on the same project (protocol 2 in the C# core).
  if (existsSync(accore) && existsSync(agentDll)) {
    const appdata = join(work, 'appdata-C');
    mkdirSync(appdata, { recursive: true });
    const script = join(work, 'agent.scr');
    // SECURELOAD goes back to 1 (its default) before quitting.
    writeFileSync(script, ['SECURELOAD', '0', 'NETLOAD', '"' + agentDll.split('/').join('\\') + '"', 'INSUNITS', '4', 'ARCHAIBRIDGEAGENT', 'SECURELOAD', '1', 'QUIT', 'Y', ''].join('\r\n'));
    const child = spawn(accore, ['/s', script], { env: { ...process.env, ARCHAI_LIVE_PORT: String(PORT), LOCALAPPDATA: appdata, ARCHAI_BRIDGE_CONTROL: control, ARCHAI_BRIDGE_STATUS: join(work, 'status-C.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    agents.C = { child, log: () => log };
    const acad = () => blenderState('C')?.entities ?? [];
    await waitFor('AutoCAD agent runs', () => blenderState('C'), 120000);
    send('C', 'start');
    const keyC = 'autocad:C:/bridge-test/C.dwg';
    state = await waitFor('AutoCAD sends its box', async () => {
      const s = await archaiState();
      return ofSource(s, keyC).length === 1 ? s : null;
    }, 60000);
    check('AutoCAD joined the project and sent its box', Boolean(state));
    const boxId = state ? ofSource(state, keyC)[0].id : '';
    await waitFor('AutoCAD receives the Blender cube, tagged', () => acad().some((e) => e.archai_id === wallId && e.layer.startsWith('ArchAI Live')));
    check('AutoCAD has the Blender cube on an ArchAI Live layer', acad().some((e) => e.archai_id === wallId && e.layer.startsWith('ArchAI Live')), JSON.stringify(acad().map((e) => e.layer)));
    await waitFor('Blender A receives the AutoCAD box', () => liveIn('A').some((o) => o.archai_id === boxId));
    check('Blender A has the AutoCAD box', liveIn('A').some((o) => o.archai_id === boxId));
    // AutoCAD moves its box: the same element moves in ArchAI, and in Blender A.
    const boxX = (await archaiState()).elements.find((e) => e.id === boxId).x;
    send('C', 'move');
    state = await waitFor('ArchAI moves the AutoCAD box', async () => {
      const s = await archaiState();
      const box = s.elements.find((e) => e.id === boxId);
      return box && Math.abs(box.x - boxX - 2000) < 1 ? s : null;
    });
    check("AutoCAD's move updated the same element", Boolean(state));
    await waitFor('Blender A follows', () => liveIn('A').some((o) => o.archai_id === boxId && Math.abs(o.center[0] - 12.5) < 0.01));
    check("Blender A's view of the box moved", liveIn('A').some((o) => o.archai_id === boxId && Math.abs(o.center[0] - 12.5) < 0.01), JSON.stringify(liveIn('A').find((o) => o.archai_id === boxId)?.center));
    // ArchAI moves the box (transform shared): AutoCAD's own solid moves.
    await page.evaluate(([key, id]) => {
      const { executor } = window.__archai;
      executor.dispatchSync('bridge-set-source', { key, authority: { transform: 'shared' } });
      executor.dispatchSync('select', { ids: [id] });
      const result = executor.dispatchSync('move-selection', { ids: [id], dx: 0, dy: -1000 });
      if (!result.ok) throw new Error(result.error.message);
    }, [keyC, boxId]);
    const solid = () => acad().find((e) => !e.archai_id && !e.copy_of);
    await waitFor("AutoCAD's solid moves where ArchAI moved it", () => solid() && Math.abs(solid().center[1] - 1500) < 1);
    check("ArchAI's move reached AutoCAD's own solid (plan y down = AutoCAD y up)", Boolean(solid()) && Math.abs(solid().center[1] - 1500) < 1, JSON.stringify(solid()?.center));
    // ArchAI offers the Blender cube to AutoCAD as an editable copy.
    await page.evaluate(([key, id]) => window.__archai.executor.dispatchSync('bridge-offer', { ids: [id], key, facets: ['transform'] }), [keyC, wallId]);
    await waitFor('AutoCAD makes an editable copy', () => acad().some((e) => e.copy_of === wallId && e.layer === 'ArchAI Copies'));
    check('AutoCAD has an editable copy on "ArchAI Copies"', acad().some((e) => e.copy_of === wallId && e.layer === 'ArchAI Copies'));
    state = await waitFor("ArchAI links AutoCAD's copy", async () => {
      const s = await archaiState();
      return s.elements.find((e) => e.id === wallId)?.refs[keyC]?.role === 'copy' ? s : null;
    });
    check("ArchAI linked AutoCAD's copy to the Blender element", Boolean(state));
    // AutoCAD deletes its box: deleted in ArchAI and gone from Blender A.
    send('C', 'delete');
    state = await waitFor('ArchAI deletes the box', async () => {
      const s = await archaiState();
      return s.elements.some((e) => e.id === boxId) ? null : s;
    });
    check('deleting in AutoCAD deleted the element', Boolean(state));
    await waitFor('Blender A drops the box', () => !liveIn('A').some((o) => o.archai_id === boxId));
    check('Blender A no longer shows the box', !liveIn('A').some((o) => o.archai_id === boxId));
  } else console.log('SKIP AutoCAD (accoreconsole or the agent build missing)');

  console.log('ArchAI log:', (await archaiState()).log.slice(-12));
} catch (error) {
  failures += 1;
  console.log('ERROR', error);
} finally {
  send('A', 'stop');
  send('B', 'stop');
  send('C', 'stop');
  await new Promise((r) => setTimeout(r, 3000));
  for (const role of Object.keys(agents)) {
    if (agents[role].child.exitCode === null) agents[role].child.kill();
    const tail = agents[role].log().split('\n').filter((l) => /Error|Traceback|error/i.test(l)).slice(-10);
    if (tail.length) console.log(`Blender ${role} errors:\n${tail.join('\n')}`);
    console.log(`Blender ${role} status:`, blenderState(role)?.statuses);
  }
  await archai.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED', `(${work})`);
  process.exit(failures ? 1 : 0);
}
