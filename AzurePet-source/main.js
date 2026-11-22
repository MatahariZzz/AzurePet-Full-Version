const { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('AzurePet');
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
let START_HIDDEN = process.argv.includes('--hidden');
if (IS_MAC) { try { START_HIDDEN = !!app.getLoginItemSettings().wasOpenedAtLogin; } catch (e) {} }
function linuxAutoStartFile() { return path.join(app.getPath('home'), '.config', 'autostart', 'azurepet.desktop'); }
function getAutoStart() {
  if (IS_LINUX) { try { return fs.existsSync(linuxAutoStartFile()); } catch (e) { return false; } }
  try { return !!(IS_MAC ? app.getLoginItemSettings() : app.getLoginItemSettings({ args: ['--hidden'] })).openAtLogin; } catch (e) { return false; }
}
function setAutoStart(on) {
  if (IS_LINUX) {
    try {
      const f = linuxAutoStartFile();
      if (on) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const exe = process.env.APPIMAGE || app.getPath('exe');
        fs.writeFileSync(f, '[Desktop Entry]\nType=Application\nName=AzurePet\nComment=Karakter 3D di desktop\nExec="' + exe + '" --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n');
      } else fs.rmSync(f, { force: true });
    } catch (e) {}
    return;
  }
  try { app.setLoginItemSettings(IS_MAC ? { openAtLogin: !!on } : { openAtLogin: !!on, args: ['--hidden'] }); } catch (e) {}
}

const CFG_FILE = path.join(app.getPath('userData'), 'config.json');
try { // bring over settings from the old name (DesktopPet)
  const oldCfg = path.join(app.getPath('appData'), 'DesktopPet', 'config.json');
  if (!fs.existsSync(CFG_FILE) && fs.existsSync(oldCfg)) { fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.copyFileSync(oldCfg, CFG_FILE); }
} catch (e) {}
const MAX_PETS = 12;
const PET_DEFAULTS = { modelPath: '', size: 280, speed: 90, mode: 'bottom', yaw: 0, autoWalk: true, anims: { idle: '', walk: '', drag: '', click: '' }, animsSet: false };
let cfg = { onTop: true, nextId: 1, pets: [] };
try {
  const old = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  if (Array.isArray(old.pets)) cfg = Object.assign(cfg, old);
  else if (old.modelPath) { // migrate v1 (single character) config
    cfg.onTop = old.onTop !== false;
    cfg.pets = [Object.assign({}, PET_DEFAULTS, { id: 1, modelPath: old.modelPath, size: old.size, speed: old.speed, mode: old.mode, yaw: old.yaw, autoWalk: old.autoWalk, anims: old.anims || {}, animsSet: true })];
    cfg.nextId = 2;
  }
} catch (e) {}
cfg.pets = cfg.pets.map(p => Object.assign({}, PET_DEFAULTS, p, { anims: Object.assign({ idle: '', walk: '', drag: '', click: '' }, p.anims) }));
cfg.pets = cfg.pets.filter(p => p.modelPath && !/[\\/]resources[\\/]app[\\/]sample\.glb$/i.test(p.modelPath) && !/AzurePet-source[\\/]sample\.glb$/i.test(p.modelPath)); // built-in sample model no longer exists
function saveCfg() { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {} }

let settings = null, tray = null, quitting = false, allVisible = true;
const pets = new Map(); // id -> runtime { c, win, ready, animList, status, state, dir, pos, target, vy, idleUntil, dragOff }

// ---------- Linux: decide when clicks go through the character window ----------
let hoverTimer = null;
function startHoverPoll() {
  if (!IS_LINUX) return;
  hoverTimer = setInterval(() => {
    if (!allVisible || !pets.size) return;
    const c = screen.getCursorScreenPoint();
    for (const r of pets.values()) {
      if (!alive(r) || !r.ready || r.state === 'drag') continue;
      const b = r.win.getBounds();
      const hb = r.hb || { x: 0.12, y: 0.06, w: 0.76, h: 0.92 };
      const x0 = b.x + hb.x * b.width, y0 = b.y + hb.y * b.height;
      const x1 = x0 + hb.w * b.width, y1 = y0 + hb.h * b.height;
      const inside = c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1;
      if (inside !== r.hoverOn) { r.hoverOn = inside; r.win.setIgnoreMouseEvents(!inside); }
    }
  }, 100);
}

