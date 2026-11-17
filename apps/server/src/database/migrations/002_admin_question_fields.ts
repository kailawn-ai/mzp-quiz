import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const adminQuestionMigration: Migration = {
  id: 2,
  name: 'admin_question_fields_and_types',
  up(database: Database.Database) {
    database.exec(`
      CREATE TABLE rounds_v2 (
        id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
        round_type TEXT NOT NULL CHECK (round_type IN ('quick_questions', 'rapid_fire', 'multiple_choice', 'buzzer', 'written_answer', 'true_false', 'image_audio_clue', 'bonus_round', 'tie_breaker')),
        order_index INTEGER NOT NULL CHECK (order_index >= 0), configuration_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (event_id, order_index), UNIQUE (event_id, name)
      );
      INSERT INTO rounds_v2 SELECT id, event_id, name, round_type, order_index, configuration_json, created_at, updated_at FROM rounds;
      CREATE TABLE questions_v2 (
        id TEXT PRIMARY KEY NOT NULL, round_id TEXT NOT NULL REFERENCES rounds_v2(id) ON DELETE RESTRICT,
        question_type TEXT NOT NULL CHECK (question_type IN ('short_answer', 'quick_question', 'rapid_fire', 'multiple_choice', 'buzzer', 'written_answer', 'true_false', 'image_audio_clue', 'bonus_round', 'tie_breaker')),
        prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 10000), explanation TEXT, media_path TEXT,
        duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 100 AND 86400000), points INTEGER NOT NULL CHECK (points >= 0), penalty_points INTEGER NOT NULL CHECK (penalty_points >= 0), order_index INTEGER NOT NULL CHECK (order_index >= 0),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'retired')), manual_judging INTEGER NOT NULL DEFAULT 0 CHECK (manual_judging IN (0, 1)), correct_value INTEGER CHECK (correct_value IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (round_id, order_index)
      );
      INSERT INTO questions_v2 (id, round_id, question_type, prompt, explanation, media_path, duration_ms, points, penalty_points, order_index, status, created_at, updated_at)
        SELECT id, round_id, question_type, prompt, explanation, media_path, duration_ms, points, penalty_points, order_index, status, created_at, updated_at FROM questions;
      CREATE TABLE accepted_answers_v2 (
        id TEXT PRIMARY KEY NOT NULL, question_id TEXT NOT NULL REFERENCES questions_v2(id) ON DELETE RESTRICT, answer_text TEXT NOT NULL CHECK (length(answer_text) BETWEEN 1 AND 1000), normalized_answer TEXT NOT NULL, judge_notes TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO accepted_answers_v2 SELECT id, question_id, answer_text, normalized_answer, judge_notes, created_at FROM accepted_answers;
      CREATE TABLE question_choices_v2 (
        id TEXT PRIMARY KEY NOT NULL, question_id TEXT NOT NULL REFERENCES questions_v2(id) ON DELETE RESTRICT, choice_text TEXT NOT NULL CHECK (length(choice_text) BETWEEN 1 AND 1000), order_index INTEGER NOT NULL CHECK (order_index >= 0), is_correct INTEGER NOT NULL DEFAULT 0 CHECK (is_correct IN (0, 1)), created_at INTEGER NOT NULL, UNIQUE (question_id, order_index)
      );
      INSERT INTO question_choices_v2 (id, question_id, choice_text, order_index, created_at) SELECT id, question_id, choice_text, order_index, created_at FROM question_choices;
      DROP TABLE question_choices; DROP TABLE accepted_answers; DROP TABLE questions; DROP TABLE rounds;
      ALTER TABLE rounds_v2 RENAME TO rounds; ALTER TABLE questions_v2 RENAME TO questions; ALTER TABLE accepted_answers_v2 RENAME TO accepted_answers; ALTER TABLE question_choices_v2 RENAME TO question_choices;
      CREATE INDEX idx_rounds_event_id ON rounds(event_id); CREATE INDEX idx_questions_round_id ON questions(round_id); CREATE INDEX idx_accepted_answers_question_id ON accepted_answers(question_id); CREATE INDEX idx_question_choices_question_id ON question_choices(question_id);
    `);
  },
};
