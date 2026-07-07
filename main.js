const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const POLL_INTERVAL_MS = 60 * 1000; // 1분마다 자동 새로고침

// 해시(#settings/usage)만 다르고 나머지 URL이 같으면 Electron/Chromium이 "같은 문서 내 이동"으로 처리해
// 페이지를 다시 로드하지 않을 수 있다. 매번 진짜로 새로 로드되도록 쿼리스트링에 타임스탬프를 섞는다.
function usageUrl() {
  return `https://claude.ai/new?_w=${Date.now()}#settings/usage`;
}

const userDataPath = app.getPath('userData');
const stateFile = path.join(userDataPath, 'widget-state.json');
const debugLogFile = path.join(userDataPath, 'debug.log');

function debugLog(msg) {
  try {
    fs.appendFileSync(debugLogFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {
    // 무시
  }
}

let widgetWin = null;
let workerWin = null;
let tray = null;
let pollTimer = null;
let lastData = null;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveState(patch) {
  try {
    const merged = { ...loadState(), ...patch };
    fs.writeFileSync(stateFile, JSON.stringify(merged));
  } catch (e) {
    // 무시
  }
}

function getMode() {
  return loadState().mode === 'tray' ? 'tray' : 'widget';
}

function getOpacity() {
  const v = loadState().opacity;
  return typeof v === 'number' ? v : 1;
}

const EXTRACT_SCRIPT = `(function(){
  const text = document.body.innerText || '';
  const sessionM = text.match(/현재\\s*세션\\s*\\n([^\\n]+)\\s*\\n(\\d+)%\\s*사용됨/);
  const weeklyM = text.match(/모든\\s*모델\\s*\\n([^\\n]+)\\s*\\n(\\d+)%\\s*사용됨/);
  const hasLoginForm = !!document.querySelector('input[type="password"], input[name="email"]') ||
    /계속하려면 로그인|Continue with|Log in to Claude/i.test(text);
  return {
    ok: !!(sessionM && weeklyM),
    needsLogin: !sessionM && !weeklyM && hasLoginForm,
    session: sessionM ? { reset: sessionM[1].trim(), pct: parseInt(sessionM[2], 10) } : null,
    weekly: weeklyM ? { reset: weeklyM[1].trim(), pct: parseInt(weeklyM[2], 10) } : null
  };
})()`;

function createWidgetWindow() {
  const state = loadState();
  widgetWin = new BrowserWindow({
    width: 168,
    height: 150,
    x: typeof state.x === 'number' ? state.x : undefined,
    y: typeof state.y === 'number' ? state.y : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: getMode() === 'widget',
    opacity: getOpacity(),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  widgetWin.setAlwaysOnTop(true, 'screen-saver');
  widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWin.loadFile('widget.html');

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const [x, y] = widgetWin.getPosition();
      saveState({ x, y });
    }, 400);
  };
  widgetWin.on('move', scheduleSave);
  widgetWin.on('closed', () => { widgetWin = null; });

  if (lastData) widgetWin.webContents.once('did-finish-load', () => sendToWidget(lastData));
}

function createWorkerWindow() {
  workerWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 720,
    webPreferences: {
      partition: 'persist:claudeusage'
    }
  });
  workerWin.on('closed', () => { workerWin = null; });
}

function updateTray(data) {
  if (!tray) return;
  const fivePct = data && data.session ? data.session.pct : null;
  const sevenPct = data && data.weekly ? data.weekly.pct : null;

  if (data && data.needsLogin) {
    tray.setToolTip('Claude 사용량 위젯 — 로그인이 필요해요');
    return;
  }
  if (!data || !data.ok) {
    tray.setToolTip('Claude 사용량 위젯 — 불러오는 중...');
    return;
  }
  tray.setToolTip(
    `5시간: ${fivePct}% (${data.session.reset})\n주간: ${sevenPct}% (${data.weekly.reset})`
  );
}

function sendToWidget(data) {
  lastData = data;
  updateTray(data);
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.webContents.send('usage-data', data);
  }
}

async function pollUsage() {
  if (!workerWin || workerWin.isDestroyed()) createWorkerWindow();
  try {
    await workerWin.loadURL(usageUrl());
    await new Promise((r) => setTimeout(r, 2500));
    const result = await workerWin.webContents.executeJavaScript(EXTRACT_SCRIPT);
    const url = workerWin.webContents.getURL();
    const snippet = await workerWin.webContents.executeJavaScript('(document.body.innerText||"").slice(0,300)');
    debugLog(`pollUsage ok=${result.ok} needsLogin=${result.needsLogin} url=${url} snippet=${JSON.stringify(snippet)}`);
    sendToWidget(result);
  } catch (e) {
    debugLog(`pollUsage error: ${e.message}`);
    sendToWidget({ ok: false, needsLogin: false, session: null, weekly: null });
  }
}

