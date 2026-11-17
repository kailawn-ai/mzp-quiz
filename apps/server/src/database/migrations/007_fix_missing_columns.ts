import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

// Defensive migration: ensures score_generation exists on events and buzzer_requests
// in case migration 004 was partially applied or skipped on an existing DB.
export const fixMissingColumnsMigration: Migration = {
  id: 7,
  name: 'fix_missing_score_generation_columns',
  up(database: Database.Database) {
    const eventCols = database.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === 'score_generation')) {
      database.exec('ALTER TABLE events ADD COLUMN score_generation INTEGER NOT NULL DEFAULT 0');
    }
    // answer_submissions.score_generation (should be from migration 004)
    const submissionCols = database.prepare('PRAGMA table_info(answer_submissions)').all() as Array<{ name: string }>;
    if (submissionCols.length > 0 && !submissionCols.some((c) => c.name === 'score_generation')) {
      database.exec('ALTER TABLE answer_submissions ADD COLUMN score_generation INTEGER NOT NULL DEFAULT 0');
    }
  },
};
