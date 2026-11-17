import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AcceptedAnswer,
  AdminQuestionState,
  AdminSessionState,
  Event,
  PublicChoice,
  PublicQuestionState,
  PublicSessionState,
  Question,
  QuestionAdmin,
  QuestionChoice,
  RapidFireItem,
  QuestionScoring,
  QuizSession,
  Round,
  RoundSummary,
  TimerState,
} from '@mzp-quiz/shared';
import {
  acceptedAnswerCreateSchema,
  choiceCreateSchema,
  eventCreateSchema,
  eventUpdateSchema,
  questionWriteSchema,
  rapidFireItemSchema,
  roundCreateSchema,
  roundUpdateSchema,
} from '@mzp-quiz/shared';

const now = () => Date.now();
const normalizeAnswer = (answer: string) => answer.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
const parseJson = (value: string) => JSON.parse(value) as Record<string, unknown>;

type EventRow = { id: string; title: string; description: string | null; status: Event['status']; settings_json: string; created_at: number; updated_at: number };
type RoundRow = { id: string; event_id: string; name: string; round_type: Round['roundType']; order_index: number; configuration_json: string; created_at: number; updated_at: number };
type QuestionRow = { id: string; round_id: string; question_type: Question['questionType']; prompt: string; explanation: string | null; media_path: string | null; duration_ms: number; points: number; penalty_points: number; order_index: number; status: Question['status']; assigned_participant_id: string | null; manual_judging: number; correct_value: number | null; scoring_json: string; created_at: number; updated_at: number };
type AnswerRow = { id: string; question_id: string; answer_text: string; normalized_answer: string; judge_notes: string | null; created_at: number };
type ChoiceRow = { id: string; question_id: string; choice_text: string; order_index: number; is_correct: number; created_at: number };
type RapidFireItemRow = { id: number; question_id: string; order_index: number; prompt: string; answer_text: string };
type QuizSessionRow = {
  id: string;
  event_id: string;
  status: QuizSession['status'];
  current_round_id: string | null;
  current_question_id: string | null;
  question_state: QuizSession['questionState'];
  time_remaining_ms: number;
  deadline_timestamp: number | null;
  auto_advance: number;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
};

