import { contextBridge, ipcRenderer } from 'electron';

// Expose a safe API to the React renderer
contextBridge.exposeInMainWorld('electron', {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  getPlatform: (): Promise<string> => ipcRenderer.invoke('app:get-platform'),
  getStoragePath: (): Promise<string> => ipcRenderer.invoke('app:get-storage-path'),
  isDev: (): Promise<boolean> => ipcRenderer.invoke('app:is-dev'),
});