import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const competitionScoringMigration: Migration = {
  id: 4,
  name: 'competition_participants_answers_and_scores',
  up(database: Database.Database) {
    database.exec(`
      ALTER TABLE questions ADD COLUMN scoring_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE events ADD COLUMN score_generation INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE event_participants (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        participant_type TEXT NOT NULL CHECK (participant_type IN ('team', 'contestant')),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
        normalized_identity TEXT NOT NULL,
        team_identifier TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (event_id, normalized_identity)
      );
      CREATE INDEX idx_event_participants_event_enabled ON event_participants(event_id, enabled);

      CREATE TABLE answer_submissions (
        id TEXT PRIMARY KEY NOT NULL,
        participant_id TEXT NOT NULL REFERENCES event_participants(id) ON DELETE RESTRICT,
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE RESTRICT,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
        request_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        response_text TEXT,
        normalized_answer TEXT,
        choice_id TEXT REFERENCES question_choices(id) ON DELETE RESTRICT,
        boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
        is_correct INTEGER CHECK (is_correct IN (0, 1)),
        award_points INTEGER NOT NULL DEFAULT 0,
        score_generation INTEGER NOT NULL DEFAULT 0,
        is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
        submitted_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_answer_submissions_current
        ON answer_submissions(participant_id, question_id) WHERE is_current = 1;
      CREATE INDEX idx_answer_submissions_session_question
        ON answer_submissions(session_id, question_id, submitted_at);

      CREATE TABLE score_transactions (
        id TEXT PRIMARY KEY NOT NULL,
        participant_id TEXT NOT NULL REFERENCES event_participants(id) ON DELETE RESTRICT,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        session_id TEXT REFERENCES quiz_sessions(id) ON DELETE RESTRICT,
        round_id TEXT REFERENCES rounds(id) ON DELETE RESTRICT,
        question_id TEXT REFERENCES questions(id) ON DELETE RESTRICT,
        submission_id TEXT REFERENCES answer_submissions(id) ON DELETE RESTRICT,
        buzzer_request_id TEXT REFERENCES buzzer_requests(id) ON DELETE RESTRICT,
        transaction_type TEXT NOT NULL CHECK (transaction_type IN ('answer', 'reversal', 'buzzer', 'admin_adjustment', 'reset')),
        points_delta INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_score_transactions_submission_type
        ON score_transactions(submission_id, transaction_type)
        WHERE submission_id IS NOT NULL AND transaction_type IN ('answer', 'reversal');
      CREATE UNIQUE INDEX idx_score_transactions_buzzer
        ON score_transactions(buzzer_request_id)
        WHERE buzzer_request_id IS NOT NULL;
      CREATE INDEX idx_score_transactions_event_participant
        ON score_transactions(event_id, participant_id, created_at);
      CREATE INDEX idx_score_transactions_round
        ON score_transactions(event_id, round_id, participant_id);

      CREATE TABLE buzzer_requests (
        id TEXT PRIMARY KEY NOT NULL,
        participant_id TEXT NOT NULL REFERENCES event_participants(id) ON DELETE RESTRICT,
        session_id TEXT NOT NULL REFERENCES quiz_sessions(id) ON DELETE RESTRICT,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
        accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
        score_generation INTEGER NOT NULL DEFAULT 0,
        requested_at INTEGER NOT NULL,
        UNIQUE (participant_id, session_id, question_id)
      );
      CREATE UNIQUE INDEX idx_buzzer_single_winner
        ON buzzer_requests(session_id, question_id) WHERE accepted = 1;
      CREATE INDEX idx_buzzer_requests_question
        ON buzzer_requests(session_id, question_id, requested_at);

      CREATE TABLE score_reset_audits (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        prior_generation INTEGER NOT NULL,
        new_generation INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (event_id, new_generation)
      );
    `);
  },
};
