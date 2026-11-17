import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const stagedQuestionRevealMigration: Migration = {
  id: 10,
  name: 'staged_question_reveal',
  up(database: Database.Database) {
    database.exec(`
      CREATE TABLE session_question_reveals (
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        question_revealed INTEGER NOT NULL DEFAULT 0,
        revealed_choice_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, question_id)
      );
    `);
  },
};