// ---------- movement ----------
function workArea(r) {
  const s = r.c.size;
  return screen.getDisplayNearestPoint({ x: Math.round(r.pos.x + s / 2), y: Math.round(r.pos.y + s / 2) }).workArea;
}
function groundY(r, wa) { return wa.y + wa.height - r.c.size; }
function alive(r) { return r.win && !r.win.isDestroyed(); }
function sendState(r) {
  if (!alive(r) || !r.ready) return;
  const st = r.state === 'fall' ? 'drag' : r.state === 'act' ? 'click' : r.state;
  r.win.webContents.send('state', { state: st, dir: r.dir });
}
function setState(r, s) { if (s !== r.state) { r.state = s; sendState(r); } }
function applyPos(r) {
  if (!alive(r)) return;
  const x = Math.round(r.pos.x), y = Math.round(r.pos.y), s = r.c.size;
  if (r.box && r.box.x === x && r.box.y === y && r.box.s === s) return; // skip redundant window moves
  r.box = { x, y, s };
  r.win.setBounds({ x, y, width: s, height: s });
}
function endAct(r) {
  const wa = workArea(r), g = groundY(r, wa);
  if (r.c.mode !== 'free' && r.pos.y < g - 1) { r.vy = 0; setState(r, 'fall'); } // left up in the air (free area / after a drag): drop down
  else goIdle(r);
}
function goIdle(r) { setState(r, 'idle'); r.idleUntil = Date.now() + 2000 + Math.random() * 5000; }
function pickTarget(r) {
  const wa = workArea(r), s = r.c.size;
  const minX = wa.x, maxX = wa.x + wa.width - s;
  let tx = minX + Math.random() * Math.max(1, maxX - minX);
  const ty = r.c.mode === 'free' ? wa.y + Math.random() * Math.max(1, wa.height - s) : groundY(r, wa);
  if (Math.abs(tx - r.pos.x) < 60) tx = r.pos.x < (minX + maxX) / 2 ? Math.min(maxX, r.pos.x + 300) : Math.max(minX, r.pos.x - 300);
  r.target = { x: tx, y: ty };
  r.dir = tx >= r.pos.x ? 1 : -1;
  r.state = 'walk'; sendState(r);
}
let lastT = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.06, (now - lastT) / 1000); lastT = now;
  if (!allVisible || !pets.size) return;
  let cursor = null;
  for (const r of pets.values()) {
    if (!alive(r) || !r.ready) continue;
    if (r.state === 'drag') {
      cursor = cursor || screen.getCursorScreenPoint();
      r.pos.x = cursor.x - r.dragOff.x; r.pos.y = cursor.y - r.dragOff.y; applyPos(r); continue;
    }
    if (r.state === 'act') { if (now > r.actUntil) endAct(r); continue; }
    const wa = workArea(r), g = groundY(r, wa);
    if (r.state === 'fall') {
      r.vy += 2600 * dt; r.pos.y += r.vy * dt;
      if (r.pos.y >= g) { r.pos.y = g; applyPos(r); goIdle(r); continue; }
      applyPos(r); continue;
    }
    if (r.state === 'idle') {
      if (r.c.mode !== 'free' && Math.abs(r.pos.y - g) > 1) { r.pos.y = g; applyPos(r); }
      if (r.c.autoWalk && now > r.idleUntil) pickTarget(r);
      continue;
    }
    if (r.state === 'walk') {
      if (!r.c.autoWalk || !r.target) { goIdle(r); continue; }
      const dx = r.target.x - r.pos.x, dy = r.target.y - r.pos.y, dist = Math.hypot(dx, dy), step = r.c.speed * dt;
      if (dist <= step) {
        r.pos.x = r.target.x; r.pos.y = r.target.y; applyPos(r);
        goIdle(r);
        continue;
      }
      r.pos.x += dx / dist * step; r.pos.y += dy / dist * step; applyPos(r);
    }
  }
}

