/**
 * preload.js — contextBridge между main и renderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Store
  save:    (key, value)    => ipcRenderer.invoke('store:save', key, value),
  load:    (key)           => ipcRenderer.invoke('store:load', key),
  delete:  (key)           => ipcRenderer.invoke('store:delete', key),
  saveAll: (snapshot)      => ipcRenderer.invoke('store:saveAll', snapshot),
  loadAll: ()              => ipcRenderer.invoke('store:loadAll'),

  // File dialog
  openFile: ()             => ipcRenderer.invoke('dialog:openFile'),

  // Clipboard
  readClipboard: ()              => ipcRenderer.invoke('clipboard:read'),
  writeImageToClipboard: (data)  => ipcRenderer.invoke('clipboard:writeImage', data),

  // fs: читать файл с диска → ArrayBuffer (для PDF viewer)
  readFile: (filePath)     => ipcRenderer.invoke('fs:readFile', filePath),

  // shell: открыть файл в системном приложении
  openPath: (filePath)     => ipcRenderer.invoke('shell:openPath', filePath),

  // PPTX → PDF через LibreOffice
  checkLibreOffice:  ()               => ipcRenderer.invoke('pptx:checkLibreOffice'),
  convertPptxToPdf:  (pptxPath, loPath) => ipcRenderer.invoke('pptx:convertToPdf', pptxPath, loPath),
  cleanupPptxTmp:    (pdfPath)        => ipcRenderer.invoke('pptx:cleanupTmp', pdfPath),

  // Fetch remote image as base64 dataURL (обходит CORS из renderer)
  fetchImageAsDataUrl: (url) => ipcRenderer.invoke('image:fetchUrl', url),

  // Gemini API proxy (обходит CSP/CORS — запрос идёт через main process)
  geminiRequest: (url, body) => ipcRenderer.invoke('gemini:request', { url, body }),

  // Shell: открыть URL во внешнем браузере
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Auto-update
  checkForUpdates: ()  => ipcRenderer.invoke('updater:checkNow'),
  quitAndInstall:  ()  => ipcRenderer.invoke('updater:quitAndInstall'),

  // Events from main → renderer
  on: (channel, cb) => {
    const allowed = ['clipboard:changed', 'updater:status'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => cb(...args));
    }
  },
});