function mapEvent(row: EventRow): Event { return { id: row.id, title: row.title, description: row.description, status: row.status, settings: parseJson(row.settings_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapRound(row: RoundRow): Round { return { id: row.id, eventId: row.event_id, name: row.name, roundType: row.round_type, orderIndex: row.order_index, configuration: parseJson(row.configuration_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapQuestion(row: QuestionRow): Question { return { id: row.id, roundId: row.round_id, questionType: row.question_type, prompt: row.prompt, explanation: row.explanation, mediaPath: row.media_path, durationMs: row.duration_ms, points: row.points, penaltyPoints: row.penalty_points, orderIndex: row.order_index, status: row.status, assignedParticipantId: row.assigned_participant_id, manualJudging: Boolean(row.manual_judging), correctValue: row.correct_value === null ? null : Boolean(row.correct_value), scoring: parseJson(row.scoring_json) as QuestionScoring, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapPublicQuestion(row: QuestionRow): Question { return { ...mapQuestion(row), correctValue: null }; }
function mapAnswer(row: AnswerRow): AcceptedAnswer { return { id: row.id, questionId: row.question_id, answerText: row.answer_text, normalizedAnswer: row.normalized_answer, judgeNotes: row.judge_notes, createdAt: row.created_at }; }
function mapChoice(row: ChoiceRow): QuestionChoice { return { id: row.id, questionId: row.question_id, choiceText: row.choice_text, orderIndex: row.order_index, isCorrect: Boolean(row.is_correct), createdAt: row.created_at }; }
function mapRapidFireItem(row: RapidFireItemRow): RapidFireItem { return { id: row.id, questionId: row.question_id, orderIndex: row.order_index, prompt: row.prompt, answerText: row.answer_text }; }
function mapQuizSession(row: QuizSessionRow): QuizSession {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    currentRoundId: row.current_round_id,
    currentQuestionId: row.current_question_id,
    questionState: row.question_state,
    timeRemainingMs: row.time_remaining_ms,
    deadlineTimestamp: row.deadline_timestamp,
    autoAdvance: Boolean(row.auto_advance),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

const eventSelect = 'SELECT id, title, description, status, settings_json, created_at, updated_at FROM events';
const roundSelect = 'SELECT id, event_id, name, round_type, order_index, configuration_json, created_at, updated_at FROM rounds';
const questionSelect = 'SELECT id, round_id, question_type, prompt, explanation, media_path, duration_ms, points, penalty_points, order_index, status, assigned_participant_id, manual_judging, correct_value, scoring_json, created_at, updated_at FROM questions';
const sessionSelect = 'SELECT id, event_id, status, current_round_id, current_question_id, question_state, time_remaining_ms, deadline_timestamp, auto_advance, created_at, updated_at, ended_at FROM quiz_sessions';

export function createRepositories(database: Database.Database) {
  const mediaFullscreenSessions = new Set<string>();
  const repo = {
    isMediaFullscreen(sessionId: string): boolean {
      return mediaFullscreenSessions.has(sessionId);
    },
    setMediaFullscreen(sessionId: string, fullscreen: boolean): void {
      if (fullscreen) {
        mediaFullscreenSessions.add(sessionId);
      } else {
        mediaFullscreenSessions.delete(sessionId);
      }
    },
    reserveQuestionOrder(roundId: string, orderIndex: number, excludeId = '') {
      const conflict = database.prepare('SELECT id FROM questions WHERE round_id = ? AND order_index = ? AND id != ?').get(roundId, orderIndex, excludeId);
      if (!conflict) return;
      const rows = database.prepare('SELECT id, order_index FROM questions WHERE round_id = ? AND order_index >= ? ORDER BY order_index DESC').all(roundId, orderIndex) as Array<{ id: string; order_index: number }>;
      const shift = database.prepare('UPDATE questions SET order_index = order_index + 1 WHERE id = ?');
      for (const row of rows) shift.run(row.id);
    },
    createEvent(input: unknown): Event { const value = eventCreateSchema.parse(input); const timestamp = now(); const id = randomUUID(); database.prepare('INSERT INTO events (id, title, description, status, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, value.title, value.description ?? null, value.status, JSON.stringify(value.settings), timestamp, timestamp); return repo.getEvent(id)!; },
    updateEvent(id: string, input: unknown): Event | null { const current = repo.getEvent(id); if (!current) return null; const value = eventUpdateSchema.parse(input); const next = { title: value.title ?? current.title, description: value.description === undefined ? current.description : value.description, status: value.status ?? current.status, settings: value.settings ?? current.settings }; database.prepare('UPDATE events SET title = ?, description = ?, status = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(next.title, next.description, next.status, JSON.stringify(next.settings), now(), id); return repo.getEvent(id); },
    deleteEvent(id: string): boolean {
      if (!repo.getEvent(id)) return false;
      const remove = database.transaction(() => {
        database.prepare('DELETE FROM score_transactions WHERE event_id = ?').run(id);
        database.prepare('DELETE FROM answer_submissions WHERE session_id IN (SELECT id FROM quiz_sessions WHERE event_id = ?)').run(id);
        database.prepare('DELETE FROM buzzer_requests WHERE session_id IN (SELECT id FROM quiz_sessions WHERE event_id = ?)').run(id);
        database.prepare('DELETE FROM quiz_sessions WHERE event_id = ?').run(id);
        database.prepare('DELETE FROM event_participants WHERE event_id = ?').run(id);
        database.prepare('DELETE FROM accepted_answers WHERE question_id IN (SELECT q.id FROM questions q JOIN rounds r ON r.id = q.round_id WHERE r.event_id = ?)').run(id);
        database.prepare('DELETE FROM question_choices WHERE question_id IN (SELECT q.id FROM questions q JOIN rounds r ON r.id = q.round_id WHERE r.event_id = ?)').run(id);
        database.prepare('DELETE FROM questions WHERE round_id IN (SELECT id FROM rounds WHERE event_id = ?)').run(id);
        database.prepare('DELETE FROM rounds WHERE event_id = ?').run(id);
        database.prepare('DELETE FROM score_reset_audits WHERE event_id = ?').run(id);
        database.prepare('DELETE FROM events WHERE id = ?').run(id);
      });
      remove();
      return true;
    },
    getEvent(id: string): Event | null { const row = database.prepare(`${eventSelect} WHERE id = ?`).get(id) as EventRow | undefined; return row ? mapEvent(row) : null; },
    listEvents(): Event[] { return (database.prepare(`${eventSelect} ORDER BY created_at DESC`).all() as EventRow[]).map(mapEvent); },
    createRound(eventId: string, input: unknown): Round { const value = roundCreateSchema.parse(input); const timestamp = now(); const id = randomUUID(); database.prepare('INSERT INTO rounds (id, event_id, name, round_type, order_index, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, eventId, value.name, value.roundType, value.orderIndex, JSON.stringify(value.configuration), timestamp, timestamp); return repo.getRound(id)!; },
    updateRound(id: string, input: unknown): Round | null { const current = repo.getRound(id); if (!current) return null; const value = roundUpdateSchema.parse(input); const next = { name: value.name ?? current.name, roundType: value.roundType ?? current.roundType, orderIndex: value.orderIndex ?? current.orderIndex, configuration: value.configuration ?? current.configuration }; database.prepare('UPDATE rounds SET name = ?, round_type = ?, order_index = ?, configuration_json = ?, updated_at = ? WHERE id = ?').run(next.name, next.roundType, next.orderIndex, JSON.stringify(next.configuration), now(), id); return repo.getRound(id); },
    getRound(id: string): Round | null { const row = database.prepare(`${roundSelect} WHERE id = ?`).get(id) as RoundRow | undefined; return row ? mapRound(row) : null; },
    listRounds(eventId: string): Round[] { return (database.prepare(`${roundSelect} WHERE event_id = ? ORDER BY order_index`).all(eventId) as RoundRow[]).map(mapRound); },
    createQuestion(roundId: string, input: unknown): Question { const value = questionWriteSchema.parse(input); const id = randomUUID(); const timestamp = now(); const insert = database.transaction(() => { repo.reserveQuestionOrder(roundId, value.orderIndex); database.prepare('INSERT INTO questions (id, round_id, question_type, prompt, explanation, media_path, duration_ms, points, penalty_points, order_index, status, assigned_participant_id, manual_judging, correct_value, scoring_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, roundId, value.questionType, value.prompt, value.explanation ?? null, value.mediaPath ?? null, value.durationMs, value.points, value.penaltyPoints, value.orderIndex, value.status, value.assignedParticipantId ?? null, value.manualJudging ? 1 : 0, value.correctValue === undefined ? null : value.correctValue ? 1 : 0, JSON.stringify(value.scoring), timestamp, timestamp); repo.insertRelated(id, value.acceptedAnswers, value.choices, value.rapidFireItems); }); insert(); return repo.getQuestion(id)!; },
    updateQuestion(id: string, input: unknown): Question | null { const current = repo.getQuestion(id); if (!current) return null; const value = questionWriteSchema.parse(input); const timestamp = now(); const update = database.transaction(() => { repo.reserveQuestionOrder(current.roundId, value.orderIndex, id); database.prepare('UPDATE questions SET question_type = ?, prompt = ?, explanation = ?, media_path = ?, duration_ms = ?, points = ?, penalty_points = ?, order_index = ?, status = ?, assigned_participant_id = ?, manual_judging = ?, correct_value = ?, scoring_json = ?, updated_at = ? WHERE id = ?').run(value.questionType, value.prompt, value.explanation ?? null, value.mediaPath ?? null, value.durationMs, value.points, value.penaltyPoints, value.orderIndex, value.status, value.assignedParticipantId ?? null, value.manualJudging ? 1 : 0, value.correctValue === undefined ? null : value.correctValue ? 1 : 0, JSON.stringify(value.scoring), timestamp, id); database.prepare('DELETE FROM accepted_answers WHERE question_id = ?').run(id); database.prepare('DELETE FROM question_choices WHERE question_id = ?').run(id); database.prepare('DELETE FROM rapid_fire_items WHERE question_id = ?').run(id); repo.insertRelated(id, value.acceptedAnswers, value.choices, value.rapidFireItems); }); update(); return repo.getQuestion(id); },
    deleteQuestion(id: string): boolean { const question = repo.getQuestion(id); if (!question) return false; const used = database.prepare('SELECT 1 FROM answer_submissions WHERE question_id = ? UNION ALL SELECT 1 FROM buzzer_requests WHERE question_id = ? UNION ALL SELECT 1 FROM quiz_sessions WHERE current_question_id = ? LIMIT 1').get(id, id, id); if (used) throw new Error('QUESTION_HAS_HISTORY: Questions used in a session cannot be deleted. Retire the question instead.'); const remove = database.transaction(() => { database.prepare('DELETE FROM accepted_answers WHERE question_id = ?').run(id); database.prepare('DELETE FROM question_choices WHERE question_id = ?').run(id); database.prepare('DELETE FROM rapid_fire_items WHERE question_id = ?').run(id); database.prepare('DELETE FROM questions WHERE id = ?').run(id); }); remove(); return true; },
    insertRelated(questionId: string, answers: Array<{ answerText: string; judgeNotes?: string }>, choices: Array<{ choiceText: string; orderIndex: number; isCorrect: boolean }>, rapidFireItems: Array<{ prompt: string; answerText: string }>) { const answerStatement = database.prepare('INSERT INTO accepted_answers (id, question_id, answer_text, normalized_answer, judge_notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'); for (const answer of answers) { const value = acceptedAnswerCreateSchema.parse(answer); answerStatement.run(randomUUID(), questionId, value.answerText, normalizeAnswer(value.answerText), value.judgeNotes ?? null, now()); } const choiceStatement = database.prepare('INSERT INTO question_choices (id, question_id, choice_text, order_index, is_correct, created_at) VALUES (?, ?, ?, ?, ?, ?)'); for (const choice of choices) { const value = choiceCreateSchema.parse(choice); choiceStatement.run(randomUUID(), questionId, value.choiceText, value.orderIndex, value.isCorrect ? 1 : 0, now()); } const rapidFireStatement = database.prepare('INSERT INTO rapid_fire_items (question_id, order_index, prompt, answer_text) VALUES (?, ?, ?, ?)'); rapidFireItems.forEach((item, orderIndex) => { const value = rapidFireItemSchema.parse(item); rapidFireStatement.run(questionId, orderIndex, value.prompt, value.answerText); }); },
    getQuestion(id: string): Question | null { const row = database.prepare(`${questionSelect} WHERE id = ?`).get(id) as QuestionRow | undefined; return row ? mapQuestion(row) : null; },
    getQuestionAdmin(id: string): QuestionAdmin | null { const question = repo.getQuestion(id); if (!question) return null; return { ...question, acceptedAnswers: repo.listAcceptedAnswers(id), choices: repo.listChoices(id), rapidFireItems: repo.listRapidFireItems(id) }; },
    listQuestions(roundId: string): Question[] { return (database.prepare(`${questionSelect} WHERE round_id = ? ORDER BY order_index`).all(roundId) as QuestionRow[]).map(mapPublicQuestion); },
    listAcceptedAnswers(questionId: string): AcceptedAnswer[] { return (database.prepare('SELECT id, question_id, answer_text, normalized_answer, judge_notes, created_at FROM accepted_answers WHERE question_id = ? ORDER BY created_at').all(questionId) as AnswerRow[]).map(mapAnswer); },
    createAcceptedAnswer(questionId: string, input: unknown): AcceptedAnswer { const value = acceptedAnswerCreateSchema.parse(input); const id = randomUUID(); database.prepare('INSERT INTO accepted_answers (id, question_id, answer_text, normalized_answer, judge_notes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, questionId, value.answerText, normalizeAnswer(value.answerText), value.judgeNotes ?? null, now()); return repo.getAcceptedAnswer(id)!; },
    getAcceptedAnswer(id: string): AcceptedAnswer | null { const row = database.prepare('SELECT id, question_id, answer_text, normalized_answer, judge_notes, created_at FROM accepted_answers WHERE id = ?').get(id) as AnswerRow | undefined; return row ? mapAnswer(row) : null; },
    listChoices(questionId: string): QuestionChoice[] { return (database.prepare('SELECT id, question_id, choice_text, order_index, is_correct, created_at FROM question_choices WHERE question_id = ? ORDER BY order_index').all(questionId) as ChoiceRow[]).map(mapChoice); },
    listRapidFireItems(questionId: string): RapidFireItem[] { return (database.prepare('SELECT id, question_id, order_index, prompt, answer_text FROM rapid_fire_items WHERE question_id = ? ORDER BY order_index').all(questionId) as RapidFireItemRow[]).map(mapRapidFireItem); },
    createChoice(questionId: string, input: unknown): QuestionChoice { const value = choiceCreateSchema.parse(input); const id = randomUUID(); database.prepare('INSERT INTO question_choices (id, question_id, choice_text, order_index, is_correct, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, questionId, value.choiceText, value.orderIndex, value.isCorrect ? 1 : 0, now()); return repo.getChoice(id)!; },
    getChoice(id: string): QuestionChoice | null { const row = database.prepare('SELECT id, question_id, choice_text, order_index, is_correct, created_at FROM question_choices WHERE id = ?').get(id) as ChoiceRow | undefined; return row ? mapChoice(row) : null; },
    duplicateQuestion(id: string): Question | null { const source = repo.getQuestionAdmin(id); if (!source) return null; const max = database.prepare('SELECT COALESCE(MAX(order_index), -1) AS max_order FROM questions WHERE round_id = ?').get(source.roundId) as { max_order: number }; const payload = { questionType: source.questionType, prompt: source.prompt, explanation: source.explanation ?? undefined, mediaPath: source.mediaPath ?? undefined, durationMs: source.durationMs, points: source.points, penaltyPoints: source.penaltyPoints, orderIndex: max.max_order + 1, status: 'draft' as const, assignedParticipantId: source.assignedParticipantId, manualJudging: source.manualJudging, correctValue: source.correctValue ?? undefined, scoring: source.scoring, acceptedAnswers: source.acceptedAnswers.map((answer) => ({ answerText: answer.answerText, judgeNotes: answer.judgeNotes ?? undefined })), choices: source.choices.map((choice) => ({ choiceText: choice.choiceText, orderIndex: choice.orderIndex, isCorrect: choice.isCorrect })), rapidFireItems: source.rapidFireItems.map(({ prompt, answerText }) => ({ prompt, answerText })) }; return repo.createQuestion(source.roundId, payload); },
    reorderQuestions(roundId: string, orderedIds: string[]): Question[] { const existing = repo.listQuestions(roundId); if (existing.length !== orderedIds.length || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !existing.find((question) => question.id === id))) throw new Error('Question order must contain every question in the round exactly once.'); const reorder = database.transaction(() => { const temporaryOffset = 1000000; const update = database.prepare('UPDATE questions SET order_index = ?, updated_at = ? WHERE id = ? AND round_id = ?'); orderedIds.forEach((id, index) => update.run(temporaryOffset + index, now(), id, roundId)); orderedIds.forEach((id, index) => update.run(index, now(), id, roundId)); }); reorder(); return repo.listQuestions(roundId); },
    dashboardCounts() { const count = (table: string) => (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count; return { events: count('events'), rounds: count('rounds'), questions: count('questions') }; },

    // Game Sessions
    createSession(eventId: string, options: { autoAdvance?: boolean } = {}): QuizSession {
      const createTx = database.transaction(() => {
        const event = repo.getEvent(eventId);
        if (!event) throw new Error('EVENT_NOT_FOUND: Event not found.');
        const existing = database.prepare("SELECT id FROM quiz_sessions WHERE event_id = ? AND status IN ('active', 'paused')").get(eventId) as { id: string } | undefined;
        if (existing) throw new Error('SESSION_ALREADY_ACTIVE: An active session already exists for this event.');
        const rounds = repo.listRounds(eventId);
        if (rounds.length === 0) throw new Error('NO_ROUNDS_FOUND: Event has no rounds.');

        let selectedRound: Round | null = null;
        let selectedQuestionId: string | null = null;
        let selectedDurationMs = 0;

        for (const round of rounds) {
          let questions = database.prepare("SELECT id, duration_ms FROM questions WHERE round_id = ? AND status != 'retired' ORDER BY order_index").all(round.id) as { id: string; duration_ms: number }[];
          if (questions.length === 0) {
            questions = database.prepare('SELECT id, duration_ms FROM questions WHERE round_id = ? ORDER BY order_index').all(round.id) as { id: string; duration_ms: number }[];
          }
          if (questions.length > 0) {
            selectedRound = round;
            selectedQuestionId = questions[0].id;
            selectedDurationMs = questions[0].duration_ms;
            break;
          }
        }

        if (!selectedRound || !selectedQuestionId) {
          throw new Error('NO_QUESTIONS_FOUND: Event has no playable questions.');
        }

        const timestamp = now();
        const id = randomUUID();
        database.prepare(
          'INSERT INTO quiz_sessions (id, event_id, status, current_round_id, current_question_id, question_state, time_remaining_ms, deadline_timestamp, auto_advance, created_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, eventId, 'active', selectedRound.id, selectedQuestionId, 'ready', selectedDurationMs, null, options.autoAdvance ? 1 : 0, timestamp, timestamp, null);

        return repo.getSession(id)!;
      });
      return createTx();
    },

    getSession(id: string): QuizSession | null {
      const row = database.prepare(`${sessionSelect} WHERE id = ?`).get(id) as QuizSessionRow | undefined;
      return row ? mapQuizSession(row) : null;
    },

    getAudienceChoice(sessionId: string, questionId: string): string | null {
      const row = database.prepare(
        'SELECT choice_id FROM session_audience_choices WHERE session_id = ? AND question_id = ?'
      ).get(sessionId, questionId) as { choice_id: string } | undefined;
      return row?.choice_id ?? null;
    },

    confirmAudienceChoice(sessionId: string, questionId: string, choiceId: string): void {
      database.prepare(`
        INSERT INTO session_audience_choices (session_id, question_id, choice_id, confirmed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, question_id)
        DO UPDATE SET choice_id = excluded.choice_id, confirmed_at = excluded.confirmed_at
      `).run(sessionId, questionId, choiceId, now());
    },

    clearAudienceChoice(sessionId: string, questionId: string): void {
      database.prepare(
        'DELETE FROM session_audience_choices WHERE session_id = ? AND question_id = ?'
      ).run(sessionId, questionId);
    },

    getQuestionReveal(sessionId: string, questionId: string): { questionRevealed: boolean; revealedChoiceCount: number } {
      const row = database.prepare(
        'SELECT question_revealed, revealed_choice_count FROM session_question_reveals WHERE session_id = ? AND question_id = ?'
      ).get(sessionId, questionId) as { question_revealed: number; revealed_choice_count: number } | undefined;
      return {
        questionRevealed: Boolean(row?.question_revealed),
        revealedChoiceCount: row?.revealed_choice_count ?? 0,
      };
    },

    revealQuestion(sessionId: string, questionId: string): void {
      database.prepare(`
        INSERT INTO session_question_reveals (session_id, question_id, question_revealed, revealed_choice_count, updated_at)
        VALUES (?, ?, 1, 0, ?)
        ON CONFLICT(session_id, question_id)
        DO UPDATE SET question_revealed = 1, updated_at = excluded.updated_at
      `).run(sessionId, questionId, now());
    },

    revealNextChoice(sessionId: string, questionId: string, totalChoices: number): number {
      return database.transaction(() => {
        const reveal = repo.getQuestionReveal(sessionId, questionId);
        if (reveal.revealedChoiceCount >= totalChoices) return reveal.revealedChoiceCount;
        const nextCount = reveal.revealedChoiceCount + 1;
        database.prepare(`
          INSERT INTO session_question_reveals (session_id, question_id, question_revealed, revealed_choice_count, updated_at)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(session_id, question_id)
          DO UPDATE SET question_revealed = 1, revealed_choice_count = excluded.revealed_choice_count, updated_at = excluded.updated_at
        `).run(sessionId, questionId, nextCount, now());
        return nextCount;
      })();
    },

    clearQuestionReveal(sessionId: string, questionId: string): void {
      database.prepare(
        'DELETE FROM session_question_reveals WHERE session_id = ? AND question_id = ?'
      ).run(sessionId, questionId);
    },

    getActiveSessionForEvent(eventId: string): QuizSession | null {
      const row = database.prepare(`${sessionSelect} WHERE event_id = ? AND status IN ('active', 'paused') ORDER BY created_at DESC LIMIT 1`).get(eventId) as QuizSessionRow | undefined;
      return row ? mapQuizSession(row) : null;
    },

    listActiveSessions(): QuizSession[] {
      const rows = database.prepare(`${sessionSelect} WHERE status IN ('active', 'paused') ORDER BY created_at DESC`).all() as QuizSessionRow[];
      return rows.map(mapQuizSession);
    },

    updateSession(
      id: string,
      updates: Partial<{
        status: QuizSession['status'];
        current_round_id: string | null;
        current_question_id: string | null;
        question_state: QuizSession['questionState'];
        time_remaining_ms: number;
        deadline_timestamp: number | null;
        ended_at: number | null;
      }>
    ): QuizSession | null {
      const current = repo.getSession(id);
      if (!current) return null;

      const nextStatus = updates.status ?? current.status;
      const nextRoundId = updates.current_round_id !== undefined ? updates.current_round_id : current.currentRoundId;
      const nextQuestionId = updates.current_question_id !== undefined ? updates.current_question_id : current.currentQuestionId;
      const nextQuestionState = updates.question_state ?? current.questionState;
      const nextTimeRemaining = updates.time_remaining_ms !== undefined ? updates.time_remaining_ms : current.timeRemainingMs;
      const nextDeadline = updates.deadline_timestamp !== undefined ? updates.deadline_timestamp : current.deadlineTimestamp;
      const nextEndedAt = updates.ended_at !== undefined ? updates.ended_at : current.endedAt;

      if (updates.current_question_id !== undefined && updates.current_question_id !== current.currentQuestionId) {
        mediaFullscreenSessions.delete(id);
      }

      database.prepare(
        'UPDATE quiz_sessions SET status = ?, current_round_id = ?, current_question_id = ?, question_state = ?, time_remaining_ms = ?, deadline_timestamp = ?, ended_at = ?, updated_at = ? WHERE id = ?'
      ).run(nextStatus, nextRoundId, nextQuestionId, nextQuestionState, nextTimeRemaining, nextDeadline, nextEndedAt, now(), id);

      return repo.getSession(id);
    },

    countAcceptedResponses(sessionId: string, questionId: string): number {
      const row = database.prepare('SELECT count(*) AS count FROM session_responses WHERE session_id = ? AND question_id = ? AND is_accepted = 1').get(sessionId, questionId) as { count: number } | undefined;
      return row ? row.count : 0;
    },

    getNextQuestionAndRound(sessionId: string): {
      nextRoundId: string | null;
      nextQuestionId: string | null;
      durationMs: number;
      isCompleted: boolean;
    } {
      const session = repo.getSession(sessionId);
      if (!session || !session.currentRoundId || !session.currentQuestionId) {
        return { nextRoundId: null, nextQuestionId: null, durationMs: 0, isCompleted: true };
      }

      // Check remaining questions in current round
      let roundQuestions = database.prepare("SELECT id, duration_ms, order_index FROM questions WHERE round_id = ? AND status != 'retired' ORDER BY order_index").all(session.currentRoundId) as { id: string; duration_ms: number; order_index: number }[];
      if (roundQuestions.length === 0) {
        roundQuestions = database.prepare('SELECT id, duration_ms, order_index FROM questions WHERE round_id = ? ORDER BY order_index').all(session.currentRoundId) as { id: string; duration_ms: number; order_index: number }[];
      }

      const currentIndex = roundQuestions.findIndex((q) => q.id === session.currentQuestionId);
      if (currentIndex !== -1 && currentIndex + 1 < roundQuestions.length) {
        const nextQ = roundQuestions[currentIndex + 1];
        return { nextRoundId: session.currentRoundId, nextQuestionId: nextQ.id, durationMs: nextQ.duration_ms, isCompleted: false };
      }

      // If current round questions exhausted, check next round
      const rounds = repo.listRounds(session.eventId);
      const currentRoundIndex = rounds.findIndex((r) => r.id === session.currentRoundId);
      if (currentRoundIndex !== -1) {
        for (let rIndex = currentRoundIndex + 1; rIndex < rounds.length; rIndex++) {
          const nextR = rounds[rIndex];
          let nextRQuestions = database.prepare("SELECT id, duration_ms, order_index FROM questions WHERE round_id = ? AND status != 'retired' ORDER BY order_index").all(nextR.id) as { id: string; duration_ms: number; order_index: number }[];
          if (nextRQuestions.length === 0) {
            nextRQuestions = database.prepare('SELECT id, duration_ms, order_index FROM questions WHERE round_id = ? ORDER BY order_index').all(nextR.id) as { id: string; duration_ms: number; order_index: number }[];
          }
          if (nextRQuestions.length > 0) {
            return { nextRoundId: nextR.id, nextQuestionId: nextRQuestions[0].id, durationMs: nextRQuestions[0].duration_ms, isCompleted: false };
          }
        }
      }

      return { nextRoundId: null, nextQuestionId: null, durationMs: 0, isCompleted: true };
    },

    getSessionState(sessionId: string, role: 'admin' | 'public'): AdminSessionState | PublicSessionState | null {
      const session = repo.getSession(sessionId);
      if (!session) return null;

      const event = repo.getEvent(session.eventId);
      if (!event) return null;

      let roundSummary: RoundSummary | null = null;
      let questionData: AdminQuestionState | PublicQuestionState | null = null;
      let durationMs = 0;
      const revealState = session.currentQuestionId
        ? repo.getQuestionReveal(sessionId, session.currentQuestionId)
        : { questionRevealed: false, revealedChoiceCount: 0 };

      if (session.currentRoundId) {
        const round = repo.getRound(session.currentRoundId);
        if (round) {
          const roundQuestions = database.prepare('SELECT id FROM questions WHERE round_id = ? ORDER BY order_index').all(round.id) as { id: string }[];
          const qIndex = session.currentQuestionId ? roundQuestions.findIndex((q) => q.id === session.currentQuestionId) : -1;
          roundSummary = {
            id: round.id,
            name: round.name,
            roundType: round.roundType,
            orderIndex: round.orderIndex,
            totalQuestions: roundQuestions.length,
            currentQuestionIndex: qIndex >= 0 ? qIndex : 0,
          };
        }
      }

      if (session.currentQuestionId) {
        const adminQ = repo.getQuestionAdmin(session.currentQuestionId);
        if (adminQ) {
          durationMs = adminQ.durationMs;
          const totalResponses = repo.countAcceptedResponses(sessionId, adminQ.id);

          if (role === 'admin') {
            questionData = {
              id: adminQ.id,
              roundId: adminQ.roundId,
              questionType: adminQ.questionType,
              prompt: adminQ.prompt,
              explanation: adminQ.explanation,
              mediaPath: adminQ.mediaPath,
              durationMs: adminQ.durationMs,
              points: adminQ.points,
              penaltyPoints: adminQ.penaltyPoints,
              orderIndex: adminQ.orderIndex,
              assignedParticipantId: adminQ.assignedParticipantId ?? null,
              choices: adminQ.choices,
              correctValue: adminQ.correctValue,
              acceptedAnswers: adminQ.acceptedAnswers,
              acceptedAnswersCount: adminQ.acceptedAnswers.length,
              rapidFireItems: adminQ.rapidFireItems,
              totalAcceptedResponses: totalResponses,
            };
          } else {
            // Public view - NEVER leak answers before reveal phase!
            const isRevealed = session.questionState === 'revealed';
            const questionRevealed = revealState.questionRevealed || isRevealed;
            const revealedChoiceCount = isRevealed ? adminQ.choices.length : revealState.revealedChoiceCount;
            const publicChoices: PublicChoice[] = isRevealed
              ? adminQ.choices.map((c) => ({ id: c.id, questionId: c.questionId, choiceText: c.choiceText, orderIndex: c.orderIndex, isCorrect: c.isCorrect }))
              : adminQ.choices.map((c, index) => ({ id: c.id, questionId: c.questionId, choiceText: questionRevealed && index < revealedChoiceCount ? c.choiceText : '', orderIndex: c.orderIndex }));

            questionData = {
              id: adminQ.id,
              roundId: adminQ.roundId,
              questionType: adminQ.questionType,
              assignedParticipantId: adminQ.assignedParticipantId ?? null,
              prompt: questionRevealed ? adminQ.prompt : '',
              explanation: isRevealed ? adminQ.explanation : null,
              mediaPath: questionRevealed ? adminQ.mediaPath : null,
              durationMs: adminQ.durationMs,
              points: adminQ.points,
              penaltyPoints: adminQ.penaltyPoints,
              orderIndex: adminQ.orderIndex,
              choices: publicChoices,
              totalAcceptedResponses: totalResponses,
            };
          }
        }
      }

      const timer: TimerState = {
        durationMs,
        timeRemainingMs: session.timeRemainingMs,
        deadlineTimestamp: session.deadlineTimestamp,
        isPaused: session.questionState === 'paused' || session.status === 'paused',
      };

      let rapidFire: PublicSessionState['rapidFire'] = null;
      if (session.currentQuestionId) {
        const rapidFireItems = repo.listRapidFireItems(session.currentQuestionId);
        if (rapidFireItems.length > 0) {
          const control = database.prepare(
            'SELECT selected_participant_id FROM session_rapid_fire_control WHERE session_id = ? AND question_id = ?'
          ).get(sessionId, session.currentQuestionId) as { selected_participant_id: string | null } | undefined;
          const selectedParticipantId = control?.selected_participant_id ?? null;
          const progress = selectedParticipantId
            ? database.prepare(
              'SELECT current_item_index FROM session_rapid_fire_progress WHERE session_id = ? AND question_id = ? AND participant_id = ?'
            ).get(sessionId, session.currentQuestionId, selectedParticipantId) as { current_item_index: number } | undefined
            : undefined;
          const results = selectedParticipantId
            ? database.prepare(
              'SELECT item_index, status FROM session_rapid_fire_results WHERE session_id = ? AND question_id = ? AND participant_id = ?'
            ).all(sessionId, session.currentQuestionId, selectedParticipantId) as Array<{ item_index: number; status: 'passed' | 'correct' | 'incorrect' }>
            : [];
          const resultByIndex = new Map(results.map((result) => [result.item_index, result.status]));
          const currentItemIndex = progress?.current_item_index ?? 0;
          const questionIsRevealed = revealState.questionRevealed || session.questionState === 'revealed';
          rapidFire = {
            selectedParticipantId,
            currentItemIndex,
            items: rapidFireItems.map((item, index) => {
              const status = resultByIndex.get(index) ?? 'pending';
              return {
                index,
                prompt: questionIsRevealed && index === currentItemIndex ? item.prompt : null,
                answerText: session.questionState === 'revealed' ? item.answerText : null,
                status,
              };
            }),
          };
        }
      }

      let revealedAnswer: PublicSessionState['revealedAnswer'] = null;
      if (session.questionState === 'revealed' && session.currentQuestionId) {
        const adminQ = repo.getQuestionAdmin(session.currentQuestionId);
        if (adminQ) {
          revealedAnswer = {
            correctValue: adminQ.correctValue,
            correctChoices: adminQ.choices.filter((c) => c.isCorrect),
            acceptedAnswers: adminQ.acceptedAnswers,
            explanation: adminQ.explanation,
          };
        }
      }

      const baseState: PublicSessionState = {
        buzzerParticipantId: (database.prepare('SELECT participant_id FROM buzzer_requests WHERE session_id = ? AND question_id = ? AND accepted = 1').get(session.id, session.currentQuestionId) as { participant_id: string } | undefined)?.participant_id ?? null,
        mediaFullscreen: repo.isMediaFullscreen(session.id),
        sessionId: session.id,
        eventId: session.eventId,
        eventTitle: event.title,
        status: session.status,
        round: roundSummary,
        question: questionData as PublicQuestionState | null,
        questionState: session.questionState,
        audienceChoiceId: session.currentQuestionId
          ? repo.getAudienceChoice(sessionId, session.currentQuestionId)
          : null,
        questionRevealed: revealState.questionRevealed || session.questionState === 'revealed',
        revealedChoiceCount: session.questionState === 'revealed' && session.currentQuestionId
          ? (repo.getQuestionAdmin(session.currentQuestionId)?.choices.length ?? 0)
          : revealState.revealedChoiceCount,
        answerChangesAllowed: event.settings.allowAnswerChanges === true,
        timer,
        rapidFire,
        revealedAnswer,
        updatedAt: session.updatedAt,
      };

      if (role === 'admin') {
        return {
          ...baseState,
          question: questionData as AdminQuestionState | null,
        };
      }

      return baseState;
    },
  };
  return repo;
}

export type Repositories = ReturnType<typeof createRepositories>;
