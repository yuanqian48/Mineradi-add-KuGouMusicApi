const { app, BrowserWindow, ipcMain, shell, screen, session, globalShortcut, dialog } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const kugou = require('../kugou-core.js');

let mainWindow = null;
let localServer = null;
let mainServerPort = 0;
let desktopLyricsWindow = null;
let desktopLyricsState = {};
let desktopLyricsUserBounds = null;
let desktopLyricsProgrammaticMove = false;
let desktopLyricsPointerCapture = false;
let desktopLyricsMouseIgnored = null;
let desktopLyricsMousePoller = null;
let desktopLyricsMousePollerBuffer = '';
let desktopLyricsHotBounds = null;
let desktopLyricsLastMiddleAt = 0;
let wallpaperWindow = null;
let wallpaperState = {};
let htmlFullscreenActive = false;
let windowFullscreenActive = false;
let mainWindowStateTimer = null;
const registeredGlobalHotkeys = new Map();

const WINDOWED_ASPECT = 16 / 9;
const WINDOWED_SCALE = 3 / 4;
const WINDOWED_MARGIN = 32;
const MIN_WINDOWED_WIDTH = 960;
const MIN_WINDOWED_HEIGHT = 540;
const APP_NAME = 'Mineradio';
const APP_USER_MODEL_ID = 'com.mineradio.desktop';
const APP_ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const NETEASE_LOGIN_PARTITION = 'persist:mineradio-netease-login';
const NETEASE_LOGIN_URL = 'https://music.163.com/#/login';
const QQ_LOGIN_PARTITION = 'persist:mineradio-qqmusic-login';
const QQ_LOGIN_URL = 'https://y.qq.com/n/ryqq/profile';

const CHROMIUM_PERFORMANCE_SWITCHES = [
  ['autoplay-policy', 'no-user-gesture-required'],
  ['ignore-gpu-blocklist'],
  ['enable-gpu-rasterization'],
  ['enable-oop-rasterization'],
  ['enable-zero-copy'],
  ['enable-accelerated-2d-canvas'],
  ['disable-background-timer-throttling'],
  ['disable-renderer-backgrounding'],
  ['disable-backgrounding-occluded-windows'],
  ['force_high_performance_gpu'],
  ['use-angle', 'd3d11'],
];
for (const [name, value] of CHROMIUM_PERFORMANCE_SWITCHES) {
  if (value == null) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const QQ_LOGIN_COOKIE_PRIORITY = [
  'uin',
  'qqmusic_uin',
  'wxuin',
  'login_type',
  'qm_keyst',
  'qqmusic_key',
  'p_skey',
  'skey',
  'psrf_qqopenid',
  'psrf_qqunionid',
  'psrf_qqaccess_token',
  'psrf_qqrefresh_token',
  'wxopenid',
  'wxunionid',
  'wxrefresh_token',
  'wxskey',
  'p_uin',
  'ptcz',
  'RK',
];
const NETEASE_LOGIN_COOKIE_PRIORITY = [
  'MUSIC_U',
  '__csrf',
  'NMTID',
  'MUSIC_A',
  '__remember_me',
  '_ntes_nuid',
  '_ntes_nnid',
  'WEVNSM',
  'WNMCID',
  'JSESSIONID-WYYY',
];

function findOpenPort(startPort) {
  return new Promise((resolve, reject) => {
    function tryPort(port) {
      const tester = net.createServer();

      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          tryPort(port + 1);
          return;
        }
        reject(err);
      });

      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });

      tester.listen(port, '127.0.0.1');
    }

    tryPort(startPort);
  });
}

function waitForServer(server) {
  if (!server || server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function sendWindowState(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('desktop-window-state', getWindowState(win));
}

function sendGlobalHotkeyAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !action) return;
  mainWindow.webContents.send('mineradio-global-hotkey', { action });
}

function unregisterMineradioGlobalHotkeys() {
  for (const accelerator of registeredGlobalHotkeys.keys()) {
    try { globalShortcut.unregister(accelerator); } catch (e) {}
  }
  registeredGlobalHotkeys.clear();
}

function configureMineradioGlobalHotkeys(bindings = []) {
  unregisterMineradioGlobalHotkeys();
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(bindings) ? bindings : []) {
    const action = item && String(item.action || '').trim();
    const accelerator = item && String(item.accelerator || '').trim();
    if (!action || !accelerator || seen.has(accelerator)) continue;
    seen.add(accelerator);
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => sendGlobalHotkeyAction(action));
    } catch (error) {
      registered = false;
    }
    if (registered) {
      registeredGlobalHotkeys.set(accelerator, action);
      results.push({ action, accelerator, ok: true });
    } else {
      results.push({
        action,
        accelerator,
        ok: false,
        conflict: {
          sourceName: '系统 / 其他软件',
          sourceIcon: 'warning',
          reason: '该组合键已被占用或被系统保留',
        },
      });
    }
  }
  return { ok: true, results };
}

function scheduleWindowStateSend(win, delay = 80) {
  if (!win || win.isDestroyed()) return;
  if (mainWindowStateTimer) clearTimeout(mainWindowStateTimer);
  mainWindowStateTimer = setTimeout(() => {
    mainWindowStateTimer = null;
    sendWindowState(win);
  }, delay);
}

function rectsOverlapOnY(a, b) {
  if (!a || !b) return false;
  const aTop = Number(a.y) || 0;
  const bTop = Number(b.y) || 0;
  const aBottom = aTop + (Number(a.height) || 0);
  const bBottom = bTop + (Number(b.height) || 0);
  return aBottom > bTop && bBottom > aTop;
}

function getDisplayState(win) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : primary;
  const bounds = display && display.bounds ? display.bounds : primary.bounds;
  const displayId = display && display.id;
  const primaryId = primary && primary.id;
  const edgeTolerance = 2;
  const hasDisplayOnLeft = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((candidate.bounds.x + candidate.bounds.width) - bounds.x) <= edgeTolerance;
  });
  const hasDisplayOnRight = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((bounds.x + bounds.width) - candidate.bounds.x) <= edgeTolerance;
  });
  return {
    displayId,
    primaryDisplayId: primaryId,
    isPrimaryDisplay: !!(display && primary && display.id === primary.id),
    hasDisplayOnLeft,
    hasDisplayOnRight,
    displayBounds: bounds ? {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    } : null,
  };
}

function getWindowState(win) {
  if (!win || win.isDestroyed()) return {
    isMaximized: false,
    isNativeFullScreen: false,
    isHtmlFullScreen: false,
    isWindowFullScreen: false,
    isFullScreen: false,
    isMinimized: false,
    isVisible: false,
    isFocused: false,
    isPrimaryDisplay: true,
    hasDisplayOnLeft: false,
    hasDisplayOnRight: false,
    displayBounds: null,
  };
  return {
    isMaximized: win.isMaximized(),
    isNativeFullScreen: win.isFullScreen(),
    isHtmlFullScreen: htmlFullscreenActive,
    isWindowFullScreen: windowFullscreenActive,
    isFullScreen: win.isFullScreen() || htmlFullscreenActive || windowFullscreenActive,
    isMinimized: win.isMinimized(),
    isVisible: win.isVisible(),
    isFocused: win.isFocused(),
    ...getDisplayState(win),
  };
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  sendWindowState(mainWindow);
  return true;
}

function getUpdateDownloadDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function shouldEnsureDesktopShortcut() {
  if (process.platform !== 'win32') return false;
  if (process.env.MINERADIO_NO_DESKTOP_SHORTCUT === '1') return false;
  return app.isPackaged || process.env.MINERADIO_CREATE_DESKTOP_SHORTCUT === '1';
}

