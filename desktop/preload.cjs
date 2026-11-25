// Exposes the built-in proxy address / token, app info and "open with" files to the page
// (window.paperbridgeDesktop).
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('paperbridge:info');
contextBridge.exposeInMainWorld('paperbridgeDesktop', {
  ...info,
  /** PDFs passed to the app (double-click / "open with" / drop on the icon); call once the page is ready */
  onOpenFiles(callback) {
    ipcRenderer.on('paperbridge:open-files', (_event, files) => callback(files));
    ipcRenderer.send('paperbridge:ready');
  },
});
