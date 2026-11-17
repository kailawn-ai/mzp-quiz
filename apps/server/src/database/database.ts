import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getStoragePaths, type StoragePaths } from './paths.js';
import { runMigrations } from './migrate.js';

export type DatabaseHandle = { connection: Database.Database; paths: StoragePaths; migrationsApplied: number; close: () => void; health: () => { connected: boolean; migrationsApplied: number } };

export function createDatabase(options: { dataDir?: string; databasePath?: string } = {}): DatabaseHandle {
  const paths = getStoragePaths(options.dataDir);
  const databasePath = options.databasePath ?? paths.databasePath;
  const resolvedPaths = { ...paths, databasePath };
  for (const directory of [paths.dataDir, paths.mediaDir, paths.backupsDir, paths.logsDir]) fs.mkdirSync(directory, { recursive: true });
  const connection = new Database(databasePath);
  try {
    connection.pragma('foreign_keys = ON');
    connection.pragma('journal_mode = WAL');
    const migrationStatus = runMigrations(connection);
    return {
      connection,
      paths: resolvedPaths,
      migrationsApplied: migrationStatus.current,
      close: () => connection.close(),
      health: () => ({ connected: connection.open, migrationsApplied: migrationStatus.current }),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