function ensureDesktopShortcut() {
  if (!shouldEnsureDesktopShortcut()) return { ok: false, skipped: true };
  try {
    const shortcutPath = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`);
    const target = process.execPath;
    const shortcut = {
      target,
      cwd: path.dirname(target),
      args: '',
      description: 'Mineradio desktop music player',
      icon: fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : target,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
    };

    if (fs.existsSync(shortcutPath) && shell.readShortcutLink) {
      try {
        const existing = shell.readShortcutLink(shortcutPath);
        if (existing && path.resolve(existing.target || '') === path.resolve(target) && String(existing.args || '') === '') {
          return { ok: true, path: shortcutPath, existing: true };
        }
      } catch (_) {}
      shell.writeShortcutLink(shortcutPath, 'replace', shortcut);
    } else {
      shell.writeShortcutLink(shortcutPath, 'create', shortcut);
    }
    return { ok: true, path: shortcutPath, created: true };
  } catch (e) {
    console.warn('Desktop shortcut creation skipped:', e.message);
    return { ok: false, error: e.message || 'DESKTOP_SHORTCUT_FAILED' };
  }
}

function parseCookieHeader(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach((part) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    out[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  });
  return out;
}

function qqCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const rawUin = Number(obj.login_type) === 2
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const musicKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
  return !!(uin && musicKey);
}

function qqCookieHasPlaybackLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const rawUin = Number(obj.login_type) === 2
    ? (obj.wxuin || obj.uin || obj.p_uin || '')
    : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const uin = String(rawUin).replace(/\D/g, '');
  const playbackKey = obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
  return !!(uin && playbackKey);
}

function neteaseCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  return !!obj.MUSIC_U;
}

function isQQCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'qq.com' || normalized.endsWith('.qq.com') || normalized.endsWith('qqmusic.qq.com');
}

function isNeteaseCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === '163.com' || normalized.endsWith('.163.com') ||
    normalized === 'music.163.com' || normalized.endsWith('.music.163.com') ||
    normalized === 'netease.com' || normalized.endsWith('.netease.com');
}

function buildCookieHeaderFor(cookies, isAllowedDomain, priority) {
  const picked = new Map();
  (cookies || []).forEach((cookie) => {
    if (!cookie || !cookie.name || !isAllowedDomain(cookie.domain)) return;
    picked.set(cookie.name, cookie.value || '');
  });

  const ordered = [];
  (priority || []).forEach((name) => {
    if (picked.has(name)) {
      ordered.push([name, picked.get(name)]);
      picked.delete(name);
    }
  });
  picked.forEach((value, name) => ordered.push([name, value]));

  return ordered
    .filter(([name, value]) => name && value != null && String(value) !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function buildCookieHeader(cookies) {
  return buildCookieHeaderFor(cookies, isQQCookieDomain, QQ_LOGIN_COOKIE_PRIORITY);
}

async function readQQLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeader(cookies);
}

async function readNeteaseLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isNeteaseCookieDomain, NETEASE_LOGIN_COOKIE_PRIORITY);
}

async function openNeteaseMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  const initialCookie = await readNeteaseLoginCookieHeader(cookieSession);
  if (neteaseCookieHasLogin(initialCookie)) return { ok: true, cookie: initialCookie, reused: true };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const loginWindow = new BrowserWindow({
      width: 940,
      height: 760,
      minWidth: 780,
      minHeight: 580,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: '网易云音乐登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: NETEASE_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        if (neteaseCookieHasLogin(cookie)) {
          finish({ ok: true, cookie });
        }
      } catch (e) {
        console.warn('Netease login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?(163|music\.163|netease)\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Netease login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const docs = [document];
          document.querySelectorAll('iframe').forEach((frame) => {
            try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) {}
          });
          for (const doc of docs) {
            const nodes = Array.from(doc.querySelectorAll('a, button, span, div'));
            const loginNode = nodes.find((node) => {
              const text = (node.textContent || '').trim();
              if (!/登录|立即登录/.test(text)) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            if (loginNode) { loginNode.click(); return true; }
          }
          return false;
        }, 900);
      `, true).catch(() => {});
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        resolve(neteaseCookieHasLogin(cookie)
          ? { ok: true, cookie, partial: !qqCookieHasPlaybackLogin(cookie) }
          : { ok: false, cancelled: true, message: '网易云登录窗口已关闭' });
      } catch (e) {
        resolve({ ok: false, error: e.message || '网易云登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(NETEASE_LOGIN_URL).catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function openQQMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  const initialCookie = await readQQLoginCookieHeader(cookieSession);
  if (qqCookieHasPlaybackLogin(initialCookie)) return { ok: true, cookie: initialCookie, reused: true };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let warmupStarted = false;

    const loginWindow = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: 'QQ 音乐登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: QQ_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        if (qqCookieHasPlaybackLogin(cookie)) {
          finish({ ok: true, cookie });
        } else if (qqCookieHasLogin(cookie) && !warmupStarted) {
          warmupStarted = true;
          setTimeout(() => {
            if (!settled && loginWindow && !loginWindow.isDestroyed()) {
              loginWindow.loadURL('https://y.qq.com/n/ryqq/player').catch((e) => console.warn('QQ login warmup navigation failed:', e.message));
            }
          }, 900);
        }
      } catch (e) {
        console.warn('QQ login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('QQ login popup navigation failed:', e.message));
      } else {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          const loginNode = nodes.find((node) => {
            const text = (node.textContent || '').trim();
            if (!/登录|登陆/.test(text)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (loginNode) loginNode.click();
        }, 700);
      `, true).catch(() => {});
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readQQLoginCookieHeader(cookieSession);
        resolve(qqCookieHasLogin(cookie)
          ? { ok: true, cookie }
          : { ok: false, cancelled: true, message: 'QQ 登录窗口已关闭' });
      } catch (e) {
        resolve({ ok: false, error: e.message || 'QQ 登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(QQ_LOGIN_URL).catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function clearQQMusicLoginSession() {
  const cookieSession = session.fromPartition(QQ_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

async function clearNeteaseMusicLoginSession() {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

function getWindowedBounds(win) {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const basis = display.bounds || area;
  const maxWidth = Math.max(640, area.width - WINDOWED_MARGIN);
  const maxHeight = Math.max(360, area.height - WINDOWED_MARGIN);

  let width = Math.round(basis.width * WINDOWED_SCALE);
  let height = Math.round(width / WINDOWED_ASPECT);
  const scaledHeight = Math.round(basis.height * WINDOWED_SCALE);

  if (height > scaledHeight) {
    height = scaledHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  if (width < MIN_WINDOWED_WIDTH && maxWidth >= MIN_WINDOWED_WIDTH && maxHeight >= MIN_WINDOWED_HEIGHT) {
    width = MIN_WINDOWED_WIDTH;
    height = MIN_WINDOWED_HEIGHT;
  }

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.round(width / WINDOWED_ASPECT);
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  width = Math.round(width);
  height = Math.round(height);

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function applyWindowedBounds(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  win.setMinimumSize(MIN_WINDOWED_WIDTH, MIN_WINDOWED_HEIGHT);
  win.setBounds(getWindowedBounds(win), false);
  sendWindowState(win);
}

function exitFullscreenToWindow(win) {
  if (!win || win.isDestroyed()) return;
  windowFullscreenActive = false;

  if (!win.isFullScreen()) {
    applyWindowedBounds(win);
    return;
  }

  let applied = false;
  const applyOnce = () => {
    if (applied || !win || win.isDestroyed() || win.isFullScreen()) return;
    applied = true;
    applyWindowedBounds(win);
  };

  win.once('leave-full-screen', () => setTimeout(applyOnce, 50));
  win.setFullScreen(false);
  setTimeout(applyOnce, 500);
}

function toggleFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen() || windowFullscreenActive) {
    exitFullscreenToWindow(win);
    return;
  }
  windowFullscreenActive = true;
  win.setFullScreen(true);
  sendWindowState(win);
}

function overlayUrl(page) {
  const port = mainServerPort || process.env.PORT || 3000;
  return `http://127.0.0.1:${port}/${page}`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function desktopLyricsDefaultBounds(payload = desktopLyricsState) {
  const display = desktopLyricsUserBounds
    ? screen.getDisplayMatching(desktopLyricsUserBounds)
    : screen.getPrimaryDisplay();
  const bounds = display.bounds;
  const yRatio = clampNumber(payload.y, 0.08, 0.92, 0.76);
  const width = Math.round(Math.min(Math.max(880, bounds.width * 0.72), bounds.width - 96));
  const height = Math.round(Math.min(Math.max(340, bounds.height * 0.38), 560, bounds.height - 96));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + bounds.height * yRatio - height / 2),
    width,
    height,
  };
}

function constrainDesktopLyricsBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.bounds;
  const next = {
    ...bounds,
    width: Math.round(Math.min(Math.max(320, bounds.width), area.width)),
    height: Math.round(Math.min(Math.max(180, bounds.height), area.height)),
  };
  const maxX = area.x + Math.max(0, area.width - next.width);
  const maxY = area.y + Math.max(0, area.height - next.height);
  next.x = Math.round(clampNumber(next.x, area.x, maxX, area.x));
  next.y = Math.round(clampNumber(next.y, area.y, maxY, area.y));
  return next;
}

function setDesktopLyricsBounds(bounds) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const nextBounds = constrainDesktopLyricsBounds(bounds);
  const currentBounds = desktopLyricsWindow.getBounds();
  if (
    currentBounds.x === nextBounds.x
    && currentBounds.y === nextBounds.y
    && currentBounds.width === nextBounds.width
    && currentBounds.height === nextBounds.height
  ) {
    return;
  }
  desktopLyricsProgrammaticMove = true;
  desktopLyricsWindow.setBounds(nextBounds, false);
  setTimeout(() => {
    desktopLyricsProgrammaticMove = false;
  }, 120);
}

