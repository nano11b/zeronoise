const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, session, shell, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const nav = require('./nav');
const mediaAccess = require('./mediaAccess');
const { decideUpdate } = require('./updateCheck');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const shared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const SITE = process.env.CAMCHAT_URL || shared.siteUrl;
const SITE_ORIGIN = new URL(SITE).origin;
const NONCE_FILE = () => path.join(app.getPath('userData'), 'oauth-verifier.json');
const BOUNDS_FILE = () => path.join(app.getPath('userData'), 'window.json');

let win = null;
let pendingAuth = null;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); } catch { /* ignore */ }
}

function rememberVerifier(verifier, challenge) {
  writeJson(NONCE_FILE(), { verifier, challenge, exp: Date.now() + 10 * 60 * 1000 });
}
function takeVerifier(challenge) {
  const row = readJson(NONCE_FILE());
  if (!row) return null;
  if (row.exp < Date.now()) {
    try { fs.unlinkSync(NONCE_FILE()); } catch { /* already gone */ }
    return null;
  }
  if (row.challenge !== challenge || !row.verifier) return null;
  try { fs.unlinkSync(NONCE_FILE()); } catch { /* already gone */ }
  return row.verifier;
}

function loadBounds() {
  const b = readJson(BOUNDS_FILE());
  if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return { width: 1100, height: 760 };
  return { x: b.x, y: b.y, width: Math.max(360, b.width), height: Math.max(480, b.height) };
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  writeJson(BOUNDS_FILE(), { x: b.x, y: b.y, width: b.width, height: b.height });
}

function openExternal(url) {
  shell.openExternal(url).catch((err) => console.warn('openExternal', err));
}

function startOAuth(raw) {
  const { verifier, challenge } = nav.newVerifier();
  rememberVerifier(verifier, challenge);
  openExternal(nav.withNativeChallenge(raw, challenge));
}

function adoptAuth(raw) {
  const parsed = nav.parseAuthCallback(raw);
  if (!parsed || !win || win.isDestroyed()) return;
  const verifier = takeVerifier(parsed.challenge);
  if (!verifier) return;
  if (parsed.error) win.loadURL(nav.authErrorPage(SITE, parsed.error));
  else if (parsed.token) win.loadURL(nav.handoffPage(SITE, parsed.token, verifier));
}

function findAuthArg(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith('camchat:'));
}

function createWindow() {
  const icon = path.join(__dirname, '..', 'assets', 'icon.png');
  win = new BrowserWindow({
    ...loadBounds(),
    minWidth: 360,
    minHeight: 480,
    title: shared.appName,
    backgroundColor: '#030605',
    autoHideMenuBar: false,
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.on('close', saveBounds);
  win.webContents.setWindowOpenHandler(({ url }) => {
    const kind = nav.classifyNavigation(url, SITE_ORIGIN);
    if (kind.action === 'oauth') startOAuth(url);
    else if (kind.action === 'external') openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const kind = nav.classifyNavigation(url, SITE_ORIGIN);
    if (kind.action === 'inapp') return;
    event.preventDefault();
    if (kind.action === 'oauth') startOAuth(url);
    else if (kind.action === 'external') openExternal(url);
    else if (kind.action === 'auth') adoptAuth(url);
  });
  win.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (url.startsWith('file:')) return;
    win.loadFile(path.join(__dirname, 'offline.html'));
  });
  win.loadURL(SITE);
  if (pendingAuth) { const url = pendingAuth; pendingAuth = null; adoptAuth(url); }
}

let recentPick = null;

function pickSource(sources) {
  if (recentPick && Date.now() - recentPick.at < 8000) {
    const again = sources.find((s) => s.id === recentPick.id);
    if (again) return Promise.resolve(again);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (source) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('picker:choose', onChoose);
      ipcMain.removeListener('picker:cancel', onCancel);
      if (!picker.isDestroyed()) picker.close();
      resolve(source);
    };
    const picker = new BrowserWindow({
      width: 820,
      height: 600,
      parent: win || undefined,
      modal: !!win,
      title: 'Share your screen',
      backgroundColor: '#030605',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const payload = sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'Entire screen' : 'Window',
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    }));
    const onChoose = (event, id) => {
      if (event.sender !== picker.webContents) return;
      finish(sources.find((s) => s.id === id) || null);
    };
    const onCancel = (event) => {
      if (event.sender !== picker.webContents) return;
      finish(null);
    };
    ipcMain.on('picker:choose', onChoose);
    ipcMain.on('picker:cancel', onCancel);
    picker.webContents.once('did-finish-load', () => {
      if (!picker.isDestroyed()) picker.webContents.send('picker:sources', payload);
    });
    picker.on('closed', () => finish(null));
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

