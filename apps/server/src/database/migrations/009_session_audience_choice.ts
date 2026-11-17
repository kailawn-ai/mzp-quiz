import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const sessionAudienceChoiceMigration: Migration = {
  id: 9,
  name: 'session_audience_choice',
  up(database: Database.Database) {
    database.exec(`
      CREATE TABLE session_audience_choices (
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        choice_id TEXT NOT NULL REFERENCES question_choices(id) ON DELETE RESTRICT,
        confirmed_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, question_id)
      );
    `);
  },
};