function rememberDesktopLyricsBounds() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsProgrammaticMove) return;
  desktopLyricsUserBounds = desktopLyricsWindow.getBounds();
}

function applyDesktopLyricsMouseBehavior() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const locked = desktopLyricsState.clickThrough !== false;
  const shouldIgnore = locked || !desktopLyricsPointerCapture;
  if (desktopLyricsMouseIgnored === shouldIgnore) return;
  desktopLyricsMouseIgnored = shouldIgnore;
  desktopLyricsWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function desktopLyricsHotBoundsOnScreen() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return null;
  const winBounds = desktopLyricsWindow.getBounds();
  const rel = desktopLyricsHotBounds;
  if (!rel) return winBounds;
  return {
    x: winBounds.x + rel.left,
    y: winBounds.y + rel.top,
    width: Math.max(1, rel.right - rel.left),
    height: Math.max(1, rel.bottom - rel.top),
  };
}

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function handleDesktopLyricsGlobalMiddleClick() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  if (!desktopLyricsState.enabled) return;
  const now = Date.now();
  if (now - desktopLyricsLastMiddleAt < 260) return;
  const point = screen.getCursorScreenPoint();
  if (!pointInBounds(point, desktopLyricsHotBoundsOnScreen())) return;
  desktopLyricsLastMiddleAt = now;
  const nextLocked = desktopLyricsState.clickThrough === false;
  desktopLyricsState = { ...desktopLyricsState, clickThrough: nextLocked };
  desktopLyricsPointerCapture = !nextLocked;
  applyDesktopLyricsMouseBehavior();
  broadcastDesktopLyricsLockState();
}

function startDesktopLyricsMousePoller() {
  if (process.platform !== 'win32' || desktopLyricsMousePoller) return;
  const script = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioMousePoll {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$prev = $false
while ($true) {
  $down = (([MineradioMousePoll]::GetAsyncKeyState(4) -band 0x8000) -ne 0)
  if ($down -and -not $prev) {
    [Console]::Out.WriteLine("MMB")
    [Console]::Out.Flush()
  }
  $prev = $down
  Start-Sleep -Milliseconds 24
}
`;
  try {
    desktopLyricsMousePoller = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    desktopLyricsMousePoller.stdout.on('data', (chunk) => {
      desktopLyricsMousePollerBuffer += chunk.toString('utf8');
      const lines = desktopLyricsMousePollerBuffer.split(/\r?\n/);
      desktopLyricsMousePollerBuffer = lines.pop() || '';
      lines.forEach((line) => {
        if (line.trim() === 'MMB') handleDesktopLyricsGlobalMiddleClick();
      });
    });
    desktopLyricsMousePoller.on('exit', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
    desktopLyricsMousePoller.on('error', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
  } catch (e) {
    desktopLyricsMousePoller = null;
    desktopLyricsMousePollerBuffer = '';
  }
}

function stopDesktopLyricsMousePoller() {
  if (!desktopLyricsMousePoller) return;
  try {
    desktopLyricsMousePoller.kill();
  } catch (e) {}
  desktopLyricsMousePoller = null;
  desktopLyricsMousePollerBuffer = '';
}

function broadcastDesktopLyricsLockState() {
  const locked = desktopLyricsState.clickThrough !== false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-lock-state', { locked });
  }
  sendDesktopLyricsState();
}

function broadcastDesktopLyricsEnabledState(enabled) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-enabled-state', { enabled: !!enabled });
  }
}

function positionDesktopLyricsWindow(payload = desktopLyricsState, options = {}) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const shouldUseManualBounds = desktopLyricsUserBounds && !options.force;
  setDesktopLyricsBounds(shouldUseManualBounds ? desktopLyricsUserBounds : desktopLyricsDefaultBounds(payload));
  if (typeof desktopLyricsWindow.setOpacity === 'function') {
    desktopLyricsWindow.setOpacity(clampNumber(payload.opacity, 0.28, 1, 0.92));
  }
}

function sendDesktopLyricsState() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  desktopLyricsWindow.webContents.send('mineradio-desktop-lyrics-state', desktopLyricsState);
}

function createDesktopLyricsWindow(payload = {}) {
  const previousY = desktopLyricsState.y;
  const previousOpacity = desktopLyricsState.opacity;
  desktopLyricsState = { ...desktopLyricsState, ...payload, enabled: true };
  const hasY = Object.prototype.hasOwnProperty.call(payload || {}, 'y');
  const nextY = clampNumber(desktopLyricsState.y, 0.08, 0.92, 0.76);
  const yChanged = hasY && Number.isFinite(Number(previousY)) && Math.abs(nextY - clampNumber(previousY, 0.08, 0.92, 0.76)) > 0.001;
  const opacityChanged = Object.prototype.hasOwnProperty.call(payload || {}, 'opacity')
    && Math.abs(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92) - clampNumber(previousOpacity, 0.28, 1, 0.92)) > 0.001;
  if (yChanged) desktopLyricsUserBounds = null;
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    if (yChanged) {
      positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged });
    } else if (opacityChanged && typeof desktopLyricsWindow.setOpacity === 'function') {
      desktopLyricsWindow.setOpacity(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92));
    }
    applyDesktopLyricsMouseBehavior();
    sendDesktopLyricsState();
    return desktopLyricsWindow;
  }

  desktopLyricsWindow = new BrowserWindow({
    width: 920,
    height: 190,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Desktop Lyrics',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    desktopLyricsWindow.setAlwaysOnTop(true, 'screen-saver');
    desktopLyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    console.warn('Desktop lyrics topmost setup skipped:', e.message);
  }
  startDesktopLyricsMousePoller();
  applyDesktopLyricsMouseBehavior();
  positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged || !desktopLyricsUserBounds });
  desktopLyricsWindow.once('ready-to-show', () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
    desktopLyricsWindow.showInactive();
    sendDesktopLyricsState();
  });
  desktopLyricsWindow.webContents.once('did-finish-load', sendDesktopLyricsState);
  desktopLyricsWindow.on('closed', () => {
    desktopLyricsWindow = null;
    desktopLyricsMouseIgnored = null;
  });
  desktopLyricsWindow.on('moved', rememberDesktopLyricsBounds);
  desktopLyricsWindow.loadURL(overlayUrl('desktop-lyrics.html')).catch((e) => console.warn('Desktop lyrics load failed:', e.message));
  return desktopLyricsWindow;
}

function closeDesktopLyricsWindow() {
  desktopLyricsState = { ...desktopLyricsState, enabled: false };
  desktopLyricsPointerCapture = false;
  desktopLyricsMouseIgnored = null;
  desktopLyricsHotBounds = null;
  stopDesktopLyricsMousePoller();
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    sendDesktopLyricsState();
    desktopLyricsWindow.close();
  }
  desktopLyricsWindow = null;
  broadcastDesktopLyricsEnabledState(false);
}

function nativeWindowHandleDecimal(win) {
  const handle = win.getNativeWindowHandle();
  if (process.arch === 'x64') return handle.readBigUInt64LE(0).toString();
  return String(handle.readUInt32LE(0));
}

function attachWallpaperToWorkerW(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const hwnd = nativeWindowHandleDecimal(win);
  const script = `
$ErrorActionPreference = "Stop"
if (-not ("MineradioNativeWin" -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioNativeWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
"@
}
$progman = [MineradioNativeWin]::FindWindow("Progman", $null)
$result = [IntPtr]::Zero
[MineradioNativeWin]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result) | Out-Null
$script:workerw = [IntPtr]::Zero
$enum = [MineradioNativeWin+EnumWindowsProc]{
  param([IntPtr]$top, [IntPtr]$param)
  $shell = [MineradioNativeWin]::FindWindowEx($top, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
  if ($shell -ne [IntPtr]::Zero) {
    $script:workerw = [MineradioNativeWin]::FindWindowEx([IntPtr]::Zero, $top, "WorkerW", $null)
  }
  return $true
}
[MineradioNativeWin]::EnumWindows($enum, [IntPtr]::Zero) | Out-Null
if ($script:workerw -eq [IntPtr]::Zero) { $script:workerw = $progman }
$target = [IntPtr]::new([Int64]${hwnd})
[MineradioNativeWin]::SetParent($target, $script:workerw) | Out-Null
[MineradioNativeWin]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013) | Out-Null
`;
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 5000,
  }, (error) => {
    if (error) console.warn('Wallpaper WorkerW attach failed:', error.message);
  });
}

function positionWallpaperWindow() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow.setBounds(bounds, false);
}

function sendWallpaperState() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  wallpaperWindow.webContents.send('mineradio-wallpaper-state', wallpaperState);
}

function createWallpaperWindow(payload = {}) {
  wallpaperState = { ...wallpaperState, ...payload, enabled: true };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    positionWallpaperWindow();
    sendWallpaperState();
    return wallpaperWindow;
  }
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#050608',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Wallpaper',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  wallpaperWindow.setIgnoreMouseEvents(true, { forward: true });
  wallpaperWindow.once('ready-to-show', () => {
    if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
    positionWallpaperWindow();
    wallpaperWindow.showInactive();
    attachWallpaperToWorkerW(wallpaperWindow);
    sendWallpaperState();
  });
  wallpaperWindow.webContents.once('did-finish-load', sendWallpaperState);
  wallpaperWindow.on('closed', () => {
    wallpaperWindow = null;
  });
  wallpaperWindow.loadURL(overlayUrl('wallpaper.html')).catch((e) => console.warn('Wallpaper load failed:', e.message));
  return wallpaperWindow;
}

function closeWallpaperWindow() {
  wallpaperState = { ...wallpaperState, enabled: false };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    sendWallpaperState();
    wallpaperWindow.close();
  }
  wallpaperWindow = null;
}

function closeOverlayWindows() {
  closeDesktopLyricsWindow();
  closeWallpaperWindow();
}

ipcMain.handle('desktop-window-minimize', (event) => {
  getSenderWindow(event)?.minimize();
});

ipcMain.handle('desktop-window-toggle-maximize', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-toggle-fullscreen', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-exit-fullscreen-windowed', (event) => {
  exitFullscreenToWindow(getSenderWindow(event));
});

ipcMain.handle('desktop-window-get-state', (event) => {
  return getWindowState(getSenderWindow(event));
});

ipcMain.handle('desktop-window-close', (event) => {
  getSenderWindow(event)?.close();
});

ipcMain.handle('mineradio-hotkeys-configure-global', (_event, bindings) => {
  return configureMineradioGlobalHotkeys(bindings);
});

ipcMain.handle('mineradio-export-json-file', async (event, payload = {}) => {
  try {
    const owner = getSenderWindow(event);
    const defaultName = String(payload.defaultName || 'mineradio-export.json').replace(/[\\/:*?"<>|]+/g, '-');
    const result = await dialog.showSaveDialog(owner, {
      title: '导出 Mineradio 存档',
      defaultPath: defaultName.toLowerCase().endsWith('.json') ? defaultName : `${defaultName}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload.data || {}, null, 2);
    fs.writeFileSync(result.filePath, text, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message || 'EXPORT_FAILED' };
  }
});

