import type Database from 'better-sqlite3';
import { migrations as initialMigrations } from './migrations/001_initial.js';
import { adminQuestionMigration } from './migrations/002_admin_question_fields.js';
import { gameSessionsMigration } from './migrations/003_game_sessions.js';
import { competitionScoringMigration } from './migrations/004_competition_scoring.js';
import { sessionScopedAnswersMigration } from './migrations/005_session_scoped_answers.js';
import { buzzerScoreGenerationMigration } from './migrations/006_buzzer_score_generation.js';
import { fixMissingColumnsMigration } from './migrations/007_fix_missing_columns.js';
import { fixMissingScoreTransactionGenerationMigration } from './migrations/008_fix_missing_score_transaction_generation.js';
import { sessionAudienceChoiceMigration } from './migrations/009_session_audience_choice.js';
import { stagedQuestionRevealMigration } from './migrations/010_staged_question_reveal.js';
import { rapidFireMigration } from './migrations/011_rapid_fire.js';
import { questionParticipantAssignmentMigration } from './migrations/012_question_participant_assignment.js';

export const migrations = [...initialMigrations, adminQuestionMigration, gameSessionsMigration, competitionScoringMigration, sessionScopedAnswersMigration, buzzerScoreGenerationMigration, fixMissingColumnsMigration, fixMissingScoreTransactionGenerationMigration, sessionAudienceChoiceMigration, stagedQuestionRevealMigration, rapidFireMigration, questionParticipantAssignmentMigration];

export function runMigrations(database: Database.Database) {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set((database.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: number }[]).map((row) => row.id));
  const apply = database.transaction(() => {
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      migration.up(database);
      database.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(migration.id, migration.name, Date.now());
    }
  });
  apply();
  return { applied: migrations.length, current: migrations.length };
}