// ---------- pets ----------
function createPet(c) {
  const wa = screen.getPrimaryDisplay().workArea;
  const r = {
    c, win: null, ready: false, animList: [], status: { ok: false, msg: 'Memuat model...' },
    state: 'idle', dir: 1, target: null, vy: 0, idleUntil: Date.now() + 1500 + Math.random() * 3000, dragOff: { x: 0, y: 0 },
    pos: { x: wa.x + Math.random() * Math.max(1, wa.width - c.size), y: wa.y + wa.height - c.size }
  };
  r.win = new BrowserWindow({
    x: Math.round(r.pos.x), y: Math.round(r.pos.y), width: c.size, height: c.size,
    transparent: true, frame: false, resizable: false, hasShadow: false, skipTaskbar: true,
    alwaysOnTop: cfg.onTop, show: false, maximizable: false, minimizable: false, fullscreenable: false,
    backgroundColor: '#00000000', icon: path.join(__dirname, 'icon.png'), acceptFirstMouse: true, focusable: !IS_LINUX, // Linux: never steal focus, so the first click already lands on the character
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  if (cfg.onTop) r.win.setAlwaysOnTop(true, 'screen-saver');
  r.win.setMenu(null);
  if (IS_MAC) macOverlay(r);
  r.win.loadFile(path.join(__dirname, 'pet.html'));
  r.win.webContents.on('did-finish-load', () => loadModel(r));
  r.win.on('close', (e) => { if (!quitting && pets.has(c.id)) e.preventDefault(); }); // only removable from the app
  pets.set(c.id, r);
  return r;
}
function loadModel(r) {
  if (!alive(r)) return;
  r.ready = false; r.animList = []; r.durs = {};
  if (!r.c.modelPath || !fs.existsSync(r.c.modelPath)) {
    r.status = { ok: false, msg: 'Gagal: file tidak ditemukan (' + r.c.modelPath + ')' }; r.win.hide(); pushSettings(); return;
  }
  r.status = { ok: false, msg: 'Memuat model...' }; pushSettings();
  fs.readFile(r.c.modelPath, (err, buf) => {
    if (!alive(r)) return;
    if (err) { r.status = { ok: false, msg: 'Gagal membaca file: ' + err.message }; pushSettings(); return; }
    r.win.webContents.send('load-model', { data: buf, cfg: r.c });
  });
}
function addPet(modelPath) {
  if (cfg.pets.length >= MAX_PETS) {
    dialog.showMessageBox(settings, { type: 'info', message: 'Maksimal ' + MAX_PETS + ' karakter sekaligus.' }); return null;
  }
  const c = Object.assign({}, PET_DEFAULTS, { id: cfg.nextId++, modelPath, anims: { idle: '', walk: '', drag: '', click: '' } });
  // reuse the animation choice of another character that uses the same file
  const twin = cfg.pets.find(p => p.modelPath === modelPath && p.animsSet);
  if (twin) { c.anims = Object.assign({}, twin.anims); c.animsSet = true; c.yaw = twin.yaw; c.size = twin.size; }
  cfg.pets.push(c); saveCfg();
  createPet(c);
  if (settings && !settings.isDestroyed()) settings.webContents.send('select', c.id);
  pushSettings();
  return c;
}
function removePet(id) {
  const r = pets.get(id);
  pets.delete(id);
  cfg.pets = cfg.pets.filter(p => p.id !== id); saveCfg();
  if (r && alive(r)) r.win.destroy();
  pushSettings();
}
function byEvent(e) { for (const r of pets.values()) if (alive(r) && r.win.webContents === e.sender) return r; return null; }
function guess(names, re) { return names.find(n => re.test(n)) || ''; }

// ---------- settings window / tray ----------
function createSettings(selectId) {
  if (settings && !settings.isDestroyed()) {
    settings.show(); settings.focus();
    if (typeof selectId === 'number') settings.webContents.send('select', selectId);
    return;
  }
  settings = new BrowserWindow({
    width: 460, height: 890, resizable: false, maximizable: false, title: 'AzurePet - Pengaturan', backgroundColor: '#ffe6ee',
    icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, useContentSize: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  const h = screen.getPrimaryDisplay().workAreaSize.height;
  if (h < 950) { settings.setContentSize(460, Math.max(480, h - 80)); settings.center(); }
  settings.setMenu(null);
  settings.loadFile(path.join(__dirname, 'settings.html'));
  settings.on('close', (e) => { if (!quitting) { e.preventDefault(); settings.hide(); } });
}
function pushSettings() {
  if (!settings || settings.isDestroyed()) return;
  settings.webContents.send('data', {
    onTop: cfg.onTop, allVisible, max: MAX_PETS, autoStart: getAutoStart(), platform: process.platform,
    pets: cfg.pets.map(c => {
      const r = pets.get(c.id) || {};
      return { id: c.id, name: path.basename(c.modelPath), cfg: c, animList: r.animList || [], status: r.status || { ok: false, msg: '' } };
    })
  });
}
function setAllVisible(v) {
  allVisible = v;
  for (const r of pets.values()) { if (!alive(r)) continue; if (v && r.ready) r.win.showInactive(); else if (!v) r.win.hide(); }
  pushSettings(); buildTray();
}
function buildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Pengaturan', click: () => createSettings() },
    { label: allVisible ? 'Sembunyikan semua karakter' : 'Tampilkan semua karakter', click: () => setAllVisible(!allVisible) },
    { type: 'separator' },
    { label: 'Keluar', click: quit }
  ]));
}
// macOS: keep the character window above everything, including fullscreen apps
function macOverlay(r) {
  if (!IS_MAC || !alive(r)) return;
  try {
    r.win.setAlwaysOnTop(cfg.onTop, 'screen-saver', 1);
    r.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch (e) {}
}
function quit() { quitting = true; app.quit(); }
async function chooseFile() {
  const r = await dialog.showOpenDialog(settings, { title: 'Pilih model 3D (.glb)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Model 3D', extensions: ['glb', 'gltf'] }] });
  return r.canceled ? [] : r.filePaths;
}