ipcMain.handle('mineradio-import-json-file', async (event) => {
  try {
    const owner = getSenderWindow(event);
    const result = await dialog.showOpenDialog(owner, {
      title: '导入 Mineradio 存档',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, filePath, text };
  } catch (e) {
    return { ok: false, error: e.message || 'IMPORT_FAILED' };
  }
});

ipcMain.handle('netease-music-open-login', async (event) => {
  return openNeteaseMusicLoginWindow(getSenderWindow(event));
});

ipcMain.handle('netease-music-clear-login', async () => {
  return clearNeteaseMusicLoginSession();
});

ipcMain.handle('qq-music-open-login', async (event) => {
  return openQQMusicLoginWindow(getSenderWindow(event));
});

ipcMain.handle('qq-music-clear-login', async () => {
  return clearQQMusicLoginSession();
});

// ========== 酷狗音乐（直连官方API） ==========
// 启动时恢复上次的平台选择
try {
  const savedPlatform = fs.readFileSync(path.join(__dirname, '..', '.kg-platform'), 'utf8').trim();
  if (savedPlatform === 'lite') process.env.platform = 'lite';
} catch (_) {}

const KG_COOKIE_FILE = path.join(__dirname, '..', '.kg-cookie');

function loadKGCookie() {
  try { if (fs.existsSync(KG_COOKIE_FILE)) return fs.readFileSync(KG_COOKIE_FILE, 'utf8').trim(); } catch (_) {}
  return '';
}

// ---- 酷狗缓存 ----
let _kgCachedGuid = '';
let _kgCachedMid = '';
let _kgCachedDfid = '';

function saveKGCookie(cookieStr) {
  const str = String(cookieStr || '').trim();
  // 同步缓存
  const parts = str.split(';');
  parts.forEach(p => { const eq = p.indexOf('='); if (eq > 0) { const k = p.slice(0, eq).trim(); const v = p.slice(eq + 1).trim(); if (k === 'KUGOU_API_GUID') _kgCachedGuid = v; if (k === 'KUGOU_API_MID') _kgCachedMid = v; if (k === 'dfid' && v !== '-') _kgCachedDfid = v; } });
  try { fs.writeFileSync(KG_COOKIE_FILE, str); } catch (_) {}
  // 立即同步到 server.js 进程内缓存（解决首次登录 server 端 cookie 不可见问题）
  try { if (typeof localServer !== 'undefined' && localServer && localServer.syncKGCookie) localServer.syncKGCookie(); } catch (_) {}
}

function kgCookieObj() {
  const raw = loadKGCookie();
  const obj = {};
  if (raw) {
    raw.split(';').forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq > 0) obj[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    });
  }
  // GUID: MD5格式（匹配原始 KuGouMusicApi）
  if (obj.KUGOU_API_GUID) { _kgCachedGuid = obj.KUGOU_API_GUID; }
  else if (_kgCachedGuid) { obj.KUGOU_API_GUID = _kgCachedGuid; }
  else { _kgCachedGuid = kugou.cryptoMd5(kugou.getGuid()); obj.KUGOU_API_GUID = _kgCachedGuid; }
  // MID
  if (obj.KUGOU_API_MID) { _kgCachedMid = obj.KUGOU_API_MID; }
  else if (_kgCachedMid) { obj.KUGOU_API_MID = _kgCachedMid; }
  else { _kgCachedMid = kugou.calculateMid(obj.KUGOU_API_GUID); obj.KUGOU_API_MID = _kgCachedMid; }
  // dfid
  if (obj.dfid && obj.dfid !== '-') { _kgCachedDfid = obj.dfid; }
  else if (_kgCachedDfid) { obj.dfid = _kgCachedDfid; }
  else { _kgCachedDfid = kugou.randomString(24); obj.dfid = _kgCachedDfid; }
  // 补充设备标识
  if (!obj.KUGOU_API_PLATFORM) obj.KUGOU_API_PLATFORM = process.env.platform || '';
  if (!obj.KUGOU_API_DEV) obj.KUGOU_API_DEV = kugou.randomString(10).toUpperCase();
  if (!obj.KUGOU_API_MAC) obj.KUGOU_API_MAC = '02:00:00:00:00:00';
  if (!obj.KUGOU_API_WEBGL) obj.KUGOU_API_WEBGL = kugou.generateWebGLHash();
  return obj;
}

function mapKGSong(item) {
  let name = item.FileName || item.SongName || item.songname || item.name || item.filename || '';
  let artist = item.SingerName || item.singername || item.author_name || item.artist || '';
  if (!artist && name && name.includes(' - ')) {
    const parts = name.split(' - ');
    artist = parts[0] || '';
    name = parts.slice(1).join(' - ').replace(/\.(mp3|flac|wav|ape|ogg|wma|aac|m4a)$/i, '') || name;
  }
  return {
    id: item.FileHash || item.hash || item.album_audio_id || item.mixsongid || item.MixSongID || '',
    name, artist,
    album: item.AlbumName || item.album_name || item.album || '',
    albumId: item.AlbumID || item.album_id || item.AlbumId || '',
    hash: (item.FileHash || item.hash || '').toLowerCase(),
    duration: item.Duration || item.duration || item.time || 0,
    cover: (item.Image || item.cover || item.img || '').replace('{size}', '400'),
    provider: 'kugou', source: 'kugou', type: 'kugou',
  };
}

async function safeKGRequest(config, fallback) {
  try { return await kugou.createRequest(config); }
  catch (e) {
    const body = e.body || {};
    // SSA 二次验证自动处理
    const errcode = body.errcode || body.error_code || 0;
    const ssaCode = body.ssaCode || '';
    if ((errcode === 20028 || ssaCode) && _kgCachedMid) {
      try {
        const requestDfid = config.cookie.dfid || _kgCachedDfid;
        const sim = kugou.generateSimulate(_kgCachedMid, config.cookie.userid || 0, requestDfid, config.cookie.KUGOU_API_WEBGL);
        const encrypt = kugou.cryptoAesEncrypt({});
        const pk = kugou.cryptoRSAEncrypt({ key: encrypt.key });
        await kugou.createRequest({
          baseURL: 'https://verifyservice.kugou.com', url: '/v4/verify_user_info', method: 'POST',
          data: { eventid: ssaCode || '', userid: Number(config.cookie.userid || 0), platid: 2, v_type: 23, wasm: 1, i: '', sid: decodeURIComponent(sim.sid), edt: decodeURIComponent(sim.edt), verifycode: '', pk, params: encrypt.str },
          params: { clientver: 11510 }, encryptType: 'android', cookie: config.cookie,
        });
        // 验证通过，重新注册设备获取新 dfid
        const newDfid = await kgRegisterDevDesktop();
        if (newDfid && config.cookie) config.cookie.dfid = newDfid;
        // 使用新 dfid 重试原始请求
        try { return await kugou.createRequest(config); } catch (_) {}
      } catch (_) {}
    }
    console.warn('[KG] req failed:', errcode || (e && e.message));
    return fallback || { body: {} };
  }
}

