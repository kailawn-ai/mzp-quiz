import type Database from 'better-sqlite3';

export type Migration = { id: number; name: string; up: (database: Database.Database) => void };

export const migrations: Migration[] = [{
  id: 1,
  name: 'initial_quiz_entities',
  up(database) {
    database.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'completed', 'archived')),
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE rounds (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
        round_type TEXT NOT NULL CHECK (round_type IN ('quick_questions', 'rapid_fire', 'multiple_choice', 'buzzer', 'tie_breaker')),
        order_index INTEGER NOT NULL CHECK (order_index >= 0),
        configuration_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (event_id, order_index),
        UNIQUE (event_id, name)
      );
      CREATE TABLE questions (
        id TEXT PRIMARY KEY NOT NULL,
        round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE RESTRICT,
        question_type TEXT NOT NULL CHECK (question_type IN ('short_answer', 'multiple_choice', 'true_false', 'buzzer')),
        prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 10000),
        explanation TEXT,
        media_path TEXT,
        duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 100 AND 86400000),
        points INTEGER NOT NULL CHECK (points >= 0),
        penalty_points INTEGER NOT NULL CHECK (penalty_points >= 0),
        order_index INTEGER NOT NULL CHECK (order_index >= 0),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'retired')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (round_id, order_index)
      );
      CREATE TABLE accepted_answers (
        id TEXT PRIMARY KEY NOT NULL,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
        answer_text TEXT NOT NULL CHECK (length(answer_text) BETWEEN 1 AND 1000),
        normalized_answer TEXT NOT NULL,
        judge_notes TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE question_choices (
        id TEXT PRIMARY KEY NOT NULL,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
        choice_text TEXT NOT NULL CHECK (length(choice_text) BETWEEN 1 AND 1000),
        order_index INTEGER NOT NULL CHECK (order_index >= 0),
        created_at INTEGER NOT NULL,
        UNIQUE (question_id, order_index)
      );
      CREATE INDEX idx_rounds_event_id ON rounds(event_id);
      CREATE INDEX idx_questions_round_id ON questions(round_id);
      CREATE INDEX idx_accepted_answers_question_id ON accepted_answers(question_id);
      CREATE INDEX idx_question_choices_question_id ON question_choices(question_id);
    `);
  },
}];
