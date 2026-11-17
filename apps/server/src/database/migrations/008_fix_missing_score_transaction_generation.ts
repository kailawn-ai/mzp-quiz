import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const fixMissingScoreTransactionGenerationMigration: Migration = {
  id: 8,
  name: 'fix_missing_score_transaction_generation',
  up(database: Database.Database) {
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'score_transactions'",
    ).get();
    if (!tables) return;

    const columns = database.prepare('PRAGMA table_info(score_transactions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'generation')) {
      database.exec('ALTER TABLE score_transactions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    }
  },
};
