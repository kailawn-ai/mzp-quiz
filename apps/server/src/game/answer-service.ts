import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Repositories } from '../database/repositories.js';
import { normalizeCandidate, validateAnswer } from './answer-validation.js';
import { CompetitionError, type ParticipantService } from './participant-service.js';
import { calculateQuestionScore } from './scoring.js';

const answerInputSchema = z.object({
  requestId: z.string().min(12).max(128),
  responseText: z.string().trim().min(1).max(1000).optional(),
  choiceId: z.string().uuid().optional(),
  booleanValue: z.boolean().optional(),
}).strict();
const gradeInputSchema = z.object({ isCorrect: z.boolean(), reason: z.string().trim().min(1).max(500) });
const adjustmentInputSchema = z.object({
  participantId: z.string().uuid(),
  pointsDelta: z.number().int().min(-1_000_000).max(1_000_000),
  reason: z.string().trim().min(1).max(500),
});
const buzzerInputSchema = z.object({ questionId: z.string().uuid() }).strict();

type SubmissionRow = {
  id: string;
  request_id: string;
  session_id: string;
  submitted_at: number;
  revision: number;
  award_points: number;
  is_correct: number | null;
};

function answerReceipt(row: SubmissionRow, changed: boolean) {
  return {
    submissionId: row.id,
    submittedAt: row.submitted_at,
    revision: row.revision,
    changed,
    status: row.is_correct === null ? 'pending_review' : 'recorded',
  };
}