ipcMain.handle('kugou-login-qr-key', async (_event, platform) => {
  if (platform === 'lite' || platform === 'standard') {
    process.env.platform = platform === 'lite' ? 'lite' : '';
    try { fs.writeFileSync(path.join(__dirname, '..', '.kg-platform'), platform); } catch (_) {}
  }
  const r = await safeKGRequest({
    baseURL: 'https://login-user.kugou.com', url: '/v2/qrcode', method: 'GET',
    params: { appid: 1001, type: 1, plat: 4, qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=' + kugou.getAppid() + '&', srcappid: 2919 },
    encryptType: 'web', cookie: kgCookieObj(),
  });
  return { key: (r.body && r.body.data && r.body.data.qrcode) || '', platform: kugou.isLite() ? 'lite' : 'standard', appid: kugou.getAppid() };
});

ipcMain.handle('kugou-login-qr-check', async (_event, key) => {
  const r = await safeKGRequest({
    baseURL: 'https://login-user.kugou.com', url: '/v2/get_userinfo_qrcode', method: 'GET',
    params: { plat: 4, appid: kugou.getAppid(), srcappid: 2919, qrcode: key },
    encryptType: 'web', cookie: kgCookieObj(),
  });
  const body = r.body || {}; const data = body.data || body;
  const st = data.status || 0; const result = { code: st };
  if (st === 4 && data.token && data.userid) {
    saveKGCookie('token=' + data.token + ';userid=' + data.userid);
    result.loggedIn = true; result.token = data.token; result.userid = data.userid; result.nickname = '酷狗用户';
    // 异步注册设备获取真实 dfid
    kgRegisterDevDesktop().catch(() => {});
    // 概念版登录后自动领 VIP
    if (process.env.platform === 'lite') {
      startVipClaimSchedule();
      setTimeout(() => doClaimYouthVip(), 3000);
    }
    }
  }
  return result;
});

// 概念版自动领取 VIP（每日一次）
const VIP_LOG_FILE = path.join(app.getPath('userData'), '.kg-vip-last');
function getVipLastClaim() {
  try { if (fs.existsSync(VIP_LOG_FILE)) return new Date(fs.readFileSync(VIP_LOG_FILE, 'utf8').trim()).getTime(); } catch (_) {}
  return 0;
}
function saveVipLastClaim() {
  try { fs.writeFileSync(VIP_LOG_FILE, new Date().toISOString()); } catch (_) {}
}
function shouldClaimVip() {
  var last = getVipLastClaim();
  if (!last) return true;
  var now = Date.now();
  // 超过 24 小时
  if (now - last > 86400000) return true;
  // 跨天：上次是昨天或更早
  var lastDay = new Date(last).toDateString();
  var today = new Date(now).toDateString();
  return lastDay !== today;
}
var vipClaimTimer = null;
var vipMidnightTimer = null;
function doClaimYouthVip() {
  if (!shouldClaimVip()) { console.log('[KG VIP] 今日已领取，跳过'); return; }
  const obj = kgCookieObj();
  if (!obj.token || !obj.userid) { console.log('[KG VIP] 未登录，跳过'); return; }
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  console.log('[KG VIP] 开始每日领取...');
  safeKGRequest({
    url: '/youth/v1/recharge/receive_vip_listen_song',
    encryptType: 'android', method: 'POST',
    params: { source_id: 90139, receive_day: tomorrow },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    cookie: obj,
  }).then((r) => {
    console.log('[KG VIP] 领取成功, status:', (r.body && r.body.status));
    return safeKGRequest({
      url: '/youth/v1/listen_song/upgrade_vip_reward',
      encryptType: 'android', method: 'POST',
      params: { kugouid: Number(obj.userid || 0), ad_type: 1 },
      cookie: obj,
    });
  }).then((r) => {
    console.log('[KG VIP] 升级成功, status:', (r.body && r.body.status));
    saveVipLastClaim();
  }).catch(e => console.warn('[KG VIP] 失败:', (e && e.body && e.body.error) || (e && e.message)));
}
function startVipClaimSchedule() {
  if (vipClaimTimer) clearInterval(vipClaimTimer);
  if (vipMidnightTimer) clearTimeout(vipMidnightTimer);
  // 每30分钟检查一次
  vipClaimTimer = setInterval(function() {
    if (process.env.platform === 'lite' && kgCookieObj().token) doClaimYouthVip();
  }, 1800000);
  // 计算到凌晨0点的毫秒数，到了就触发
  function scheduleMidnight() {
    var now = new Date();
    var midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    var ms = midnight.getTime() - now.getTime();
    vipMidnightTimer = setTimeout(function() {
      if (process.env.platform === 'lite' && kgCookieObj().token) doClaimYouthVip();
      scheduleMidnight(); // 递归调度下一个凌晨
    }, ms + 1000);
  }
  scheduleMidnight();
}

// 桌面版 register_dev
async function kgRegisterDevDesktop() {
  const obj = kgCookieObj();
  const dataMap = { availableRamSize: 4983533568, availableRomSize: 48114719, availableSDSize: 48114717, basebandVer: '', batteryLevel: 100, batteryStatus: 3, brand: 'Redmi', buildSerial: 'unknown', device: 'marble', imei: obj.KUGOU_API_GUID || '', imsi: '', manufacturer: 'Xiaomi', uuid: obj.KUGOU_API_GUID || '', accelerometer: false, accelerometerValue: '', gravity: false, gravityValue: '', gyroscope: false, gyroscopeValue: '', light: false, lightValue: '', magnetic: false, magneticValue: '', orientation: false, orientationValue: '', pressure: false, pressureValue: '', step_counter: false, step_counterValue: '', temperature: false, temperatureValue: '' };
  const aesEncrypt = kugou.playlistAesEncrypt(dataMap);
  const p = kugou.rsaEncrypt2({ aes: aesEncrypt.key, uid: obj.userid || 0, token: obj.token || '' });
  try {
    const result = await kugou.createRequest({ baseURL: 'https://userservice.kugou.com', url: '/risk/v2/r_register_dev', method: 'POST', data: aesEncrypt.str, params: { part: 1, platid: 1, p }, encryptType: 'android', cookie: obj, responseType: 'arraybuffer' });
    const decrypted = kugou.playlistAesDecrypt({ str: Buffer.from(result.body).toString('base64'), key: aesEncrypt.key });
    if (decrypted && decrypted.status === 1 && decrypted.data && decrypted.data.dfid) {
      _kgCachedDfid = decrypted.data.dfid;
      const raw = loadKGCookie(); const parts = raw ? raw.split(';').filter(Boolean) : [];
      parts.push('dfid=' + decrypted.data.dfid);
      saveKGCookie(parts.join('; '));
      return decrypted.data.dfid;
    }
  } catch (_) {}
}

ipcMain.handle('kugou-login-status', async () => {
  const obj = kgCookieObj();
  const loggedIn = !!(obj.token && obj.userid);
  let nickname = '酷狗用户', avatar = '', vipType = 0;
  if (loggedIn) {
    try {
      const clienttime_ms = Math.floor(Date.now() / 1000);
      const pk = kugou.cryptoRSAEncrypt({ token: obj.token, clienttime: clienttime_ms }).toUpperCase();
      const r = await safeKGRequest({ url: '/v3/get_my_info', method: 'POST', data: { visit_time: clienttime_ms, usertype: 1, p: pk, userid: Number(obj.userid) }, params: { plat: 1 }, encryptType: 'android', cookie: obj, headers: { 'x-router': 'usercenter.kugou.com' } }, { body: { data: {} } });
      const d = (r.body && r.body.data) || {};
      nickname = d.nickname || d.k_nickname || '酷狗用户';
      avatar = d.pic || d.k_pic || d.fx_pic || '';
      vipType = Number(d.vip_type || 0) || 0;
    } catch (_) {}
  }
  return { loggedIn, nickname, userId: obj.userid || '', avatar, vipType, vipLevel: vipType > 0 ? 'vip' : 'none', isVip: vipType > 0, provider: 'kugou', platform: process.env.platform === 'lite' ? 'lite' : 'standard', appid: kugou.getAppid(), clientver: kugou.getClientver() };
});