const LOGIN_CHECK_SCRIPT = `(!location.href.includes('/login') && (
  !!document.querySelector('div[contenteditable="true"], textarea') ||
  /안녕하세요/.test(document.body.innerText || '')
))`;

function openLoginWindow() {
  if (!workerWin || workerWin.isDestroyed()) createWorkerWindow();
  workerWin.show();
  workerWin.focus();
  workerWin.loadURL('https://claude.ai/login');
  debugLog('openLoginWindow: 로그인 페이지 로드');

  let tries = 0;
  const maxTries = 200; // 최대 약 10분 대기
  const check = setInterval(async () => {
    tries += 1;
    if (!workerWin || workerWin.isDestroyed() || tries > maxTries) { clearInterval(check); return; }
    try {
      const loggedIn = await workerWin.webContents.executeJavaScript(LOGIN_CHECK_SCRIPT);
      if (loggedIn) {
        clearInterval(check);
        debugLog(`로그인 감지됨 (시도 ${tries}회)`);
        await workerWin.loadURL(usageUrl());
        await new Promise((r) => setTimeout(r, 2500));
        const result = await workerWin.webContents.executeJavaScript(EXTRACT_SCRIPT);
        debugLog(`로그인 후 사용량 추출: ok=${result.ok}`);
        workerWin.hide();
        sendToWidget(result);
      }
    } catch (e) {
      debugLog(`로그인 체크 오류(시도 ${tries}회): ${e.message}`);
    }
  }, 3000);
}

function applyMode(mode) {
  saveState({ mode });
  if (!widgetWin) { createWidgetWindow(); }
  if (mode === 'widget') {
    widgetWin.show();
  } else {
    widgetWin.hide();
  }
}

function applyOpacity(opacity) {
  saveState({ opacity });
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.setOpacity(opacity);
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('Claude 사용량 위젯');

  const buildMenu = () => {
    const mode = getMode();
    const opacity = getOpacity();
    const opacityMenu = [1, 0.85, 0.7, 0.55].map((v) => ({
      label: `${Math.round(v * 100)}%`,
      type: 'radio',
      checked: Math.abs(opacity - v) < 0.001,
      click: () => { applyOpacity(v); tray.setContextMenu(buildMenu()); }
    }));

    return Menu.buildFromTemplate([
      {
        label: '위젯 카드로 보기',
        type: 'radio',
        checked: mode === 'widget',
        click: () => { applyMode('widget'); tray.setContextMenu(buildMenu()); }
      },
      {
        label: '트레이 아이콘으로만 보기',
        type: 'radio',
        checked: mode === 'tray',
        click: () => { applyMode('tray'); tray.setContextMenu(buildMenu()); }
      },
      { label: '위젯 투명도', submenu: opacityMenu },
      { type: 'separator' },
      { label: '지금 새로고침', click: () => pollUsage() },
      { label: '로그인 창 열기', click: () => openLoginWindow() },
      {
        label: 'Windows 시작 시 자동 실행',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (menuItem) => {
          app.setLoginItemSettings({ openAtLogin: menuItem.checked });
        }
      },
      { type: 'separator' },
      { label: '사용량 페이지 열기(브라우저)', click: () => shell.openExternal(usageUrl()) },
      { label: '디버그 로그 열기', click: () => shell.openPath(debugLogFile) },
      { type: 'separator' },
      { label: '종료', click: () => { app.quit(); } }
    ]);
  };

  tray.setContextMenu(buildMenu());
  tray.on('click', () => {
    if (getMode() !== 'widget') return; // 트레이 전용 모드에서는 좌클릭으로 창을 띄우지 않음
    if (!widgetWin) { createWidgetWindow(); return; }
    widgetWin.isVisible() ? widgetWin.hide() : widgetWin.show();
  });
}

ipcMain.on('refresh-now', () => pollUsage());
ipcMain.on('open-login', () => openLoginWindow());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!widgetWin) { createWidgetWindow(); return; }
    widgetWin.show();
    widgetWin.focus();
  });

  app.whenReady().then(() => {
    createWidgetWindow();
    createWorkerWindow();
    createTray();

    pollUsage();
    pollTimer = setInterval(pollUsage, POLL_INTERVAL_MS);
  });
}

app.on('window-all-closed', (e) => {
  // 트레이 상주 앱이므로 창이 다 닫혀도 종료하지 않음
  e.preventDefault && e.preventDefault();
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
});
