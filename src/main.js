const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { generateAreaStudy } = require('./generator');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('generate-report', async (_event, payload) => {
  return generateAreaStudy(payload);
});

ipcMain.handle('save-markdown', async (_event, markdown) => {
  const out = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Area Study Markdown',
    defaultPath: `AreaForge-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (out.canceled || !out.filePath) return { canceled: true };
  fs.writeFileSync(out.filePath, markdown, 'utf8');
  return { canceled: false, filePath: out.filePath };
});

ipcMain.handle('save-pdf', async (_event) => {
  const out = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Area Study PDF',
    defaultPath: `AreaForge-${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (out.canceled || !out.filePath) return { canceled: true };
  const data = await mainWindow.webContents.printToPDF({
    printBackground: true,
    pageSize: 'Letter',
    margins: { marginType: 'default' }
  });
  fs.writeFileSync(out.filePath, data);
  return { canceled: false, filePath: out.filePath };
});
