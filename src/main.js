/**
 * src/main.js — главный процесс Knowledge Studio.
 *
 * IPC-хендлеры (соответствуют preload.js / renderer/ipc.js):
 *   store:save / store:load / store:delete / store:saveAll / store:loadAll
 *   dialog:openFile
 *   shell:saveFile / shell:openPath
 *   clipboard:read / clipboard:writeImage
 *   fs:readFile
 *   pptx:checkLibreOffice / pptx:convertToPdf / pptx:cleanupTmp
 *   image:fetchUrl
 */

'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  nativeImage,
  shell,
  net,
} = require('electron');

const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { execFile, exec } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ── Пути ──────────────────────────────────────────────────────
// __dirname = …/src/  →  index.html лежит рядом
const SRC_DIR   = __dirname;
const DATA_FILE = path.join(app.getPath('userData'), 'ks_data.json');

// ── Главное окно ───────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth:  760,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',        // macOS traffic lights
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: '#0d0d0f',
    show: false,
    webPreferences: {
      preload:          path.join(SRC_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       true,            // <webview> для browser-панели
      webSecurity:      true,
    },
  });

  mainWindow.loadFile(path.join(SRC_DIR, 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Жизненный цикл ────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  initAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ══════════════════════════════════════════════════════════════
//  AUTO-UPDATE — проверка и установка обновлений через GitHub Releases
//
//  Работает только в собранном (packaged) приложении: в `npm start`/`npm run dev`
//  autoUpdater не запускается, т.к. там нет app-update.yml.
//  Публикация релиза (npm run release) должна залить в GitHub Release
//  установщик + latest.yml, которые генерирует electron-builder.
// ══════════════════════════════════════════════════════════════

function sendToRenderer(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

function initAutoUpdater() {
  if (!app.isPackaged) return; // в dev-режиме нет смысла — нечего обновлять

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('updater:status', { state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    sendToRenderer('updater:status', { state: 'not-available' });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('updater:status', { state: 'downloading', percent: progress.percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('updater:status', { state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] error:', err.message);
    sendToRenderer('updater:status', { state: 'error', message: err.message });
  });

  // Проверка при старте (с небольшой задержкой, чтобы не мешать загрузке UI)
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);

  // Периодическая проверка — раз в 4 часа
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

ipcMain.handle('updater:checkNow', () => {
  if (!app.isPackaged) return { ok: false, reason: 'not-packaged' };
  autoUpdater.checkForUpdates().catch(() => {});
  return { ok: true };
});

ipcMain.handle('updater:quitAndInstall', () => {
  autoUpdater.quitAndInstall();
});

// ══════════════════════════════════════════════════════════════
//  STORE — персистентное хранилище (JSON-файл в userData)
//
//  Путь: ~/Library/Application Support/knowledge-studio/ks_data.json
//        %APPDATA%\knowledge-studio\ks_data.json  (Windows)
//        ~/.config/knowledge-studio/ks_data.json  (Linux)
// ══════════════════════════════════════════════════════════════

let _storeCacheLoaded = false;
let _storeCache = null;

function _readStore() {
  if (_storeCacheLoaded) return _storeCache;
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      _storeCache = JSON.parse(raw);
    }
  } catch (e) {
    console.error('[store] read error:', e.message);
  }
  _storeCacheLoaded = true;
  return _storeCache;
}

function _writeStore(data) {
  _storeCache = data;
  _storeCacheLoaded = true;
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.error('[store] write error:', e.message);
  }
}

// Сохранить одно поле
ipcMain.handle('store:save', (_e, key, value) => {
  const store = _readStore() || {};
  store[key] = value;
  _writeStore(store);
  return true;
});

// Загрузить одно поле
ipcMain.handle('store:load', (_e, key) => {
  const store = _readStore() || {};
  return store[key] ?? null;
});

// Удалить одно поле
ipcMain.handle('store:delete', (_e, key) => {
  const store = _readStore() || {};
  delete store[key];
  _writeStore(store);
  return true;
});

// Сохранить весь снимок (Persist.forceSave)
ipcMain.handle('store:saveAll', (_e, snapshot) => {
  _writeStore(snapshot);
  return true;
});

// Загрузить весь снимок (Persist.load)
ipcMain.handle('store:loadAll', () => {
  const data = _readStore();
  // null → первый запуск, renderer покажет пустое состояние
  return (data && Object.keys(data).length > 0) ? data : null;
});

// ══════════════════════════════════════════════════════════════
//  DIALOG — открытие и сохранение файлов
// ══════════════════════════════════════════════════════════════

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Все поддерживаемые',
        extensions: ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
      },
      { name: 'PDF',       extensions: ['pdf'] },
      { name: 'Word',      extensions: ['docx'] },
      { name: 'PowerPoint',extensions: ['pptx'] },
      { name: 'Excel',     extensions: ['xlsx'] },
      { name: 'Images',    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      { name: 'Text',      extensions: ['txt', 'md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result; // { canceled, filePaths }
});

// Сохранить файл (диалог «Сохранить как»)
ipcMain.handle('shell:saveFile', async (_e, { defaultName, data, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), defaultName || 'export'),
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const buf = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
    fs.writeFileSync(result.filePath, buf);
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════════════════════
//  SHELL — открытие файлов в системных приложениях
// ══════════════════════════════════════════════════════════════

ipcMain.handle('shell:openPath', async (_e, filePath) => {
  const err = await shell.openPath(filePath);
  if (err) console.error('[shell] openPath error:', err);
  return !err;
});

// ══════════════════════════════════════════════════════════════
//  CLIPBOARD
// ══════════════════════════════════════════════════════════════

ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.handle('clipboard:writeImage', (_e, dataUrl) => {
  try {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    return true;
  } catch (e) {
    console.error('[clipboard] writeImage error:', e.message);
    return false;
  }
});

// Отправляем изменения буфера в renderer раз в секунду
let _lastClipboard = '';
setInterval(() => {
  const current = clipboard.readText();
  if (current !== _lastClipboard) {
    _lastClipboard = current;
    mainWindow?.webContents.send('clipboard:changed', current);
  }
}, 1000);

// ══════════════════════════════════════════════════════════════
//  FS — чтение файлов с диска
// ══════════════════════════════════════════════════════════════

ipcMain.handle('fs:readFile', (_e, filePath) => {
  try {
    return new Uint8Array(fs.readFileSync(filePath));
  } catch (e) {
    console.error('[fs] readFile error:', e.message);
    throw e;
  }
});

// ══════════════════════════════════════════════════════════════
//  PPTX → PDF через LibreOffice
// ══════════════════════════════════════════════════════════════

const LO_PATHS = {
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  linux:  ['/usr/bin/libreoffice', '/usr/bin/soffice', '/usr/local/bin/soffice'],
  win32:  [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ],
};

ipcMain.handle('pptx:checkLibreOffice', () => {
  const paths = LO_PATHS[process.platform] || [];
  for (const p of paths) {
    if (fs.existsSync(p)) return { found: true, path: p };
  }
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'where soffice' : 'which soffice';
    exec(cmd, (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve({ found: true, path: stdout.trim().split('\n')[0] });
      } else {
        resolve({ found: false, path: null });
      }
    });
  });
});

ipcMain.handle('pptx:convertToPdf', (_e, pptxPath, loPath) => {
  // Используем безопасную temp-папку без пробелов и кириллицы.
  // На Windows os.tmpdir() может содержать кириллицу (имя пользователя),
  // что ломает LibreOffice. Используем системный TEMP/TMP или C:\Temp.
  const safeOutDir = (() => {
    if (process.platform === 'win32') {
      // Предпочитаем короткий путь без кириллицы
      const candidates = [
        process.env.TEMP && !/[^\x00-\x7F]/.test(process.env.TEMP) ? process.env.TEMP : null,
        process.env.TMP  && !/[^\x00-\x7F]/.test(process.env.TMP)  ? process.env.TMP  : null,
        'C:\\Temp',
      ].filter(Boolean);
      for (const c of candidates) {
        try { fs.mkdirSync(c, { recursive: true }); return c; } catch {}
      }
    }
    return os.tmpdir();
  })();

  // Копируем исходный файл во временную папку с ASCII-именем,
  // чтобы избежать проблем с кириллицей/пробелами в имени файла.
  const tmpName  = 'ks_pptx_' + Date.now() + '.pptx';
  const tmpInput = path.join(safeOutDir, tmpName);

  return new Promise((resolve, reject) => {
    try {
      fs.copyFileSync(pptxPath, tmpInput);
    } catch (e) {
      return reject(new Error('Не удалось скопировать файл во временную папку: ' + e.message));
    }

    execFile(loPath, ['--headless', '--convert-to', 'pdf', '--outdir', safeOutDir, tmpInput],
      { timeout: 60000 },
      (err, _stdout, stderr) => {
        // Удаляем временную копию в любом случае
        try { fs.unlinkSync(tmpInput); } catch {}

        if (err) { reject(new Error(stderr || err.message)); return; }

        const pdfPath = path.join(safeOutDir, path.basename(tmpInput, '.pptx') + '.pdf');
        fs.existsSync(pdfPath)
          ? resolve({ ok: true, pdfPath })
          : reject(new Error('PDF not found after conversion'));
      }
    );
  });
});

ipcMain.handle('pptx:cleanupTmp', (_e, pdfPath) => {
  try {
    if (pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    return true;
  } catch { return false; }
});

// ══════════════════════════════════════════════════════════════
//  IMAGE FETCH — загрузка изображения по URL (обход CORS)
//
//  Renderer не может загрузить картинки с чужих доменов из-за CORS.
//  Главный процесс не имеет этих ограничений — делаем запрос здесь
//  и возвращаем base64 dataURL.
// ══════════════════════════════════════════════════════════════

ipcMain.handle('image:fetchUrl', (_e, url) => {
  return new Promise((resolve, reject) => {
    try {
      let parsed;
      try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error('Unsupported protocol: ' + parsed.protocol));
      }

      const request = net.request({
        url,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'ru,en;q=0.9',
        },
      });

      const chunks = [];
      let contentType = 'image/jpeg';

      const timer = setTimeout(() => {
        try { request.abort(); } catch (_) {}
        reject(new Error('Timeout after 15s'));
      }, 15000);

      request.on('response', response => {
        clearTimeout(timer);

        // Следим за Content-Type
        const ct = response.headers['content-type'];
        if (ct) contentType = (Array.isArray(ct) ? ct[0] : ct).split(';')[0].trim();

        // Ошибки HTTP
        if (response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        response.on('data',  chunk => chunks.push(chunk));
        response.on('end',   () => {
          const base64 = Buffer.concat(chunks).toString('base64');
          resolve(`data:${contentType};base64,${base64}`);
        });
        response.on('error', err => reject(new Error('Response: ' + err.message)));
      });

      request.on('error', err => {
        clearTimeout(timer);
        reject(new Error('Request: ' + err.message));
      });

      request.end();
    } catch (e) {
      reject(e);
    }
  });
});
// ══════════════════════════════════════════════════════════════
//  GEMINI API — проксирование запросов через main process
//
//  Renderer не может напрямую вызвать generativelanguage.googleapis.com
//  из-за CSP и CORS. Main process не имеет этих ограничений.
//  Используем electron.net.request (не node fetch) для надёжности.
// ══════════════════════════════════════════════════════════════

