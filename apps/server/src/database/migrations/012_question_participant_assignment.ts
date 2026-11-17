import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const questionParticipantAssignmentMigration: Migration = {
  id: 12,
  name: 'question_participant_assignment',
  up(database: Database.Database) {
    const hasQuestions = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'questions'").get();
    if (!hasQuestions) return;
    database.exec('ALTER TABLE questions ADD COLUMN assigned_participant_id TEXT REFERENCES event_participants(id) ON DELETE SET NULL');
    database.exec('CREATE INDEX idx_questions_assigned_participant ON questions(assigned_participant_id)');
  },
};