// ---------- ipc from characters ----------
ipcMain.on('model-loaded', (e, names, durs) => {
  const r = byEvent(e); if (!r) return;
  r.animList = names; r.durs = durs || {}; r.ready = true;
  const a = r.c.anims, ok = n => n === '' || names.includes(n);
  if (!r.c.animsSet || !ok(a.idle) || !ok(a.walk) || !ok(a.drag) || !ok(a.click)) {
    a.idle = guess(names, /idle|stand|breath|wait/i) || names[0] || '';
    a.walk = guess(names, /walk/i) || guess(names, /run|move|jog/i) || a.idle;
    a.drag = guess(names, /drag|hang|grab|fall|float|jump|carry/i) || a.idle;
    a.click = guess(names, /click|poke|wave|greet|hello|dance|attack|hit|jump/i) || '';
    r.c.animsSet = true;
  }
  saveCfg();
  r.status = { ok: true, msg: names.length + ' animasi' };
  r.win.webContents.send('config', r.c);
  r.state = 'idle'; sendState(r);
  if (allVisible) r.win.showInactive();
  if (IS_MAC) macOverlay(r);
  pushSettings();
});
ipcMain.on('model-error', (e, msg) => { const r = byEvent(e); if (!r) return; r.status = { ok: false, msg: 'Gagal memuat model: ' + msg }; pushSettings(); });
ipcMain.on('hitbox', (e, box) => { const r = byEvent(e); if (r) r.hb = box; });
ipcMain.on('hover', (e, over) => {
  const r = byEvent(e); if (!r || r.state === 'drag') return;
  if (IS_LINUX) { r.onModel = over; return; } // Linux: main process decides when clicks pass through
  r.win.setIgnoreMouseEvents(!over, { forward: true });
});
ipcMain.on('drag-start', (e, off) => {
  const r = byEvent(e); if (!r) return;
  const c = screen.getCursorScreenPoint();
  r.actUntil = 0;
  r.dragOff = (off && isFinite(off.x) && isFinite(off.y)) ? { x: off.x, y: off.y } : { x: c.x - r.pos.x, y: c.y - r.pos.y };
  r.win.setIgnoreMouseEvents(false);
  r.win.moveTop();
  setState(r, 'drag');
});
ipcMain.on('drag-end', (e) => {
  const r = byEvent(e); if (!r || r.state !== 'drag') return;
  const wa = workArea(r), s = r.c.size, g = groundY(r, wa);
  r.pos.x = Math.max(wa.x - s / 2, Math.min(r.pos.x, wa.x + wa.width - s / 2));
  if (r.c.mode !== 'free' && r.pos.y < g - 2) { r.vy = 0; r.state = 'fall'; }
  else { if (r.pos.y > g) r.pos.y = g; applyPos(r); goIdle(r); }
});
ipcMain.on('pet-click', (e) => {
  const r = byEvent(e); if (!r) return;
  if (r.state === 'drag') { // a tap, not a drag: keep it inside the screen and react
    const wa = workArea(r), s = r.c.size;
    r.pos.x = Math.max(wa.x - s / 2, Math.min(r.pos.x, wa.x + wa.width - s / 2));
    applyPos(r);
  }
  if (r.c.anims && r.c.anims.click) {
    const dur = (r.durs && r.durs[r.c.anims.click]) || 0; // real clip length, so long animations are never cut
    r.state = 'act'; r.actUntil = Date.now() + (dur > 0 ? dur * 1000 + 800 : 4000);
    sendState(r);
  }
  else endAct(r);
});
ipcMain.on('click-done', (e) => { const r = byEvent(e); if (r && r.state === 'act') endAct(r); });
ipcMain.on('pet-menu', (e) => {
  const r = byEvent(e); if (!r) return;
  Menu.buildFromTemplate([
    { label: 'Atur karakter ini', click: () => createSettings(r.c.id) },
    { label: 'Hapus karakter ini', click: () => removePet(r.c.id) },
    { type: 'separator' },
    { label: 'Sembunyikan semua karakter', click: () => setAllVisible(false) },
    { label: 'Keluar', click: quit }
  ]).popup({ window: r.win });
});

