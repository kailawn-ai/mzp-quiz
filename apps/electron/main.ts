import { app, BrowserWindow, dialog, screen } from 'electron';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

function getPaths() {
  if (isDev) {
    return {
      webDist: path.join(__dirname, '..', 'web', 'dist'),
      serverEntry: path.join(__dirname, '..', 'server', 'dist', 'index.js'),
    };
  }
  const appRoot = path.dirname(app.getAppPath());
  return {
    webDist: path.join(appRoot, 'web', 'dist'),
    serverEntry: path.join(appRoot, 'server', 'dist', 'index.js'),
  };
}

const paths = getPaths();
let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(paths.serverEntry)) {
      reject(new Error(`Server build not found at ${paths.serverEntry}`));
      return;
    }

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '3001',
      HOST: '127.0.0.1',
      // Run the bundled server as a Node process, not as a second Electron app.
      ELECTRON_RUN_AS_NODE: '1',
    };

    serverProcess = spawn(process.execPath, [paths.serverEntry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (serverProcess.stdout) {
      serverProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        process.stdout.write(`[server] ${output}`);
      });
    }

    if (serverProcess.stderr) {
      serverProcess.stderr.on('data', (data: Buffer) => {
        process.stderr.write(`[server-err] ${data.toString()}`);
      });
    }

    serverProcess.on('error', (error: Error) => {
      console.error('[electron] Failed to start server:', error);
      reject(error);
    });

    serverProcess.on('exit', (code: number | null, signal: string | null) => {
      console.log(`[electron] Server exited: code=${code} signal=${signal}`);
      serverProcess = null;
    });

    const deadline = Date.now() + 15_000;
    const waitForHealth = async () => {
      while (Date.now() < deadline) {
        if (!serverProcess) {
          reject(new Error('The local server exited before it became ready.'));
          return;
        }
        try {
          const response = await fetch('http://127.0.0.1:3001/api/health');
          if (response.ok) {
            resolve();
            return;
          }
        } catch {
          // The server is still initializing.
        }
        await new Promise((retry) => setTimeout(retry, 150));
      }
      reject(new Error('The local server did not become ready within 15 seconds.'));
    };
    void waitForHealth();
  });
}

function createWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1440, width - 80),
    height: Math.min(900, height - 80),
    minWidth: 1024,
    minHeight: 768,
    title: 'MZP Quiz',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (isDev) {
    mainWindow.setMenuBarVisibility(true);
  } else {
    mainWindow.removeMenu();
  }

  const indexPath = path.join(paths.webDist, 'index.html');

  if (!fs.existsSync(indexPath)) {
    dialog.showErrorBox(
      'MZP Quiz - Missing Files',
      `Web application files not found at:\n${indexPath}\n\nPlease rebuild the application.`
    );
    app.quit();
    return mainWindow;
  }

  mainWindow.loadFile(indexPath);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (error) {
    console.error('[electron] Startup failed:', error);
    dialog.showErrorBox(
      'MZP Quiz - Startup Error',
      `Failed to start the application:\n\n${(error as Error).message}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }, 5000).unref();
  }
});

process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
