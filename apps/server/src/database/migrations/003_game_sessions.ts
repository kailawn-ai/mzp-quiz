import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const gameSessionsMigration: Migration = {
  id: 3,
  name: 'game_sessions_and_state',
  up(database: Database.Database) {
    database.exec(`
      CREATE TABLE quiz_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
        current_round_id TEXT REFERENCES rounds(id) ON DELETE RESTRICT,
        current_question_id TEXT REFERENCES questions(id) ON DELETE RESTRICT,
        question_state TEXT NOT NULL DEFAULT 'ready' CHECK (question_state IN ('ready', 'active', 'paused', 'expired', 'revealed', 'completed')),
        time_remaining_ms INTEGER NOT NULL DEFAULT 0 CHECK (time_remaining_ms >= 0),
        deadline_timestamp INTEGER,
        auto_advance INTEGER NOT NULL DEFAULT 0 CHECK (auto_advance IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE INDEX idx_quiz_sessions_event_id ON quiz_sessions(event_id);
      CREATE INDEX idx_quiz_sessions_status ON quiz_sessions(status);
      CREATE UNIQUE INDEX idx_quiz_sessions_active_event ON quiz_sessions(event_id) WHERE status IN ('active', 'paused');

      CREATE TABLE session_responses (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
        participant_id TEXT,
        response_text TEXT,
        is_accepted INTEGER NOT NULL DEFAULT 0 CHECK (is_accepted IN (0, 1)),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_session_responses_session_question ON session_responses(session_id, question_id);
    `);
  },
};