export function createAnswerService(
  database: Database.Database,
  repositories: Repositories,
  participants: ParticipantService,
) {
  const insertTransaction = (input: {
    participantId: string;
    eventId: string;
    sessionId?: string | null;
    roundId?: string | null;
    questionId?: string | null;
    submissionId?: string | null;
    buzzerRequestId?: string | null;
    type: 'answer' | 'reversal' | 'buzzer' | 'admin_adjustment' | 'reset';
    points: number;
    reason?: string | null;
    timestamp: number;
  }) => {
    database.prepare(`
      INSERT INTO score_transactions
        (id, participant_id, event_id, session_id, round_id, question_id, submission_id,
       buzzer_request_id, transaction_type, points_delta, generation, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.participantId,
      input.eventId,
      input.sessionId ?? null,
      input.roundId ?? null,
      input.questionId ?? null,
      input.submissionId ?? null,
      input.buzzerRequestId ?? null,
      input.type,
      input.points,
      (database.prepare('SELECT score_generation FROM events WHERE id = ?').get(input.eventId) as { score_generation: number }).score_generation,
      input.reason ?? null,
      input.timestamp,
    );
  };

  return {
    getOwnSubmission(participantId: string, sessionId: string, questionId: string) {
      const session = repositories.getSession(sessionId);
      if (!session) throw new CompetitionError(404, 'SESSION_NOT_FOUND', 'Live quiz session not found.');
      const participant = participants.get(participantId);
      if (!participant?.enabled) throw new CompetitionError(401, 'PARTICIPANT_UNAUTHORIZED', 'Participant is disabled or no longer registered.');
      if (participant.eventId !== session.eventId) throw new CompetitionError(403, 'EVENT_MISMATCH', 'This participant is not registered for the session event.');
      const row = database.prepare(`
        SELECT response_text, choice_id, boolean_value, submitted_at
        FROM answer_submissions
        WHERE participant_id = ? AND session_id = ? AND question_id = ? AND is_current = 1
      `).get(participantId, sessionId, questionId) as {
        response_text: string | null;
        choice_id: string | null;
        boolean_value: number | null;
        submitted_at: number;
      } | undefined;
      return row ? {
        responseText: row.response_text,
        choiceId: row.choice_id,
        booleanValue: row.boolean_value === null ? null : Boolean(row.boolean_value),
        submittedAt: row.submitted_at,
      } : null;
    },

    submit(participantId: string, sessionId: string, input: unknown) {
      const value = answerInputSchema.parse(input);
      const transaction = database.transaction(() => {
        const replay = database.prepare(`
          SELECT id, request_id, session_id, submitted_at, revision, award_points, is_correct
          FROM answer_submissions WHERE participant_id = ? AND request_id = ?
        `).get(participantId, value.requestId) as SubmissionRow | undefined;
        if (replay) {
          if (replay.session_id !== sessionId) {
            throw new CompetitionError(409, 'IDEMPOTENCY_KEY_REUSED', 'This request identifier was already used for a different session.');
          }
          return answerReceipt(replay, false);
        }

        const participant = participants.get(participantId);
        if (!participant?.enabled) throw new CompetitionError(401, 'PARTICIPANT_UNAUTHORIZED', 'Participant is disabled or no longer registered.');
        const session = database.prepare(`
          SELECT id, event_id, status, current_round_id, current_question_id, question_state,
                 deadline_timestamp
          FROM quiz_sessions WHERE id = ?
        `);
        const row = session.get(sessionId) as {
          id: string;
          event_id: string;
          status: string;
          current_round_id: string | null;
          current_question_id: string | null;
          question_state: string;
          deadline_timestamp: number | null;
        } | undefined;
        if (!row) throw new CompetitionError(404, 'SESSION_NOT_FOUND', 'Live quiz session not found.');
        if (row.event_id !== participant.eventId) throw new CompetitionError(403, 'EVENT_MISMATCH', 'This participant is not registered for the session event.');
        const questionId = row.current_question_id;
        if (!questionId) throw new CompetitionError(409, 'NO_ACTIVE_QUESTION', 'There is no current question.');
        const timestamp = Date.now();
        if (
          row.status !== 'active' ||
          row.question_state !== 'active' ||
          !row.deadline_timestamp ||
          row.deadline_timestamp <= timestamp
        ) {
          throw new CompetitionError(409, 'ANSWERING_CLOSED', 'Answers are only accepted while the question is active and before its deadline.');
        }

        const question = repositories.getQuestionAdmin(questionId);
        if (!question || question.roundId !== row.current_round_id) {
          throw new CompetitionError(409, 'QUESTION_MISMATCH', 'The current question does not belong to this round.');
        }
        if (question.questionType === 'rapid_fire') {
          throw new CompetitionError(409, 'HOST_JUDGED', 'Rapid-fire answers are judged by the host in Live Control.');
        }
        if (!['multiple_choice', 'true_false', 'written_answer', 'short_answer', 'quick_question'].includes(question.questionType)) {
          throw new CompetitionError(400, 'UNSUPPORTED_QUESTION_TYPE', 'This question type does not accept submitted answers.');
        }
        if (question.questionType === 'multiple_choice' && (!value.choiceId || value.responseText !== undefined || value.booleanValue !== undefined)) {
          throw new CompetitionError(400, 'INVALID_ANSWER', 'Select one option for this question.');
        }
        if (question.questionType === 'multiple_choice' && !question.choices.some((choice) => choice.id === value.choiceId)) {
          throw new CompetitionError(400, 'INVALID_ANSWER', 'The selected option does not belong to this question.');
        }
        if (question.questionType === 'true_false' && (value.booleanValue === undefined || value.choiceId !== undefined || value.responseText !== undefined)) {
          throw new CompetitionError(400, 'INVALID_ANSWER', 'Submit True or False for this question.');
        }
        if (
          ['written_answer', 'short_answer', 'quick_question'].includes(question.questionType) &&
          (value.responseText === undefined || value.choiceId !== undefined || value.booleanValue !== undefined)
        ) {
          throw new CompetitionError(400, 'INVALID_ANSWER', 'Submit a text answer for this question.');
        }

        const existing = database.prepare(`
          SELECT id, award_points FROM answer_submissions
          WHERE participant_id = ? AND session_id = ? AND question_id = ? AND is_current = 1
        `).get(participantId, sessionId, questionId) as { id: string; award_points: number } | undefined;
        const eventRow = database.prepare('SELECT settings_json, score_generation FROM events WHERE id = ?').get(row.event_id) as {
          settings_json: string;
          score_generation: number;
        };
        const settings = JSON.parse(eventRow.settings_json) as { allowAnswerChanges?: boolean };
        if (existing && settings.allowAnswerChanges !== true) {
          throw new CompetitionError(409, 'ANSWER_ALREADY_SUBMITTED', 'An answer has already been submitted for this question.');
        }

        const elapsedMs = Math.max(0, question.durationMs - Math.max(0, row.deadline_timestamp - timestamp));
        const isCorrect = validateAnswer(question, value, question.choices, question.acceptedAnswers);
        const awardPoints = calculateQuestionScore(question, isCorrect, elapsedMs);
        const prior = database.prepare(`
          SELECT id, award_points, score_generation FROM answer_submissions
          WHERE participant_id = ? AND session_id = ? AND question_id = ? AND is_current = 1
        `).get(participantId, sessionId, questionId) as { id: string; award_points: number; score_generation: number } | undefined;
        if (prior) {
          database.prepare('UPDATE answer_submissions SET is_current = 0 WHERE id = ?').run(prior.id);
          if (prior.score_generation === eventRow.score_generation) {
            insertTransaction({
              participantId,
              eventId: row.event_id,
              sessionId: row.id,
              roundId: row.current_round_id,
              questionId,
              submissionId: prior.id,
              type: 'reversal',
              points: -prior.award_points,
              reason: 'Answer changed before the deadline',
              timestamp,
            });
          }
        }

        const revision = (database.prepare(`
          SELECT COALESCE(MAX(revision), 0) AS revision
          FROM answer_submissions WHERE participant_id = ? AND session_id = ? AND question_id = ?
        `).get(participantId, sessionId, questionId) as { revision: number }).revision + 1;
        const submissionId = randomUUID();
        database.prepare(`
          INSERT INTO answer_submissions
            (id, participant_id, session_id, question_id, request_id, revision, response_text,
             normalized_answer, choice_id, boolean_value, is_correct, award_points, elapsed_ms, score_generation, is_current, submitted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
          submissionId,
          participantId,
          row.id,
          questionId,
          value.requestId,
          revision,
          value.responseText ?? null,
          normalizeCandidate(value),
          value.choiceId ?? null,
          value.booleanValue === undefined ? null : Number(value.booleanValue),
          isCorrect === null ? null : Number(isCorrect),
          awardPoints,
          elapsedMs,
          eventRow.score_generation,
          timestamp,
        );
        if (isCorrect !== null) {
          insertTransaction({
            participantId,
            eventId: row.event_id,
            sessionId: row.id,
            roundId: question.roundId,
            questionId,
            submissionId,
            type: 'answer',
            points: awardPoints,
            timestamp,
          });
        }
        const saved = database.prepare(`
          SELECT id, request_id, session_id, submitted_at, revision, award_points, is_correct
          FROM answer_submissions WHERE id = ?
        `).get(submissionId) as SubmissionRow;
        return answerReceipt(saved, prior !== undefined);
      });
      return transaction.immediate();
    },

    recordBuzzer(participantId: string, sessionId: string, input: unknown) {
      const value = buzzerInputSchema.parse(input);
      const transaction = database.transaction(() => {
        const participant = participants.get(participantId);
        if (!participant?.enabled) throw new CompetitionError(401, 'PARTICIPANT_UNAUTHORIZED', 'Participant is disabled or no longer registered.');
        const session = repositories.getSession(sessionId);
        if (!session) throw new CompetitionError(404, 'SESSION_NOT_FOUND', 'Live quiz session not found.');
        if (session.eventId !== participant.eventId) throw new CompetitionError(403, 'EVENT_MISMATCH', 'This participant is not registered for the session event.');
        if (
          session.status !== 'active' ||
          session.questionState !== 'active' ||
          session.currentQuestionId !== value.questionId ||
          !session.deadlineTimestamp ||
          session.deadlineTimestamp <= Date.now()
        ) {
          throw new CompetitionError(409, 'BUZZER_CLOSED', 'The buzzer is unavailable unless its question is active and before its deadline.');
        }
        const question = repositories.getQuestionAdmin(value.questionId);
        if (!question || question.roundId !== session.currentRoundId || question.questionType !== 'buzzer') {
          throw new CompetitionError(400, 'INVALID_BUZZER_QUESTION', 'The current question is not a buzzer question.');
        }
        const control = repositories.getEvent(session.eventId)?.settings[`buzzer:${sessionId}:${value.questionId}`] as { open?: boolean } | undefined;
        if (!control?.open) throw new CompetitionError(409, 'BUZZER_CLOSED', 'The host has not opened the buzzer.');

        const previous = database.prepare(`
          SELECT id, accepted, requested_at FROM buzzer_requests
          WHERE participant_id = ? AND session_id = ? AND question_id = ?
        `).get(participantId, sessionId, value.questionId) as {
          id: string;
          accepted: number;
          requested_at: number;
        } | undefined;
        if (previous) {
          const winner = database.prepare(`
            SELECT p.display_name FROM buzzer_requests b
            JOIN event_participants p ON p.id = b.participant_id
            WHERE b.session_id = ? AND b.question_id = ? AND b.accepted = 1
          `).get(sessionId, value.questionId) as { display_name: string } | undefined;
          return {
            accepted: Boolean(previous.accepted),
            requestedAt: previous.requested_at,
            winner: winner?.display_name ?? null,
          };
        }

        const requestedAt = Date.now();
        const requestId = randomUUID();
        const generation = (database.prepare('SELECT score_generation FROM events WHERE id = ?').get(session.eventId) as { score_generation: number }).score_generation;
        database.prepare(`
          INSERT INTO buzzer_requests (id, participant_id, session_id, question_id, accepted, score_generation, requested_at)
          VALUES (?, ?, ?, ?, 0, ?, ?)
        `).run(requestId, participantId, sessionId, value.questionId, generation, requestedAt);
        const existingWinner = database.prepare(`
          SELECT id FROM buzzer_requests
          WHERE session_id = ? AND question_id = ? AND accepted = 1
        `).get(sessionId, value.questionId) as { id: string } | undefined;
        const accepted = !existingWinner;
        if (accepted) {
          database.prepare('UPDATE buzzer_requests SET accepted = 1 WHERE id = ?').run(requestId);
          database.prepare(`
            INSERT INTO score_transactions
              (id, participant_id, event_id, session_id, round_id, question_id, buzzer_request_id, transaction_type, points_delta, generation, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'buzzer', ?, ?, ?, ?)
          `).run(randomUUID(), participantId, session.eventId, sessionId, question.roundId, question.id, requestId, question.points, generation, 'First buzzer awarded', requestedAt);
        }
        return {
          accepted,
          requestedAt,
          winner: accepted ? participant.displayName : null,
        };
      });
      return transaction.immediate();
    },

    grade(submissionId: string, input: unknown) {
      const value = gradeInputSchema.parse(input);
      const transaction = database.transaction(() => {
        const submission = database.prepare(`
          SELECT s.id, s.participant_id, s.session_id, s.question_id, s.is_correct,
                 s.award_points, s.elapsed_ms, s.is_current, qs.event_id
          FROM answer_submissions s JOIN quiz_sessions qs ON qs.id = s.session_id
          WHERE s.id = ?
        `).get(submissionId) as {
          id: string;
          participant_id: string;
          session_id: string;
          question_id: string;
          is_correct: number | null;
          award_points: number;
          elapsed_ms: number | null;
          is_current: number;
          event_id: string;
        } | undefined;
        if (!submission) throw new CompetitionError(404, 'SUBMISSION_NOT_FOUND', 'Answer submission not found.');
        if (submission.is_correct !== null || !submission.is_current) {
          throw new CompetitionError(409, 'SUBMISSION_ALREADY_GRADED', 'This answer has already been graded or is no longer current.');
        }
        const question = repositories.getQuestionAdmin(submission.question_id);
        if (!question) throw new CompetitionError(404, 'QUESTION_NOT_FOUND', 'Question not found.');
        const now = Date.now();
        const awardPoints = calculateQuestionScore(question, value.isCorrect, submission.elapsed_ms);
        const generation = (database.prepare('SELECT score_generation FROM events WHERE id = ?').get(submission.event_id) as { score_generation: number }).score_generation;
        database.prepare('UPDATE answer_submissions SET is_correct = ?, award_points = ?, score_generation = ? WHERE id = ?')
          .run(Number(value.isCorrect), awardPoints, generation, submission.id);
        insertTransaction({
          participantId: submission.participant_id,
          eventId: submission.event_id,
          sessionId: submission.session_id,
          roundId: question.roundId,
          questionId: question.id,
          submissionId: submission.id,
          type: 'answer',
          points: awardPoints,
          reason: value.reason,
          timestamp: now,
        });
        return { submissionId, isCorrect: value.isCorrect, pointsAwarded: awardPoints };
      });
      return transaction.immediate();
    },

    adjustScore(eventId: string, input: unknown) {
      const value = adjustmentInputSchema.parse(input);
      const participant = participants.get(value.participantId);
      if (!participant || participant.eventId !== eventId) {
        throw new CompetitionError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found for this event.');
      }
      const timestamp = Date.now();
      insertTransaction({
        participantId: participant.id,
        eventId,
        type: 'admin_adjustment',
        points: value.pointsDelta,
        reason: value.reason,
        timestamp,
      });
      return { participantId: participant.id, pointsDelta: value.pointsDelta, reason: value.reason, createdAt: timestamp };
    },

    resetScores(eventId: string, input: unknown) {
      const value = z.object({ confirmation: z.literal('RESET SCORES') }).parse(input);
      const transaction = database.transaction(() => {
        const event = database.prepare('SELECT score_generation FROM events WHERE id = ?').get(eventId) as { score_generation: number } | undefined;
        if (!event) throw new CompetitionError(404, 'EVENT_NOT_FOUND', 'Event not found.');
        const nextGeneration = event.score_generation + 1;
        const timestamp = Date.now();
        database.prepare('UPDATE events SET score_generation = ? WHERE id = ?').run(nextGeneration, eventId);
        database.prepare(`
          INSERT INTO score_reset_audits
            (id, event_id, prior_generation, new_generation, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), eventId, event.score_generation, nextGeneration, value.confirmation, timestamp);
        const participantsInEvent = participants.list(eventId);
        for (const participant of participantsInEvent) {
          insertTransaction({
            participantId: participant.id,
            eventId,
            type: 'reset',
            points: 0,
            reason: 'Confirmed event score reset',
            timestamp,
          });
        }
        return { reset: true, participants: participantsInEvent.length, createdAt: timestamp };
      });
      return transaction.immediate();
    },
  };
}

export type AnswerService = ReturnType<typeof createAnswerService>;
