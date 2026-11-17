import { contextBridge, ipcRenderer } from 'electron';
// Expose a safe API to the React renderer
contextBridge.exposeInMainWorld('electron', {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    getPlatform: () => ipcRenderer.invoke('app:get-platform'),
    getStoragePath: () => ipcRenderer.invoke('app:get-storage-path'),
    isDev: () => ipcRenderer.invoke('app:is-dev'),
});
//# sourceMappingURL=preload.js.map