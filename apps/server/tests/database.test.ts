import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database/database.js';
import { runMigrations } from '../src/database/migrate.js';
import { migrations } from '../src/database/migrate.js';
import { createRepositories } from '../src/database/repositories.js';
import { removeTemporaryDatabase, temporaryDatabase } from './test-utils.js';

const fixtures: ReturnType<typeof temporaryDatabase>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) { if (fixture.database.connection.open) fixture.database.close(); removeTemporaryDatabase(fixture.directory); } });

const eventInput = { title: 'Community Quiz', description: 'A local event', settings: { theme: 'blue' } };
const roundInput = { name: 'General Knowledge', roundType: 'quick_questions' as const, orderIndex: 0, configuration: { shuffle: true } };
const questionInput = { questionType: 'short_answer' as const, prompt: 'What is 2 + 2?', durationMs: 30000, points: 10, penaltyPoints: 0, orderIndex: 0 };

describe('SQLite foundation', () => {
  it('applies the new migration to a legacy database without changing existing records', () => {
    const legacy = new Database(':memory:');
    legacy.pragma('foreign_keys = ON');
    legacy.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const migration of migrations.slice(0, 3)) {
      migration.up(legacy);
      legacy.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(migration.id, migration.name, 1);
    }
    legacy.prepare('INSERT INTO events (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('legacy-event', 'Legacy event', 1, 1);
    legacy.prepare(`
      INSERT INTO rounds (id, event_id, name, round_type, order_index, configuration_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-round', 'legacy-event', 'Legacy round', 'quick_questions', 0, '{}', 1, 1);
    legacy.prepare(`
      INSERT INTO questions
        (id, round_id, question_type, prompt, duration_ms, points, penalty_points, order_index, status, manual_judging, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-question', 'legacy-round', 'rapid_fire', 'Preserved prompt', 1000, 8, 0, 0, 'ready', 0, 1, 1);
    legacy.prepare(`
      INSERT INTO accepted_answers (id, question_id, answer_text, normalized_answer, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-answer', 'legacy-question', 'Answer', 'answer', 1);

    expect(runMigrations(legacy)).toEqual({ applied: 12, current: 12 });
    expect(legacy.prepare('SELECT title FROM events WHERE id = ?').get('legacy-event')).toEqual({ title: 'Legacy event' });
    expect(legacy.prepare('SELECT prompt, scoring_json FROM questions WHERE id = ?').get('legacy-question')).toEqual({
      prompt: 'Preserved prompt',
      scoring_json: '{}',
    });
    expect(legacy.prepare('SELECT answer_text FROM accepted_answers WHERE id = ?').get('legacy-answer')).toEqual({ answer_text: 'Answer' });
    expect(legacy.prepare('SELECT order_index, prompt, answer_text FROM rapid_fire_items WHERE question_id = ?')
      .get('legacy-question')).toEqual({ order_index: 0, prompt: 'Preserved prompt', answer_text: 'Answer' });
    legacy.close();
  });

  it('initializes migrations and can safely run them repeatedly', () => {
    const fixture = temporaryDatabase(); fixtures.push(fixture);
    expect(fixture.database.connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(fixture.database.connection.prepare('SELECT count(*) as count FROM schema_migrations').get()).toEqual({ count: 12 });
    expect(runMigrations(fixture.database.connection)).toEqual({ applied: 12, current: 12 });
    expect(fixture.database.connection.prepare('SELECT count(*) as count FROM schema_migrations').get()).toEqual({ count: 12 });
  });

  it('repairs buzzer tables created by the earlier scoring schema', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE score_transactions (id TEXT PRIMARY KEY NOT NULL, points_delta INTEGER NOT NULL);
      CREATE TABLE buzzer_requests (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, question_id TEXT NOT NULL);
    `);
    legacy.transaction(() => {
      for (let id = 1; id <= 5; id++) legacy.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(id, String(id), 1);
    })();

    expect(runMigrations(legacy)).toEqual({ applied: 12, current: 12 });
    expect((legacy.prepare('PRAGMA table_info(buzzer_requests)').all() as Array<{ name: string }>).some((column) => column.name === 'score_generation')).toBe(true);
    expect((legacy.prepare('PRAGMA table_info(score_transactions)').all() as Array<{ name: string }>).some((column) => column.name === 'generation')).toBe(true);
    legacy.close();
  });

  it('repairs score transactions missing their generation column without losing scores', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
      CREATE TABLE score_transactions (id TEXT PRIMARY KEY NOT NULL, points_delta INTEGER NOT NULL);
      INSERT INTO score_transactions (id, points_delta) VALUES ('score-1', 42);
    `);
    legacy.transaction(() => {
      for (let id = 1; id <= 7; id++) {
        legacy.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(id, String(id), 1);
      }
    })();

    expect(runMigrations(legacy)).toEqual({ applied: 12, current: 12 });
    expect(legacy.prepare('SELECT points_delta, generation FROM score_transactions WHERE id = ?').get('score-1'))
      .toEqual({ points_delta: 42, generation: 0 });
    legacy.close();
  });

  it('creates and retrieves event, round, question, answers and choices', () => {
    const fixture = temporaryDatabase(); fixtures.push(fixture); const repositories = createRepositories(fixture.database.connection);
    const event = repositories.createEvent(eventInput); const round = repositories.createRound(event.id, roundInput); const question = repositories.createQuestion(round.id, questionInput);
    const answer = repositories.createAcceptedAnswer(question.id, { answerText: ' 4 ', judgeNotes: 'Exact answer' });
    const choice = repositories.createChoice(question.id, { choiceText: 'Four', orderIndex: 0 });
    expect(repositories.getEvent(event.id)?.settings).toEqual({ theme: 'blue' });
    expect(repositories.listRounds(event.id)).toHaveLength(1); expect(repositories.listQuestions(round.id)).toHaveLength(1);
    expect(repositories.listAcceptedAnswers(question.id)[0]).toMatchObject({ id: answer.id, normalizedAnswer: '4' });
    expect(repositories.listChoices(question.id)[0]).toMatchObject({ id: choice.id, choiceText: 'Four' });
  });

  it('enforces relationships, rejects invalid input and keeps parameterized values as data', () => {
    const fixture = temporaryDatabase(); fixtures.push(fixture); const repositories = createRepositories(fixture.database.connection);
    expect(() => repositories.createEvent({ title: 'x' })).toThrow();
    const event = repositories.createEvent({ title: "'); DROP TABLE events; --" });
    expect(repositories.getEvent(event.id)?.title).toContain('DROP TABLE');
    expect(repositories.getEvent('missing')).toBeNull();
    expect(() => fixture.database.connection.prepare('INSERT INTO rounds (id, event_id, name, round_type, order_index, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('bad', 'missing', 'Bad', 'quick_questions', 0, '{}', 1, 1)).toThrow();
    expect(fixture.database.connection.prepare('SELECT count(*) as count FROM events').get()).toEqual({ count: 1 });
  });

  it('preserves data after closing and reopening the database', () => {
    const fixture = temporaryDatabase(); fixtures.push(fixture); const repositories = createRepositories(fixture.database.connection);
    const event = repositories.createEvent(eventInput); const databasePath = fixture.database.paths.databasePath; fixture.database.close();
    const persistent = createDatabase({ databasePath, dataDir: path.dirname(databasePath) });
    expect(createRepositories(persistent.connection).getEvent(event.id)?.title).toBe('Community Quiz');
    persistent.close();
  });

  it('stores protected multiple-choice correctness and rolls back related writes on failure', () => {
    const fixture = temporaryDatabase(); fixtures.push(fixture); const repositories = createRepositories(fixture.database.connection);
    const event = repositories.createEvent(eventInput); const round = repositories.createRound(event.id, roundInput);
    const question = repositories.createQuestion(round.id, { ...questionInput, questionType: 'multiple_choice', choices: [{ choiceText: 'Three', orderIndex: 0, isCorrect: false }, { choiceText: 'Four', orderIndex: 1, isCorrect: true }] });
    expect(repositories.listQuestions(round.id)[0].correctValue).toBeNull();
    expect(repositories.getQuestionAdmin(question.id)?.choices.find((choice) => choice.isCorrect)?.choiceText).toBe('Four');
    expect(() => repositories.createQuestion(round.id, { ...questionInput, orderIndex: 1, choices: [{ choiceText: 'A', orderIndex: 0, isCorrect: false }, { choiceText: 'B', orderIndex: 0, isCorrect: true }] })).toThrow();
    expect(repositories.listQuestions(round.id)).toHaveLength(1);
  });

  it('updates and duplicates questions as drafts with a new order', () => {
    const fixture = temporaryDatabase(); fixtures.push(fixture); const repositories = createRepositories(fixture.database.connection);
    const event = repositories.createEvent(eventInput); const round = repositories.createRound(event.id, roundInput);
    const original = repositories.createQuestion(round.id, { ...questionInput, acceptedAnswers: [{ answerText: ' Four ' }] });
    const updated = repositories.updateQuestion(original.id, { ...questionInput, prompt: 'Updated prompt', acceptedAnswers: [{ answerText: '4' }] });
    expect(updated?.prompt).toBe('Updated prompt'); expect(repositories.getQuestionAdmin(original.id)?.acceptedAnswers[0].normalizedAnswer).toBe('4');
    const duplicate = repositories.duplicateQuestion(original.id);
    expect(duplicate?.status).toBe('draft'); expect(duplicate?.orderIndex).toBe(1); expect(repositories.getQuestionAdmin(duplicate!.id)?.acceptedAnswers).toHaveLength(1);
  });
});
