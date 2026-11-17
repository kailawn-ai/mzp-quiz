import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const sessionScopedAnswersMigration: Migration = {
  id: 5,
  name: 'session_scoped_answer_submissions',
  up(database: Database.Database) {
    database.exec(`
      ALTER TABLE answer_submissions ADD COLUMN elapsed_ms INTEGER;
      DROP INDEX idx_answer_submissions_current;
      CREATE UNIQUE INDEX idx_answer_submissions_current
        ON answer_submissions(participant_id, session_id, question_id)
        WHERE is_current = 1;
    `);
  },
};
