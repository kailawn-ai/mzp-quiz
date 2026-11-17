import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseHandle } from './database.js';

export async function createDatabaseBackup(database: DatabaseHandle, destination?: string): Promise<string> {
  const file = destination ?? path.join(database.paths.backupsDir, `database-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await database.connection.backup(file);
  return file;
}

export function restoreDatabaseBackup(database: DatabaseHandle, source: string): void {
  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedSource)) throw new Error(`Backup not found: ${resolvedSource}`);
  const validation = new Database(resolvedSource, { readonly: true, fileMustExist: true });
  try {
    const result = validation.prepare('PRAGMA integrity_check').pluck().get();
    if (result !== 'ok') throw new Error('Backup failed SQLite integrity check.');
  } finally {
    validation.close();
  }
  const destination = database.paths.databasePath;
  const temporary = `${destination}.restore-${process.pid}-${Date.now()}`;
  fs.copyFileSync(resolvedSource, temporary);
  database.close();
  fs.renameSync(temporary, destination);
}