// ---------- ipc from settings ----------
ipcMain.on('settings-ready', pushSettings);
ipcMain.on('add-pet', async () => { for (const f of await chooseFile()) addPet(f); });
ipcMain.on('drop-models', (e, files) => { files.filter(p => /\.(glb|gltf)$/i.test(p)).forEach(p => addPet(p)); });
ipcMain.on('duplicate-pet', (e, id) => { const r = pets.get(id); if (r) { const c = addPet(r.c.modelPath); if (c) { Object.assign(c, { size: r.c.size, speed: r.c.speed, mode: r.c.mode, yaw: r.c.yaw, autoWalk: r.c.autoWalk, anims: Object.assign({}, r.c.anims), animsSet: true }); saveCfg(); const n = pets.get(c.id); n.pos.y = screen.getPrimaryDisplay().workArea.y + screen.getPrimaryDisplay().workArea.height - c.size; applyPos(n); pushSettings(); } } });
ipcMain.on('remove-pet', (e, id) => removePet(id));
ipcMain.on('change-model', async (e, id) => {
  const r = pets.get(id); if (!r) return;
  const f = (await chooseFile())[0]; if (!f) return;
  r.c.modelPath = f; r.c.animsSet = false; r.c.anims = { idle: '', walk: '', drag: '', click: '' }; saveCfg(); loadModel(r);
});
ipcMain.on('set-config', (e, { id, patch }) => {
  const r = pets.get(id); if (!r) return;
  const c = r.c, oldSize = c.size;
  if (patch.anims) { Object.assign(c.anims, patch.anims); c.animsSet = true; delete patch.anims; }
  Object.assign(c, patch);
  c.size = Math.round(Math.max(80, Math.min(900, c.size)));
  saveCfg();
  if (alive(r)) {
    if (c.size !== oldSize) { r.pos.y += oldSize - c.size; r.pos.x += (oldSize - c.size) / 2; applyPos(r); }
    if ('mode' in patch || 'autoWalk' in patch) { r.target = null; if (r.state === 'walk') goIdle(r); }
    r.win.webContents.send('config', c);
  }
});
ipcMain.on('set-global', (e, patch) => {
  if ('onTop' in patch) { cfg.onTop = !!patch.onTop; saveCfg(); for (const r of pets.values()) if (alive(r)) r.win.setAlwaysOnTop(cfg.onTop, 'screen-saver'); }
});
ipcMain.on('set-autostart', (e, on) => { setAutoStart(!!on); pushSettings(); });
ipcMain.on('toggle-all', () => setAllVisible(!allVisible));
ipcMain.on('quit', quit);
ipcMain.on('log', (e, m) => console.log('[renderer]', m));

