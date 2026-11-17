import Database from 'better-sqlite3';
import { getStoragePaths } from './paths.js';

const paths = getStoragePaths();
const db = new Database(paths.databasePath);

console.log('\n=== Applied Migrations ===');
const migs = db.prepare('SELECT * FROM schema_migrations ORDER BY id').all() as { id: number; name: string }[];
migs.forEach((m) => console.log(`  [${m.id}] ${m.name}`));

console.log('\n=== events table columns ===');
const cols = db.prepare("PRAGMA table_info(events)").all() as { name: string; type: string }[];
cols.forEach((c) => console.log(`  ${c.name} (${c.type})`));

db.close();
