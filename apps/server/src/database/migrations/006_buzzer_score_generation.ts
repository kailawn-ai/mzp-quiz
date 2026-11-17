import type Database from 'better-sqlite3';
import type { Migration } from './001_initial.js';

export const buzzerScoreGenerationMigration: Migration = {
  id: 6,
  name: 'buzzer_score_generation',
  up(database: Database.Database) {
    const columns = database.prepare('PRAGMA table_info(buzzer_requests)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'score_generation')) {
      database.exec('ALTER TABLE buzzer_requests ADD COLUMN score_generation INTEGER NOT NULL DEFAULT 0');
    }
    database.exec('CREATE INDEX IF NOT EXISTS idx_buzzer_requests_generation ON buzzer_requests(session_id, question_id, score_generation)');
  },
};
