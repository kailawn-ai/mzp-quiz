import { createDatabase } from './database.js';
import { createDatabaseBackup, restoreDatabaseBackup } from './backup.js';

try {
  const database = createDatabase();
  const command = process.argv[2] ?? 'migrate';
  if (command === 'backup') {
    const backup = await createDatabaseBackup(database, process.argv[3]);
    console.log(`Database backup created at ${backup}`);
    database.close();
  } else if (command === 'restore') {
    if (!process.argv[3]) throw new Error('Usage: npm run db:restore -- /path/to/backup.sqlite');
    restoreDatabaseBackup(database, process.argv[3]);
    console.log(`Database restored from ${process.argv[3]}. Restart the server before using it.`);
  } else {
    console.log(`Database ready at ${database.paths.databasePath}; ${database.migrationsApplied} migration(s) applied.`);
    database.close();
  }
} catch (error) {
  console.error('Database migration failed. Existing database files were not reset.', error instanceof Error ? error.message : error);
  process.exit(1);
}
