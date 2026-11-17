import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const rapidFireMigration: Migration = {
  id: 11,
  name: 'rapid_fire_items_and_progress',
  up(database: Database.Database) {
    database.exec(`
      CREATE TABLE rapid_fire_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        order_index INTEGER NOT NULL CHECK (order_index >= 0),
        prompt TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        UNIQUE (question_id, order_index)
      );

      CREATE TABLE session_rapid_fire_control (
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        selected_participant_id TEXT REFERENCES event_participants(id) ON DELETE RESTRICT,
        PRIMARY KEY (session_id, question_id)
      );

      CREATE TABLE session_rapid_fire_progress (
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES event_participants(id) ON DELETE RESTRICT,
        current_item_index INTEGER NOT NULL DEFAULT 0 CHECK (current_item_index >= 0),
        PRIMARY KEY (session_id, question_id, participant_id)
      );

      CREATE TABLE session_rapid_fire_results (
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES event_participants(id) ON DELETE RESTRICT,
        item_index INTEGER NOT NULL CHECK (item_index >= 0),
        status TEXT NOT NULL CHECK (status IN ('passed', 'correct', 'incorrect')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, question_id, participant_id, item_index)
      );
    `);
    const hasQuestions = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'questions'"
    ).get();
    if (hasQuestions) {
      database.exec(`
        INSERT INTO rapid_fire_items (question_id, order_index, prompt, answer_text)
        SELECT q.id, 0, q.prompt,
          COALESCE(
            (SELECT a.answer_text FROM accepted_answers a WHERE a.question_id = q.id ORDER BY a.created_at LIMIT 1),
            'Answer not configured'
          )
        FROM questions q
        WHERE q.question_type = 'rapid_fire';
      `);
    }
  },
};