ipcMain.handle('kugou-logout', async () => { saveKGCookie(''); _kgCachedDfid = ''; return { ok: true }; });

ipcMain.handle('kugou-login-cookie', async (_event, cookieStr) => {
  saveKGCookie(String(cookieStr || '').trim());
  const obj = kgCookieObj();
  return { loggedIn: !!(obj.token && obj.userid), nickname: '酷狗用户', userId: obj.userid || '' };
});

ipcMain.handle('kugou-platform', async (_event, mode) => {
  if (mode === 'lite' || mode === 'standard') {
    process.env.platform = mode === 'lite' ? 'lite' : '';
    try { fs.writeFileSync(path.join(__dirname, '..', '.kg-platform'), mode === 'lite' ? 'lite' : 'standard'); } catch (_) {}
  }
  return { ok: true, platform: process.env.platform === 'lite' ? 'lite' : 'standard', appid: kugou.getAppid(), clientver: kugou.getClientver() };
});

ipcMain.handle('kugou-search', async (_event, keywords, limit, type) => {
  const kw = String(keywords || '').trim(); const lim = Math.max(6, Math.min(50, parseInt(limit || '30', 10) || 30)); const t = type || 'song';
  if (!kw) return { provider: 'kugou', songs: [] };
  const r = await safeKGRequest({
    url: '/' + (t === 'song' ? 'v3' : 'v1') + '/search/' + t, method: 'GET',
    params: { keyword: kw, page: 1, pagesize: lim, albumhide: 0, iscorrection: 1, nocollect: 0, platform: 'AndroidFilter' },
    encryptType: 'android', cookie: kgCookieObj(), headers: { 'x-router': 'complexsearch.kugou.com' },
  });
  const data = (r.body && r.body.data) || {};
  return { provider: 'kugou', songs: (data.lists || data.info || []).map(mapKGSong), total: data.total || 0 };
});

ipcMain.handle('kugou-song-url', async (_event, hash, albumId, albumAudioId, quality) => {
  const h = String(hash || '').trim().toLowerCase();
  if (!h) return { provider: 'kugou', url: '' };
  const qualityMap = { jymaster: 'flac', master: 'flac', svip: 'flac', hires: '320', 'hi-res': '320', highres: '320', lossless: 'flac', flac: 'flac', sq: 'flac', exhigh: '320', high: '320', '320k': '320', hq: '320', standard: '128', normal: '128', std: '128' };
  const q = qualityMap[String(quality || '').toLowerCase()] || quality || '128';
  const cookieObj = kgCookieObj();
  // 平台参数（只用当前平台，跨平台 fallback 会导致 illegal key）
  const plat = kugou.isLite()
    ? { pid: 411, page_id: 967177915, ppage_id: '356753938,823673182,967485191' }
    : { pid: 2, page_id: 151369488, ppage_id: '463467626,350369493,788954147' };
  // 音质降级链：请求音质 → 128kbps（VIP 歌曲高音质可能不可用）
  const qualityChain = q !== '128' ? [q, '128'] : ['128'];

  for (const qu of qualityChain) {
    const baseParams = { hash: h, album_id: Number(albumId || '0'), album_audio_id: Number(albumAudioId || '0'), quality: qu, behavior: 'play', pid: plat.pid, cmd: 26, pidversion: 3001, area_code: 1, ssa_flag: 'is_fromtrack', version: 11430, page_id: plat.page_id, ppage_id: plat.ppage_id, cdnBackup: 1, module: '', clientver: 11430 };
    for (const isFree of [0, 1]) {
      const requestDfid = kugou.isLite() ? (cookieObj.dfid || _kgCachedDfid) : kugou.randomString(24);
      const songCookie = Object.assign({}, cookieObj, { dfid: requestDfid });
      const r = await safeKGRequest({ url: '/v5/url', method: 'GET', encryptType: 'android', encryptKey: true, notSign: true, params: { ...baseParams, IsFreePart: isFree }, cookie: songCookie, headers: { 'x-router': 'trackercdn.kugou.com' } });
      const body = r.body || {};
      if (body.url && (Array.isArray(body.url) ? body.url[0] : body.url)) return { provider: 'kugou', url: Array.isArray(body.url) ? body.url[0] : body.url, urls: body.url || [], bitrate: body.bitrate || 0 };
      if (body.backupUrl && Array.isArray(body.backupUrl) && body.backupUrl[0]) return { provider: 'kugou', url: body.backupUrl[0], urls: body.backupUrl, bitrate: body.bitrate || 0 };
    }
  }
  return { provider: 'kugou', url: '', urls: [], bitrate: 0 };
});

ipcMain.handle('kugou-lyric', async (_event, id, accesskey) => {
  if (!id || !accesskey) return { provider: 'kugou', lyric: '' };
  const r = await safeKGRequest({ baseURL: 'https://lyrics.kugou.com', url: '/download', method: 'GET', params: { ver: 1, client: 'android', id, accesskey, fmt: 'krc', charset: 'utf8' }, encryptType: 'android', cookie: kgCookieObj() });
  const body = r.body || {}; let lyric = '';
  if (body && body.content) lyric = kugou.decodeLyrics(body.content) || Buffer.from(body.content, 'base64').toString();
  return { provider: 'kugou', lyric, id };
});

ipcMain.handle('kugou-user-playlists', async () => {
  const obj = kgCookieObj();
  if (!obj.token || !obj.userid) return { provider: 'kugou', loggedIn: false, playlists: [] };
  const r = await safeKGRequest({ url: '/v7/get_all_list', method: 'POST', data: { userid: Number(obj.userid || 0), token: obj.token, total_ver: 979, type: 2, page: 1, pagesize: 60 }, params: { plat: 1, userid: Number(obj.userid || 0), token: obj.token }, encryptType: 'android', cookie: obj, headers: { 'x-router': 'cloudlist.service.kugou.com' } });
  const data = (r.body && r.body.data) || {};
  const list = (data.list || data.info || []).map(pl => ({ id: pl.global_collection_id || pl.listid || pl.id || '', listid: pl.listid || pl.special_id || '', name: pl.name || pl.special_name || pl.listname || '', cover: (pl.imgurl || pl.pic || pl.cover || pl.create_user_pic || '').replace('{size}', '400'), trackCount: pl.count || pl.track_count || pl.song_count || 0, playCount: pl.play_count || pl.listencount || 0, creator: pl.username || pl.list_create_username || '', subscribed: true, specialType: pl.type || 0 }));
  // 始终从 /v3/get_list_info 获取真实封面（/v7/get_all_list 返回的是用户头像而非歌单封面）
  const allIds = list.filter(pl => pl.id).map(pl => pl.id);
  if (allIds.length) {
    try {
      const r2 = await safeKGRequest({ url: '/v3/get_list_info', method: 'POST', data: { data: allIds.map(s => ({ global_collection_id: s })), userid: Number(obj.userid || 0), token: obj.token || '' }, encryptType: 'android', cookie: obj, headers: { 'x-router': 'pubsongs.kugou.com' } });
      const raw = ((r2.body || {}).data || (r2.body || {}).info || {});
      (Array.isArray(raw) ? raw : Object.values(raw)).forEach(pl => {
        if (pl && pl.global_collection_id) {
          const realCover = (pl.pic || pl.imgurl || pl.img || pl.create_user_pic || '').replace('{size}', '400');
          const target = list.find(x => x.id === pl.global_collection_id);
          if (target && realCover) target.cover = realCover;
        }
      });
    } catch (_) {}
  }
  return { provider: 'kugou', loggedIn: true, userId: obj.userid, playlists: list };
});

// -------- 酷狗：歌单详情 --------
ipcMain.handle('kugou-playlist-detail', async (_event, ids) => {
  const obj = kgCookieObj();
  const idList = String(ids || '').split(',').filter(Boolean);
  if (!idList.length) return { provider: 'kugou', playlists: [] };
  const r = await safeKGRequest({
    url: '/v3/get_list_info', method: 'POST',
    data: { data: idList.map(s => ({ global_collection_id: s })), userid: Number(obj.userid || 0), token: obj.token || '' },
    encryptType: 'android', cookie: obj,
    headers: { 'x-router': 'pubsongs.kugou.com' },
  });
  const body = (r.body || {});
  const raw = body.data || body.info || [];
  const playlists = (Array.isArray(raw) ? raw : Object.values(raw)).filter(v => v && typeof v === 'object' && v.global_collection_id).map(pl => ({
    id: pl.global_collection_id || '',
    name: pl.name || pl.special_name || '',
    cover: (pl.pic || pl.imgurl || pl.img || pl.create_user_pic || '').replace('{size}', '400'),
    trackCount: pl.count || pl.track_count || pl.song_count || 0,
    creator: pl.username || pl.list_create_username || '',
  }));
  return { provider: 'kugou', playlists };
});