// ---------- macOS: install itself permanently (run from the DMG once -> lives in Applications) ----------
function macBundlePath() {
  const exe = app.getPath('exe');
  const i = exe.indexOf('/Contents/MacOS/');
  return i < 0 ? '' : exe.slice(0, i + 4);
}
function macInstallLog(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'install.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {}
}
function macVerAt(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')).version || ''; } catch (e) { return ''; }
}
function macPkgVer() {
  try { return require('./package.json').version || ''; } catch (e) { return ''; }
}
// open the installed copy through LaunchServices after this process is gone
function macRelaunchFrom(dest) {
  const cp = require('child_process');
  try {
    const sh = path.join(require('os').tmpdir(), 'azurepet-open-' + Date.now() + '.sh');
    fs.writeFileSync(sh, '#!/bin/sh\nsleep 1\n/usr/bin/open -n "$1"\nrm -f "$0"\n', { mode: 0o700 });
    const child = cp.spawn('/bin/sh', [sh, dest], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) { macInstallLog('gagal membuka ulang: ' + e.message); return false; }
}
function macInstallIfNeeded() {
  if (!IS_MAC) return false;
  const src = macBundlePath();
  if (!src || !src.startsWith('/Volumes/')) return false; // already running from a real folder
  const exeName = path.basename(app.getPath('exe'));
  const name = path.basename(src) || 'AzurePet.app';
  const cp = require('child_process');
  const dirs = ['/Applications', app.getPath('home') + '/Applications'];
  const ver = macPkgVer();
  for (const dir of dirs) {
    const dest = path.join(dir, name);
    const target = path.join(dest, 'Contents', 'MacOS', exeName);
    try {
      if (fs.existsSync(target) && macVerAt(dest) === ver) { // already installed, same version
        macInstallLog('sudah terpasang di ' + dest);
        if (macRelaunchFrom(dest)) { quitting = true; setTimeout(() => app.quit(), 400); return true; }
        return false;
      }
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      cp.execFileSync('/usr/bin/ditto', [src, dest], { timeout: 300000 });
      try { cp.execFileSync('/usr/bin/xattr', ['-cr', dest], { timeout: 120000 }); } catch (e) {} // drop the "downloaded" flag on the copy
      if (!fs.existsSync(target)) throw new Error('salinan tidak lengkap: ' + target);
      macInstallLog('terpasang di ' + dest + ' (v' + ver + ')');
      if (macRelaunchFrom(dest)) { quitting = true; setTimeout(() => app.quit(), 400); return true; }
      return false;
    } catch (e) { macInstallLog('gagal menyalin ke ' + dest + ': ' + e.message); }
  }
  macInstallLog('tidak bisa memasang otomatis, jalan dari ' + src);
  return false;
}

app.on('second-instance', () => createSettings());
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (hoverTimer) clearInterval(hoverTimer); });
app.on('activate', () => { if (app.isReady()) createSettings(); }); // macOS: click on the Dock icon
app.whenReady().then(() => {
  if (macInstallIfNeeded()) return; // relaunching itself from Applications
  cfg.pets.forEach(createPet);
  if (!START_HIDDEN || !cfg.pets.length) createSettings();
  try {
    let trayImg = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    if (IS_MAC) trayImg = trayImg.resize({ width: 18, height: 18 });
    tray = new Tray(trayImg);
    tray.setToolTip('AzurePet');
    if (!IS_MAC) tray.on('click', () => createSettings());
    buildTray();
  } catch (e) {}
  startHoverPoll();
  setInterval(tick, 32);
  setInterval(() => {
    if (!allVisible) return;
    for (const r of pets.values()) {
      if (!alive(r) || !r.ready || r.state === 'drag') continue;
      if (IS_MAC) macOverlay(r);
      else if (cfg.onTop) r.win.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 4000);
});