// Main-процесс не должен превращаться в открытый прокси на произвольный хост —
// разрешаем запросы только к самому Gemini API.
const GEMINI_ALLOWED_HOST = 'generativelanguage.googleapis.com';

ipcMain.handle('gemini:request', (_e, { url, body }) => {
  return new Promise((resolve, reject) => {
    try {
      let parsed;
      try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }
      if (parsed.protocol !== 'https:' || parsed.hostname !== GEMINI_ALLOWED_HOST) {
        return reject(new Error('Host not allowed: ' + parsed.hostname));
      }

      console.log('[gemini:request] url:', url.slice(0, 80));

      const request = net.request({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8').toString(),
        },
        useSessionCookies: false,
      });

      const chunks = [];
      let statusCode = 200;
      let statusMessage = '';

      const timer = setTimeout(() => {
        try { request.abort(); } catch (_) {}
        reject(new Error('Gemini request timeout after 60s'));
      }, 60000);

      request.on('response', response => {
        statusCode = response.statusCode;
        statusMessage = response.statusMessage || '';
        console.log('[gemini:request] status:', statusCode);

        response.on('data',  chunk => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          console.log('[gemini:request] response len:', text.length, 'ok:', statusCode < 300);
          resolve({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, statusText: statusMessage, text });
        });
        response.on('error', err => {
          clearTimeout(timer);
          reject(new Error('Gemini response error: ' + err.message));
        });
      });

      request.on('error', err => {
        clearTimeout(timer);
        console.error('[gemini:request] net error:', err.message);
        reject(new Error('Gemini net error: ' + err.message));
      });

      // Buffer явно — некоторые версии Electron не принимают строку в write()
      request.write(Buffer.from(body, 'utf8'));
      request.end();
    } catch (e) {
      console.error('[gemini:request] catch:', e.message);
      reject(e);
    }
  });
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  return shell.openExternal(url);
});