const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('areaforge', {
  generateReport: (payload) => ipcRenderer.invoke('generate-report', payload),
  saveMarkdown: (markdown) => ipcRenderer.invoke('save-markdown', markdown),
  savePdf: () => ipcRenderer.invoke('save-pdf')
});