ipcMain.handle('kugou-playlist-tracks', async (_event, id, page, pagesize, listid) => {
  if (!id && !listid) return { provider: 'kugou', tracks: [] };
  const pg = Math.max(1, parseInt(page || '1', 10) || 1); const sz = Math.max(10, Math.min(1000, parseInt(pagesize || '1000', 10) || 60));
  const obj = kgCookieObj();
  // 用户自己歌单用 listid
  const useListid = listid || (/^\d+$/.test(String(id || '')) ? id : '');
  if (useListid) {
    const r = await safeKGRequest({ url: '/v4/get_list_all_file', method: 'POST', data: { listid: useListid, userid: Number(obj.userid || 0), area_code: 1, show_relate_goods: 0, pagesize: sz, allplatform: 1, show_cover: 1, type: 0, token: obj.token || '', page: pg }, encryptType: 'android', cookie: obj, headers: { 'x-router': 'cloudlist.service.kugou.com' } });
    const data = (r.body && r.body.data) || {};
    const tracks = (data.info || data.list || data.songs || []).map(mapKGSong);
    if (tracks.length) return { provider: 'kugou', tracks, total: tracks.length };
  }
  // 回退：公开歌单用 global_collection_id
  if (id) {
    const r2 = await safeKGRequest({ url: '/pubsongs/v2/get_other_list_file_nofilt', method: 'GET', params: { global_collection_id: id, page: pg, pagesize: sz, area_code: 1, plat: 1, type: 1, mode: 1, personal_switch: 1, begin_idx: (pg - 1) * sz, extend_fields: 'abtags,hot_cmt,popularization' }, encryptType: 'android', cookie: obj });
    const data2 = (r2.body && r2.body.data) || {};
    return { provider: 'kugou', tracks: (data2.info || data2.list || []).map(mapKGSong), total: data2.count || data2.total || 0 };
  }
  return { provider: 'kugou', tracks: [] };
});

// -------- 酷狗：歌单所有歌曲（by global_collection_id）--------
ipcMain.handle('kugou-playlist-track-all', async (_event, id, page, pagesize) => {
  if (!id) return { provider: 'kugou', tracks: [] };
  const pg = Math.max(1, parseInt(page || '1', 10) || 1);
  const sz = Math.max(10, Math.min(1000, parseInt(pagesize || '1000', 10) || 30));
  const r = await safeKGRequest({
    url: '/pubsongs/v2/get_other_list_file_nofilt', method: 'GET',
    params: { global_collection_id: id, page: pg, pagesize: sz, area_code: 1, plat: 1, type: 1, mode: 1, personal_switch: 1, begin_idx: (pg - 1) * sz, extend_fields: 'abtags,hot_cmt,popularization' },
    encryptType: 'android', cookie: kgCookieObj(),
  });
  const data = (r.body && r.body.data) || {};
  return { provider: 'kugou', tracks: (data.info || data.list || data.songs || []).map(mapKGSong), total: data.count || data.total || 0 };
});

// -------- 酷狗：歌单所有歌曲新版（by listid）--------
ipcMain.handle('kugou-playlist-track-all-new', async (_event, listid, page, pagesize) => {
  if (!listid) return { provider: 'kugou', tracks: [] };
  const pg = Math.max(1, parseInt(page || '1', 10) || 1);
  const sz = Math.max(10, Math.min(1000, parseInt(pagesize || '1000', 10) || 30));
  const obj = kgCookieObj();
  const r = await safeKGRequest({
    url: '/v4/get_list_all_file', method: 'POST',
    data: { listid, userid: Number(obj.userid || 0), area_code: 1, show_relate_goods: 0, pagesize: sz, allplatform: 1, show_cover: 1, type: 0, token: obj.token || '', page: pg },
    encryptType: 'android', cookie: obj,
    headers: { 'x-router': 'cloudlist.service.kugou.com' },
  });
  const data = (r.body && r.body.data) || {};
  return { provider: 'kugou', tracks: (data.info || data.list || data.songs || []).map(mapKGSong), total: data.count || data.total || 0 };
});

// -------- 酷狗：收藏歌单 / 新建歌单 --------
ipcMain.handle('kugou-playlist-add', async (_event, params) => {
  const obj = kgCookieObj();
  const userid = params?.userid || obj.userid || 0;
  const token = params?.token || obj.token || '';
  const clienttime = Math.floor(Date.now() / 1000);
  const type = parseInt(params?.type || '0', 10);
  const dataMap = {
    userid: Number(userid), token, total_ver: 0,
    name: params?.name || '', type,
    source: params?.source || 1, is_pri: 0,
    list_create_userid: params?.list_create_userid || '',
    list_create_listid: params?.list_create_listid || '',
    list_create_gid: params?.list_create_gid || '',
    from_shupinmv: 0,
  };
  if (type === 0) dataMap['is_pri'] = parseInt(params?.is_pri || '0', 10) || 0;
  const r = await safeKGRequest({
    url: '/cloudlist.service/v5/add_list',
    data: dataMap,
    params: type === 0 ? { last_time: clienttime, last_area: 'gztx', userid, token } : {},
    method: 'POST', encryptType: 'android', cookie: obj,
  });
  return { provider: 'kugou', ...(r.body || {}) };
});

// -------- 酷狗：取消收藏歌单 / 删除歌单 --------
ipcMain.handle('kugou-playlist-del', async (_event, listid) => {
  const obj = kgCookieObj();
  const userid = obj.userid || 0;
  const token = obj.token || '';
  const clienttime = Math.floor(Date.now() / 1000);
  if (!listid) return { provider: 'kugou', error: 'Missing listid' };
  const dataMap = { listid: Number(listid), total_ver: 0, type: 1 };
  const aesEncrypt = kugou.playlistAesEncrypt(dataMap);
  const p = kugou.rsaEncrypt2({ aes: aesEncrypt.key, uid: Number(userid), token }).toUpperCase();
  const r = await safeKGRequest({
    url: '/v2/delete_list',
    params: { clienttime, key: kugou.signParamsKey(clienttime.toString()), last_area: 'gztx', clientver: kugou.getClientver(), appid: kugou.getAppid(), last_time: clienttime, p },
    data: aesEncrypt.str, method: 'POST', encryptType: 'android',
    headers: { 'x-router': 'cloudlist.service.kugou.com' },
    responseType: 'arraybuffer', cookie: obj,
  });
  const decrypted = kugou.playlistAesDecrypt({ str: Buffer.from(r.body).toString('base64'), key: aesEncrypt.key });
  return { provider: 'kugou', data: decrypted };
});

// -------- 酷狗：对歌单添加歌曲 --------
ipcMain.handle('kugou-playlist-tracks-add', async (_event, listid, dataStr) => {
  const obj = kgCookieObj();
  const userid = obj.userid || 0;
  const token = obj.token || '';
  const clienttime = Math.floor(Date.now() / 1000);
  if (!listid || !dataStr) return { provider: 'kugou', error: 'Missing listid or data' };
  const resource = String(dataStr).split(',').map(s => {
    const d = s.split('|');
    return { number: 1, name: d[0] || '', hash: d[1] || '', size: 0, sort: 0, timelen: 0, bitrate: 0, album_id: Number(d[2] || 0), mixsongid: Number(d[3] || 0) };
  });
  const r = await safeKGRequest({
    url: '/cloudlist.service/v6/add_song',
    data: { userid: Number(userid), token, listid, list_ver: 0, type: 0, slow_upload: 1, scene: 'false;null', data: resource },
    params: { last_time: clienttime, last_area: 'gztx', userid, token },
    method: 'POST', encryptType: 'android', cookie: obj,
  });
  return { provider: 'kugou', ...(r.body || {}) };
});

// -------- 酷狗：对歌单删除歌曲 --------
ipcMain.handle('kugou-playlist-tracks-del', async (_event, listid, fileids) => {
  const obj = kgCookieObj();
  const userid = obj.userid || 0;
  const token = obj.token || '';
  if (!listid || !fileids) return { provider: 'kugou', error: 'Missing listid or fileids' };
  const resource = String(fileids).split(',').map(s => ({ fileid: Number(s.trim()) }));
  const r = await safeKGRequest({
    url: '/v4/delete_songs',
    data: { listid, userid: Number(userid), data: resource, type: 0, token, list_ver: 0 },
    method: 'POST', encryptType: 'android', cookie: obj,
    headers: { 'x-router': 'cloudlist.service.kugou.com' },
  });
  return { provider: 'kugou', ...(r.body || {}) };
});

