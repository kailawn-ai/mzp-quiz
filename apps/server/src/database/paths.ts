import os from 'node:os';
import path from 'node:path';

export type StoragePaths = { dataDir: string; databasePath: string; mediaDir: string; backupsDir: string; logsDir: string };

export function getStoragePaths(configuredDataDir = process.env.MZP_DATA_DIR): StoragePaths {
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : process.env.NODE_ENV !== 'production'
      ? path.resolve(process.cwd(), '.local-data')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'MZP Quiz')
        : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'mzp-quiz');

  return {
    dataDir,
    databasePath: path.join(dataDir, 'database.sqlite'),
    mediaDir: path.join(dataDir, 'media'),
    backupsDir: path.join(dataDir, 'backups'),
    logsDir: path.join(dataDir, 'logs'),
  };
}
