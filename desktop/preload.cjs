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
  /** Browser connector requests forwarded from 127.0.0.1:23129 */
  onConnectorRequest(handler) {
    ipcRenderer.on('paperbridge:connector-req', async (_event, { id, action, payload }) => {
      try {
        const data = await handler(action, payload);
        ipcRenderer.send('paperbridge:connector-res', { id, ok: true, data });
      } catch (e) {
        ipcRenderer.send('paperbridge:connector-res', { id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  },
});