// -------- 酷狗概念版：领取一天 VIP --------
ipcMain.handle('kugou-youth-day-vip', async (_event, receiveDay) => {
  const obj = kgCookieObj();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const day = receiveDay || tomorrow;
  const r = await safeKGRequest({
    url: '/youth/v1/recharge/receive_vip_listen_song',
    encryptType: 'android', method: 'POST',
    params: { source_id: 90139, receive_day: day },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    cookie: obj,
  });
  return { provider: 'kugou', ...(r.body || {}) };
});

// -------- 酷狗概念版：手动测试 VIP --------
ipcMain.handle('kugou-test-vip', async () => {
  if (process.env.platform !== 'lite') return { ok: false, error: '需要概念版' };
  try {
    const obj = kgCookieObj();
    if (!obj.token) return { ok: false, error: '未登录' };
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r1 = await safeKGRequest({
      url: '/youth/v1/recharge/receive_vip_listen_song',
      encryptType: 'android', method: 'POST',
      params: { source_id: 90139, receive_day: tomorrow },
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      cookie: obj,
    });
    const r2 = await safeKGRequest({
      url: '/youth/v1/listen_song/upgrade_vip_reward',
      encryptType: 'android', method: 'POST',
      params: { kugouid: Number(obj.userid || 0), ad_type: 1 },
      cookie: obj,
    });
    saveVipLastClaim();
    return { ok: true, claim: (r1.body || {}), upgrade: (r2.body || {}) };
  } catch(e) { return { ok: false, error: e.message }; }
});

// -------- 酷狗概念版：升级 VIP --------
ipcMain.handle('kugou-youth-day-vip-upgrade', async () => {
  const obj = kgCookieObj();
  const userid = obj.userid || 0;
  const r = await safeKGRequest({
    url: '/youth/v1/listen_song/upgrade_vip_reward',
    encryptType: 'android', method: 'POST',
    params: { kugouid: Number(userid), ad_type: 1 },
    cookie: obj,
  });
  return { provider: 'kugou', ...(r.body || {}) };
});

ipcMain.handle('mineradio-open-update-installer', async (_event, filePath) => {
  try {
    const target = path.resolve(String(filePath || ''));
    const updateDir = path.resolve(getUpdateDownloadDir());
    if (!target || !target.startsWith(updateDir + path.sep)) {
      return { ok: false, error: 'INVALID_UPDATE_PATH' };
    }
    if (!fs.existsSync(target)) return { ok: false, error: 'UPDATE_FILE_MISSING' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'OPEN_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-restart-app', async () => {
  try {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'RESTART_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) {
      createDesktopLyricsWindow(payload || {});
      broadcastDesktopLyricsEnabledState(true);
    } else {
      closeDesktopLyricsWindow();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-update', async (_event, payload) => {
  try {
    const nextState = { ...desktopLyricsState, ...(payload || {}) };
    if (nextState.enabled) {
      createDesktopLyricsWindow(payload || {});
    } else if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
      desktopLyricsState = nextState;
      sendDesktopLyricsState();
    } else {
      desktopLyricsState = nextState;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-dragging', async () => {
  return { ok: true };
});

ipcMain.handle('mineradio-desktop-lyrics-set-pointer-capture', async (_event, active) => {
  try {
    desktopLyricsPointerCapture = !!active;
    applyDesktopLyricsMouseBehavior();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_POINTER_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-hot-bounds', async (_event, bounds) => {
  try {
    const left = clampNumber(bounds && bounds.left, -2000, 4000, 0);
    const top = clampNumber(bounds && bounds.top, -2000, 4000, 0);
    const right = clampNumber(bounds && bounds.right, left + 1, 6000, left + 1);
    const bottom = clampNumber(bounds && bounds.bottom, top + 1, 6000, top + 1);
    desktopLyricsHotBounds = { left, top, right, bottom };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_HOT_BOUNDS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-lock-state', async (_event, locked) => {
  try {
    desktopLyricsState = { ...desktopLyricsState, clickThrough: !!locked };
    if (desktopLyricsState.clickThrough !== false) desktopLyricsPointerCapture = false;
    applyDesktopLyricsMouseBehavior();
    broadcastDesktopLyricsLockState();
    return { ok: true, locked: desktopLyricsState.clickThrough !== false };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_LOCK_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-move-by', async (_event, dx, dy) => {
  try {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return { ok: false, error: 'NO_DESKTOP_LYRICS_WINDOW' };
    if (desktopLyricsState.clickThrough !== false) return { ok: false, error: 'DESKTOP_LYRICS_LOCKED' };
    const bounds = desktopLyricsWindow.getBounds();
    const next = {
      ...bounds,
      x: Math.round(bounds.x + clampNumber(dx, -160, 160, 0)),
      y: Math.round(bounds.y + clampNumber(dy, -160, 160, 0)),
    };
    desktopLyricsWindow.setBounds(next, false);
    desktopLyricsUserBounds = desktopLyricsWindow.getBounds();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_MOVE_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) createWallpaperWindow(payload || {});
    else closeWallpaperWindow();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-update', async (_event, payload) => {
  try {
    wallpaperState = { ...wallpaperState, ...(payload || {}) };
    if (wallpaperState.enabled) {
      createWallpaperWindow(wallpaperState);
      if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
        positionWallpaperWindow();
        sendWallpaperState();
      }
    } else if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
      sendWallpaperState();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_UPDATE_FAILED' };
  }
});

async function createWindow() {
  htmlFullscreenActive = false;
  windowFullscreenActive = false;
  const port = await findOpenPort(3000);
  mainServerPort = port;

  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(port);
  process.env.COOKIE_FILE = path.join(app.getPath('userData'), '.cookie');
  process.env.QQ_COOKIE_FILE = path.join(app.getPath('userData'), '.qq-cookie');
  process.env.MINERADIO_UPDATE_DIR = getUpdateDownloadDir();
  try {
    const legacyQQCookie = path.join(__dirname, '..', '.qq-cookie');
    if (fs.existsSync(legacyQQCookie)) {
      if (!fs.existsSync(process.env.QQ_COOKIE_FILE)) {
        fs.copyFileSync(legacyQQCookie, process.env.QQ_COOKIE_FILE);
      }
      fs.unlinkSync(legacyQQCookie);
    }
  } catch (e) {
    console.warn('QQ cookie migration skipped:', e.message);
  }

  localServer = require(path.join(__dirname, '..', 'server.js'));
  await waitForServer(localServer);

  // 概念版：启动 VIP 定时器（30分钟检查+凌晨触发+启动检查）
  if (process.env.platform === 'lite') {
    startVipClaimSchedule();
    setTimeout(() => { if (kgCookieObj().token) doClaimYouthVip(); }, 5000);
  }

  const initialBounds = getWindowedBounds();

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 960,
    minHeight: 540,
    show: false,
    frame: false,
    fullscreen: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: APP_ICON_ICO,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    sendWindowState(mainWindow);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'Escape' || input.code === 'Escape') && mainWindow.isFullScreen()) {
      event.preventDefault();
      exitFullscreenToWindow(mainWindow);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    sendWindowState(mainWindow);
  });

  mainWindow.on('maximize', () => sendWindowState(mainWindow));
  mainWindow.on('unmaximize', () => sendWindowState(mainWindow));
  mainWindow.on('minimize', () => sendWindowState(mainWindow));
  mainWindow.on('restore', () => sendWindowState(mainWindow));
  mainWindow.on('show', () => sendWindowState(mainWindow));
  mainWindow.on('hide', () => sendWindowState(mainWindow));
  mainWindow.on('focus', () => sendWindowState(mainWindow));
  mainWindow.on('blur', () => sendWindowState(mainWindow));
  mainWindow.on('move', () => scheduleWindowStateSend(mainWindow));
  mainWindow.on('resize', () => scheduleWindowStateSend(mainWindow));
  mainWindow.on('closed', () => {
    if (mainWindowStateTimer) {
      clearTimeout(mainWindowStateTimer);
      mainWindowStateTimer = null;
    }
    closeOverlayWindows();
    mainWindow = null;
  });
  mainWindow.on('enter-full-screen', () => {
    windowFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    windowFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });
  mainWindow.on('enter-html-full-screen', () => {
    htmlFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-html-full-screen', () => {
    htmlFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!focusMainWindow()) {
      app.whenReady().then(() => createWindow()).catch((e) => console.error('Second instance window restore failed:', e));
    }
  });

  app.whenReady().then(async () => {
    screen.on('display-metrics-changed', () => {
      positionDesktopLyricsWindow();
      positionWallpaperWindow();
      scheduleWindowStateSend(mainWindow);
    });
    screen.on('display-added', () => scheduleWindowStateSend(mainWindow));
    screen.on('display-removed', () => scheduleWindowStateSend(mainWindow));
    await createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    unregisterMineradioGlobalHotkeys();
    closeOverlayWindows();
    if (localServer && localServer.close) localServer.close();
  });
}