function nsisInstalled() {
  try { return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall zeronoise.exe')); } catch { return false; }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    const req = lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(new URL(res.headers.location, url).href, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`download ${res.statusCode}`)); return; }
      const hash = createHash('sha256');
      let size = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => { hash.update(chunk); size += chunk.length; });
      res.pipe(out);
      out.on('finish', () => resolve({ sha256: hash.digest('hex'), size }));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function checkForAppUpdate() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  let body;
  try {
    const res = await fetch(`${SITE_ORIGIN}/api/updates`, { cache: 'no-store' });
    if (!res.ok) return;
    body = await res.json();
  } catch { return; }
  const rel = body && body.windows;
  if (!rel || !rel.version || !rel.url || !rel.sha256) return;
  const decision = decideUpdate({
    current: app.getVersion(),
    latest: rel.version,
    minVersion: rel.minVersion,
    canApply: nsisInstalled(),
  });
  if (decision === 'current') return;
  const parent = win && !win.isDestroyed() ? win : undefined;
  if (decision === 'manual') {
    const choice = await dialog.showMessageBox(parent, {
      type: 'info',
      title: shared.appName,
      message: 'A newer zeronoise is on the site.',
      detail: 'This copy is the portable zip, so it cannot replace itself. Download the installer once. After that, updates ask you to restart.',
      buttons: ['Open the download page', 'Later'],
    });
    if (choice.response === 0) shell.openExternal(`${SITE_ORIGIN}/download`);
    return;
  }
  const choice = await dialog.showMessageBox(parent, {
    type: 'info',
    title: shared.appName,
    message: `Update available (${rel.version})`,
    detail: rel.notes || 'The installer will open after the download is checked.',
    buttons: ['Download and install', 'Later'],
  });
  if (choice.response !== 0) return;
  const dest = path.join(app.getPath('temp'), `zeronoise-${rel.version}-setup.exe`);
  let got;
  try { got = await downloadFile(rel.url, dest); } catch { got = null; }
  if (!got || got.sha256 !== rel.sha256 || (rel.size && got.size !== rel.size)) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    dialog.showMessageBox(parent, {
      type: 'warning',
      title: shared.appName,
      message: 'The update did not match the published checksum.',
      detail: 'It was not installed.',
      buttons: ['OK'],
    }).catch(() => {});
    return;
  }
  spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

function warnIfWindowsMediaBlocked() {
  if (process.platform !== 'win32') return;
  let camera = 'unknown';
  let microphone = 'unknown';
  try {
    camera = systemPreferences.getMediaAccessStatus('camera');
    microphone = systemPreferences.getMediaAccessStatus('microphone');
  } catch { return; }
  const block = mediaAccess.windowsMediaBlock(camera, microphone);
  if (!block) return;
  dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    title: shared.appName,
    message: block.message,
    detail: block.detail,
    buttons: ['OK'],
  }).catch(() => {});
}

function installSession() {
  const ses = session.defaultSession;
  const ua = ses.getUserAgent();
  if (!ua.includes(shared.userAgentSuffix)) ses.setUserAgent(`${ua} ${shared.userAgentSuffix}`);
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    return mediaAccess.decidePermissionCheck(permission, requestingOrigin, details, SITE_ORIGIN);
  });
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(mediaAccess.decidePermissionRequest(permission, details, SITE_ORIGIN));
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 360, height: 200 },
        fetchWindowIcons: false,
      });
      const source = await pickSource(sources);
      if (!source) { callback({}); return; }
      recentPick = { id: source.id, at: Date.now() };
      const streams = { video: { id: source.id, name: source.name } };
      if (request.audioRequested) streams.audio = 'loopback';
      callback(streams);
    } catch (err) {
      console.warn('display media', err);
      callback({});
    }
  });
}

function installMenu() {
  const view = [
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  if (process.env.CAMCHAT_DEVTOOLS === '1') view.push({ type: 'separator' }, { role: 'toggleDevTools' });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: shared.appName, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: view },
  ]));
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = findAuthArg(argv);
    if (url) {
      if (win) adoptAuth(url);
      else pendingAuth = url;
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (win) adoptAuth(url);
    else pendingAuth = url;
  });
  app.whenReady().then(() => {
    if (process.defaultApp) app.setAsDefaultProtocolClient(shared.scheme, process.execPath, [path.resolve(process.argv[1])]);
    else app.setAsDefaultProtocolClient(shared.scheme);
    installSession();
    installMenu();
    const initial = findAuthArg(process.argv);
    if (initial) pendingAuth = initial;
    createWindow();
    warnIfWindowsMediaBlocked();
    setTimeout(() => { checkForAppUpdate().catch(() => {}); }, 4000);
    setInterval(() => { checkForAppUpdate().catch(() => {}); }, 6 * 60 * 60 * 1000);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); });
}
