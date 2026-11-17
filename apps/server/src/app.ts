import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { sessionControlSchema } from '@mzp-quiz/shared';
import { createDatabase, type DatabaseHandle } from './database/database.js';
import { createRepositories, type Repositories } from './database/repositories.js';
import { GameEngine, GameEngineError } from './game/engine.js';
import { WebSocketHub } from './game/websocket.js';
import { createAnswerService } from './game/answer-service.js';
import { CompetitionError, createParticipantService } from './game/participant-service.js';
import { getOverlaySettings, OverlayError, readOverlayAsset, saveOverlayAsset, updateOverlaySettings } from './game/overlay.js';

class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

type AppOptions = {
  database?: DatabaseHandle;
  adminToken?: string;
};

export type AppInstance = FastifyInstance & {
  gameEngine: GameEngine;
  wsHub: WebSocketHub;
  repositories: Repositories;
  database: DatabaseHandle;
};

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const adminToken = options.adminToken ?? process.env.MZP_ADMIN_TOKEN;
  if (adminToken && !/^[A-Za-z0-9._~-]{24,128}$/.test(adminToken)) {
    throw new Error('MZP_ADMIN_TOKEN must be 24-128 URL-safe characters.');
  }
  const ownsDatabase = !options.database;
  const database = options.database ?? createDatabase();
  const repositories: Repositories = createRepositories(database.connection);
  const app = Fastify({ logger: true });

  const wsHub = new WebSocketHub(app.server, adminToken);
  const gameEngine = new GameEngine(repositories, wsHub);
  const participants = createParticipantService(database.connection);
  const answers = createAnswerService(database.connection, repositories, participants);
  wsHub.registerLeaderboardProvider(() => {
    try {
      const activeSession = repositories.listActiveSessions()[0];
      return activeSession
        ? { eventId: activeSession.eventId, entries: participants.leaderboard(activeSession.eventId) }
        : null;
    } catch (err) {
      // Leaderboard query may fail if schema migrations are still pending; non-fatal.
      console.warn('[leaderboard] skipped due to error:', (err as Error).message);
      return null;
    }
  });
  const submissionAttempts = new Map<string, number[]>();

  // Attach handles for testing/introspection
  Object.assign(app, { gameEngine, wsHub, repositories, database });

  const allowedOrigins = (process.env.MZP_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.register(cors, {
    origin: (origin, callback) => {
      // Non-browser clients and same-origin requests have no Origin header.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.addHook('preHandler', async (request) => {
    const url = request.routeOptions.url ?? request.url.split('?')[0];
    if (url === '/api/admin/auth') return;
    const publicSubmission =
      url === '/api/events/:eventId/participants' ||
      url === '/api/sessions/:sessionId/answers' ||
      url === '/api/sessions/:sessionId/buzzer';
    const requiresAdmin =
      url.startsWith('/api/admin/') ||
      url === '/api/events/:eventId/session' && request.method === 'GET' ||
      !publicSubmission && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (!requiresAdmin) return;
    if (!adminToken) throw new ApiError(503, 'ADMIN_AUTH_NOT_CONFIGURED', 'Set MZP_ADMIN_TOKEN on the server before using administrative operations.');
    if (!isAuthorizedAdmin(request.headers.authorization, adminToken)) {
      throw new ApiError(401, 'ADMIN_UNAUTHORIZED', 'A valid admin token is required.');
    }
  });
  app.addHook('onClose', async () => {
    gameEngine.close();
    wsHub.close();
    if (ownsDatabase) database.close();
  });

  app.get('/health', async () => ({ status: 'ok', service: 'mzp-quiz-server', timestamp: new Date().toISOString() }));
  app.get('/api/health', async () => ({ status: 'ok', data: { service: 'mzp-quiz-server', timestamp: new Date().toISOString() } }));
  app.get('/api/health/database', async () => ({ status: 'ok', data: { database: database.health(), migrations: { applied: database.migrationsApplied } } }));
  app.get('/api/dashboard', async () => ({ status: 'ok', data: repositories.dashboardCounts() }));

  app.post('/api/admin/auth', async (request, reply) => {
    if (!adminToken) throw new ApiError(503, 'ADMIN_AUTH_NOT_CONFIGURED', 'Set MZP_ADMIN_TOKEN on the server before using administrative operations.');
    if (!isAuthorizedAdmin(request.headers.authorization, adminToken)) {
      throw new ApiError(401, 'ADMIN_UNAUTHORIZED', 'The admin token is invalid.');
    }
    return reply.send({ status: 'ok', data: { authorized: true } });
  });

  // Events
  app.post<{ Body: unknown }>('/api/events', async (request, reply) => reply.code(201).send({ status: 'ok', data: repositories.createEvent(request.body) }));
  app.get('/api/events', async () => ({ status: 'ok', data: repositories.listEvents() }));
  app.get<{ Params: { eventId: string } }>('/api/events/:eventId', async (request) => {
    const event = repositories.getEvent(request.params.eventId);
    if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return { status: 'ok', data: event };
  });
  app.put<{ Params: { eventId: string }; Body: unknown }>('/api/events/:eventId', async (request) => {
    const event = repositories.updateEvent(request.params.eventId, request.body);
    if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return { status: 'ok', data: event };
  });
  app.delete<{ Params: { eventId: string } }>('/api/events/:eventId', async (request) => {
    if (repositories.listActiveSessions().some((session) => session.eventId === request.params.eventId)) {
      throw new ApiError(409, 'EVENT_SESSION_ACTIVE', 'End the active quiz session before deleting this event.');
    }
    if (!repositories.deleteEvent(request.params.eventId)) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return { status: 'ok', data: { deleted: true } };
  });

  // Rounds
  app.post<{ Params: { eventId: string }; Body: unknown }>('/api/events/:eventId/rounds', async (request, reply) => {
    if (!repositories.getEvent(request.params.eventId)) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return reply.code(201).send({ status: 'ok', data: repositories.createRound(request.params.eventId, request.body) });
  });
  app.get<{ Params: { eventId: string } }>('/api/events/:eventId/rounds', async (request) => {
    if (!repositories.getEvent(request.params.eventId)) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return { status: 'ok', data: repositories.listRounds(request.params.eventId) };
  });
  app.put<{ Params: { eventId: string; roundId: string }; Body: unknown }>('/api/events/:eventId/rounds/:roundId', async (request) => {
    const round = repositories.getRound(request.params.roundId);
    if (!round || round.eventId !== request.params.eventId) throw new ApiError(404, 'ROUND_NOT_FOUND', 'Round not found.');
    return { status: 'ok', data: repositories.updateRound(round.id, request.body) };
  });

  // Event participants and public standings
  app.get<{ Params: { eventId: string } }>('/api/events/:eventId/participants', async (request) => {
    if (!repositories.getEvent(request.params.eventId)) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return {
      status: 'ok',
      data: participants.list(request.params.eventId)
        .filter((participant) => participant.enabled)
        .map(({ id, participantType, displayName, teamIdentifier }) => ({ id, participantType, displayName, teamIdentifier })),
    };
  });
  app.post<{ Params: { eventId: string }; Body: unknown }>('/api/events/:eventId/participants', async (request, reply) => {
    const registration = participants.register(request.params.eventId, request.body);
    return reply.code(201).send({ status: 'ok', data: { ...registration.participant, token: registration.token } });
  });
  app.get<{ Params: { eventId: string } }>('/api/admin/events/:eventId/participants', async (request) => ({
    status: 'ok',
    data: participants.list(request.params.eventId),
  }));
  app.get<{ Params: { eventId: string } }>('/api/admin/events/:eventId/submissions', async (request) => {
    if (!repositories.getEvent(request.params.eventId)) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    const rows = database.connection.prepare(`
      SELECT s.id, s.session_id, s.question_id, s.response_text, s.boolean_value, s.is_correct,
             s.award_points, s.submitted_at, p.display_name, q.prompt, c.choice_text
      FROM answer_submissions s
      JOIN event_participants p ON p.id = s.participant_id
      JOIN questions q ON q.id = s.question_id
      LEFT JOIN question_choices c ON c.id = s.choice_id
      JOIN quiz_sessions qs ON qs.id = s.session_id
      WHERE qs.event_id = ? AND s.is_current = 1
      ORDER BY s.submitted_at DESC
    `).all(request.params.eventId) as Array<{
      id: string;
      session_id: string;
      question_id: string;
      response_text: string | null;
      boolean_value: number | null;
      is_correct: number | null;
      award_points: number;
      submitted_at: number;
      display_name: string;
      prompt: string;
      choice_text: string | null;
    }>;
    return {
      status: 'ok',
      data: rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        questionId: row.question_id,
        prompt: row.prompt,
        displayName: row.display_name,
        response: row.choice_text ?? row.response_text ?? (row.boolean_value === null ? null : String(Boolean(row.boolean_value))),
        isCorrect: row.is_correct === null ? null : Boolean(row.is_correct),
        pointsAwarded: row.award_points,
        submittedAt: row.submitted_at,
      })),
    };
  });
  app.patch<{ Params: { participantId: string }; Body: unknown }>('/api/admin/participants/:participantId', async (request) => {
    const participant = participants.update(request.params.participantId, request.body);
    if (!participant) throw new ApiError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found.');
    return { status: 'ok', data: participant };
  });
  app.delete<{ Params: { participantId: string } }>('/api/admin/participants/:participantId', async (request) => {
    if (!participants.remove(request.params.participantId)) throw new ApiError(404, 'PARTICIPANT_NOT_FOUND', 'Participant not found.');
    return { status: 'ok', data: { deleted: true } };
  });
  app.get<{ Params: { eventId: string } }>('/api/events/:eventId/leaderboard', async (request) => {
    if (!repositories.getEvent(request.params.eventId)) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return { status: 'ok', data: participants.leaderboard(request.params.eventId) };
  });
  app.get<{ Params: { eventId: string } }>('/api/events/:eventId/overlay/settings', async (request) => {
    const event = repositories.getEvent(request.params.eventId);
    if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return { status: 'ok', data: getOverlaySettings(event.settings) };
  });
  app.put<{ Params: { eventId: string }; Body: unknown }>('/api/admin/events/:eventId/overlay/settings', async (request) => {
    const event = repositories.getEvent(request.params.eventId);
    if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    const overlay = updateOverlaySettings(event.settings, request.body);
    const saved = repositories.updateEvent(request.params.eventId, { settings: { ...event.settings, overlay } });
    return { status: 'ok', data: saved ? getOverlaySettings(saved.settings) : overlay };
  });
  app.post<{ Params: { eventId: string }; Body: unknown }>('/api/admin/events/:eventId/overlay/assets', { bodyLimit: 7_100_000 }, async (request, reply) => {
    if (!repositories.getEvent(request.params.eventId)) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    const asset = saveOverlayAsset(database.paths, request.body);
    return reply.code(201).send({ status: 'ok', data: { ...asset, url: `/api/overlay/assets/${asset.assetId}` } });
  });
  app.get<{ Params: { assetId: string } }>('/api/overlay/assets/:assetId', async (request, reply) => {
    const asset = readOverlayAsset(database.paths, request.params.assetId);
    if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Overlay asset not found.');
    return reply.type(asset.contentType).header('Cache-Control', 'public, max-age=31536000, immutable').send(asset.data);
  });
  app.post<{ Params: { eventId: string }; Body: unknown }>('/api/admin/events/:eventId/scores/adjust', async (request) => {
    const adjustment = answers.adjustScore(request.params.eventId, request.body);
    wsHub.broadcastLeaderboard(() => ({ eventId: request.params.eventId, entries: participants.leaderboard(request.params.eventId) }));
    return { status: 'ok', data: adjustment };
  });
  app.post<{ Params: { eventId: string }; Body: unknown }>('/api/admin/events/:eventId/scores/reset', async (request) => {
    const result = answers.resetScores(request.params.eventId, request.body);
    wsHub.broadcastLeaderboard(() => ({ eventId: request.params.eventId, entries: participants.leaderboard(request.params.eventId) }));
    return { status: 'ok', data: result };
  });

  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/sessions/:sessionId/answers', async (request) => {
    const participant = participants.authenticate(readBearerToken(request.headers.authorization));
    enforceSubmissionRate(submissionAttempts, `answer:${participant.id}`, 30, 60_000);
    const receipt = answers.submit(participant.id, request.params.sessionId, request.body);
    const session = repositories.getSession(request.params.sessionId);
    if (session) {
      wsHub.broadcast(
        'answer_submitted',
        () => repositories.getSessionState(request.params.sessionId, 'admin'),
        () => repositories.getSessionState(request.params.sessionId, 'public'),
      );
      wsHub.broadcastLeaderboard(() => ({ eventId: session.eventId, entries: participants.leaderboard(session.eventId) }));
    }
    return { status: 'ok', data: receipt };
  });
  app.get<{ Params: { sessionId: string; questionId: string } }>('/api/sessions/:sessionId/submissions/:questionId', async (request) => {
    const participant = participants.authenticate(readBearerToken(request.headers.authorization));
    return {
      status: 'ok',
      data: answers.getOwnSubmission(participant.id, request.params.sessionId, request.params.questionId),
    };
  });
  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/sessions/:sessionId/buzzer', async (request) => {
    const participant = participants.authenticate(readBearerToken(request.headers.authorization));
    enforceSubmissionRate(submissionAttempts, `buzzer:${participant.id}`, 10, 10_000);
    const result = answers.recordBuzzer(participant.id, request.params.sessionId, request.body);
    const session = repositories.getSession(request.params.sessionId);
    if (result.accepted && session) {
      wsHub.broadcastLeaderboard(() => ({ eventId: session.eventId, entries: participants.leaderboard(session.eventId) }));
    }
    return { status: 'ok', data: result };
  });

  // Questions
  app.get<{ Params: { eventId: string; participantId: string } }>('/api/events/:eventId/team-screen/:participantId', async (request) => {
    const participant = participants.get(request.params.participantId);
    if (!participant?.enabled || participant.eventId !== request.params.eventId) throw new ApiError(404, 'PARTICIPANT_NOT_FOUND', 'Team screen unavailable.');
    const active = repositories.listActiveSessions().find((session) => session.eventId === participant.eventId);
    const state = active ? repositories.getSessionState(active.id, 'public') : null;
    const assigned = state?.question?.assignedParticipantId;
    const recipient = state?.question?.questionType === 'rapid_fire' ? state.rapidFire?.selectedParticipantId ?? assigned : assigned;
    const visible = state && state.questionRevealed && (!recipient || recipient === participant.id);
    return { status: 'ok', data: { participant: { id: participant.id, displayName: participant.displayName }, session: visible ? state : null } };
  });
  app.get<{ Params: { sessionId: string } }>('/api/admin/sessions/:sessionId/buzzer-control', async (request) => {
    const session = repositories.getSession(request.params.sessionId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    const control = repositories.getEvent(session.eventId)?.settings[`buzzer:${session.id}:${session.currentQuestionId}`] ?? { open: false };
    const winner = database.connection.prepare('SELECT b.id, b.participant_id AS participantId, p.display_name AS name FROM buzzer_requests b JOIN event_participants p ON p.id = b.participant_id WHERE b.session_id = ? AND b.question_id = ? AND b.accepted = 1').get(session.id, session.currentQuestionId) ?? null;
    return { status: 'ok', data: { control, winner } };
  });
  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/buzzer-control', async (request) => {
    const { action, participantId } = z.object({ action: z.enum(['open', 'close', 'correct', 'incorrect', 'reopen', 'select']), participantId: z.string().uuid().optional() }).parse(request.body);
    const session = repositories.getSession(request.params.sessionId);
    if (!session || session.status === 'ended' || !session.currentQuestionId) throw new ApiError(409, 'INVALID_STATE', 'No active question.');
    const question = repositories.getQuestionAdmin(session.currentQuestionId)!;
    if (question.questionType !== 'buzzer') throw new ApiError(409, 'INVALID_STATE', 'Select a buzzer question.');
    database.connection.transaction(() => {
      const event = repositories.getEvent(session.eventId)!;
      const key = `buzzer:${session.id}:${question.id}`;
      const current = event.settings[key] as { open?: boolean; judged?: boolean } | undefined;
      if (action === 'select') {
        if (!participantId || !participants.list(event.id).some((p) => p.id === participantId && p.enabled)) throw new ApiError(400, 'INVALID_PARTICIPANT', 'Choose an enabled team in this event.');
        if (current?.judged) throw new ApiError(409, 'INVALID_STATE', 'Reopen the buzzer before selecting another team.');
        database.connection.prepare('UPDATE buzzer_requests SET accepted = 0 WHERE session_id = ? AND question_id = ?').run(session.id, question.id);
        database.connection.prepare(`INSERT INTO buzzer_requests (id, participant_id, session_id, question_id, accepted, score_generation, requested_at) VALUES (?, ?, ?, ?, 1, 0, ?) ON CONFLICT(participant_id, session_id, question_id) DO UPDATE SET accepted = 1`).run(randomUUID(), participantId, session.id, question.id, Date.now());
      }
      const winner = database.connection.prepare('SELECT id, participant_id FROM buzzer_requests WHERE session_id = ? AND question_id = ? AND accepted = 1').get(session.id, question.id) as { id: string; participant_id: string } | undefined;
      if (action === 'correct' || action === 'incorrect') {
        if (!winner || current?.judged) throw new ApiError(409, 'INVALID_STATE', 'Choose an unjudged buzzer winner first.');
        const generation = database.connection.prepare('SELECT score_generation FROM events WHERE id = ?').get(event.id) as { score_generation: number };
        database.connection.prepare(`INSERT INTO score_transactions (id, participant_id, event_id, session_id, round_id, question_id, buzzer_request_id, transaction_type, points_delta, generation, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'buzzer', ?, ?, ?, ?)`).run(randomUUID(), winner.participant_id, event.id, session.id, question.roundId, question.id, winner.id, action === 'correct' ? question.points : -question.penaltyPoints, generation.score_generation, `Host judged buzzer ${action}`, Date.now());
      }
      if (action === 'reopen') {
        if (!current?.judged) throw new ApiError(409, 'INVALID_STATE', 'Judge the current answer before reopening.');
        database.connection.prepare('DELETE FROM buzzer_requests WHERE session_id = ? AND question_id = ? AND accepted = 0 AND id NOT IN (SELECT buzzer_request_id FROM score_transactions WHERE buzzer_request_id IS NOT NULL)').run(session.id, question.id);
        database.connection.prepare('UPDATE buzzer_requests SET accepted = 0 WHERE session_id = ? AND question_id = ?').run(session.id, question.id);
      }
      if (action === 'open' && winner) throw new ApiError(409, 'INVALID_STATE', 'Use Reopen to release the current winner.');
      repositories.updateEvent(event.id, { settings: { ...event.settings, [key]: { open: action === 'open' || action === 'reopen', judged: action === 'correct' || action === 'incorrect' ? true : action === 'reopen' ? false : current?.judged ?? false } } });
    })();
    wsHub.broadcastLeaderboard(() => ({ eventId: session.eventId, entries: participants.leaderboard(session.eventId) }));
    wsHub.broadcast('question_changed', () => repositories.getSessionState(session.id, 'admin'), () => repositories.getSessionState(session.id, 'public'));
    return { status: 'ok', data: { saved: true } };
  });
  app.get<{ Params: { eventId: string; roundId: string } }>('/api/events/:eventId/rounds/:roundId/questions', async (request) => {
    const round = repositories.getRound(request.params.roundId);
    if (!round || round.eventId !== request.params.eventId) throw new ApiError(404, 'ROUND_NOT_FOUND', 'Round not found.');
    const questions = repositories.listQuestions(round.id).map(({ correctValue: _correctValue, ...publicQuestion }) => publicQuestion);
    return { status: 'ok', data: questions };
  });
  app.post<{ Params: { roundId: string }; Body: unknown }>('/api/admin/rounds/:roundId/questions', async (request, reply) => {
    if (!repositories.getRound(request.params.roundId)) throw new ApiError(404, 'ROUND_NOT_FOUND', 'Round not found.');
    return reply.code(201).send({ status: 'ok', data: repositories.createQuestion(request.params.roundId, request.body) });
  });
  app.get<{ Params: { questionId: string } }>('/api/admin/questions/:questionId', async (request) => {
    const question = repositories.getQuestionAdmin(request.params.questionId);
    if (!question) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'Question not found.');
    return { status: 'ok', data: question };
  });
  app.put<{ Params: { questionId: string }; Body: unknown }>('/api/admin/questions/:questionId', async (request) => {
    const question = repositories.updateQuestion(request.params.questionId, request.body);
    if (!question) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'Question not found.');
    return { status: 'ok', data: question };
  });
  app.delete<{ Params: { questionId: string } }>('/api/admin/questions/:questionId', async (request) => {
    try {
      if (!repositories.deleteQuestion(request.params.questionId)) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'Question not found.');
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('QUESTION_HAS_HISTORY:')) throw new ApiError(409, 'QUESTION_HAS_HISTORY', cause.message.replace('QUESTION_HAS_HISTORY: ', ''));
      throw cause;
    }
    return { status: 'ok', data: { deleted: true } };
  });
  app.post<{ Params: { questionId: string } }>('/api/admin/questions/:questionId/duplicate', async (request) => {
    const question = repositories.duplicateQuestion(request.params.questionId);
    if (!question) throw new ApiError(404, 'QUESTION_NOT_FOUND', 'Question not found.');
    return { status: 'ok', data: question };
  });
  app.post<{ Params: { submissionId: string }; Body: unknown }>('/api/admin/submissions/:submissionId/grade', async (request) => {
    const grade = answers.grade(request.params.submissionId, request.body);
    const submission = database.connection.prepare(`
      SELECT p.event_id FROM answer_submissions s
      JOIN event_participants p ON p.id = s.participant_id WHERE s.id = ?
    `).get(request.params.submissionId) as { event_id: string } | undefined;
    if (submission) {
      wsHub.broadcastLeaderboard(() => ({ eventId: submission.event_id, entries: participants.leaderboard(submission.event_id) }));
    }
    return { status: 'ok', data: grade };
  });
  app.put<{ Params: { roundId: string }; Body: { orderedIds: string[] } }>('/api/admin/rounds/:roundId/questions/order', async (request) => {
    if (!repositories.getRound(request.params.roundId)) throw new ApiError(404, 'ROUND_NOT_FOUND', 'Round not found.');
    if (!Array.isArray(request.body?.orderedIds) || request.body.orderedIds.some((id) => typeof id !== 'string')) throw new ApiError(400, 'VALIDATION_ERROR', 'orderedIds must be an array of strings.');
    return { status: 'ok', data: repositories.reorderQuestions(request.params.roundId, request.body.orderedIds) };
  });

  // Game Sessions
  app.post<{ Params: { eventId: string }; Body: { autoAdvance?: boolean } }>('/api/events/:eventId/session', async (request, reply) => {
    const session = repositories.createSession(request.params.eventId, { autoAdvance: request.body?.autoAdvance });
    wsHub.broadcast(
      'session_started',
      () => repositories.getSessionState(session.id, 'admin'),
      () => repositories.getSessionState(session.id, 'public')
    );
    return reply.code(201).send({ status: 'ok', data: repositories.getSessionState(session.id, 'admin') });
  });

  app.get<{ Params: { eventId: string } }>('/api/events/:eventId/session', async (request) => {
    const session = repositories.getActiveSessionForEvent(request.params.eventId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'No active session found for this event.');
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.get('/api/sessions/active', async () => ({
    status: 'ok',
    data: repositories.listActiveSessions(),
  }));

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (request) => {
    const state = repositories.getSessionState(request.params.sessionId, 'public');
    if (!state) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    return { status: 'ok', data: state };
  });

  app.get<{ Params: { sessionId: string } }>('/api/admin/sessions/:sessionId', async (request) => {
    const state = repositories.getSessionState(request.params.sessionId, 'admin');
    if (!state) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    return { status: 'ok', data: state };
  });

  const rapidFireContext = (sessionId: string, requireActiveTimer: boolean, requireQuestionRevealed = true) => {
    const session = repositories.getSession(sessionId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (!session.currentQuestionId || session.status === 'ended' || session.questionState === 'revealed' || session.questionState === 'completed') {
      throw new ApiError(409, 'INVALID_STATE', 'Rapid-fire controls are unavailable for this session state.');
    }
    const question = repositories.getQuestionAdmin(session.currentQuestionId);
    if (!question || question.questionType !== 'rapid_fire' || question.rapidFireItems.length === 0) {
      throw new ApiError(409, 'INVALID_QUESTION_TYPE', 'The current question is not a configured rapid-fire question.');
    }
    if (requireQuestionRevealed && !repositories.getQuestionReveal(session.id, question.id).questionRevealed) {
      throw new ApiError(409, 'QUESTION_NOT_REVEALED', 'Reveal the question before controlling its rapid-fire prompts.');
    }
    if (requireActiveTimer && (
      session.status !== 'active' ||
      session.questionState !== 'active' ||
      session.deadlineTimestamp === null ||
      session.deadlineTimestamp <= Date.now()
    )) {
      throw new ApiError(409, 'TIMER_NOT_ACTIVE', 'Rapid-fire prompts can only be judged or passed while the timer is running.');
    }
    return { session, question };
  };

  const broadcastRapidFireState = (sessionId: string, eventId: string, leaderboardChanged = false) => {
    wsHub.broadcast(
      'rapid_fire_updated',
      () => repositories.getSessionState(sessionId, 'admin'),
      () => repositories.getSessionState(sessionId, 'public'),
    );
    if (leaderboardChanged) {
      wsHub.broadcastLeaderboard(() => ({ eventId, entries: participants.leaderboard(eventId) }));
    }
  };

  app.put<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/rapid-fire/contestant', async (request) => {
    const { participantId } = z.object({ participantId: z.string().uuid() }).strict().parse(request.body);
    const { session, question } = rapidFireContext(request.params.sessionId, false, false);
    const participant = database.connection.prepare(
      'SELECT id FROM event_participants WHERE id = ? AND event_id = ? AND enabled = 1'
    ).get(participantId, session.eventId) as { id: string } | undefined;
    if (!participant) throw new ApiError(400, 'INVALID_PARTICIPANT', 'Choose an enabled contestant registered for this event.');
    const updateSelection = database.connection.transaction(() => {
      database.connection.prepare(`
        INSERT INTO session_rapid_fire_control (session_id, question_id, selected_participant_id)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id, question_id)
        DO UPDATE SET selected_participant_id = excluded.selected_participant_id
      `).run(session.id, question.id, participantId);
      database.connection.prepare(`
        INSERT OR IGNORE INTO session_rapid_fire_progress (session_id, question_id, participant_id, current_item_index)
        VALUES (?, ?, ?, 0)
      `).run(session.id, question.id, participantId);
    });
    updateSelection();
    broadcastRapidFireState(session.id, session.eventId);
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.put<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/rapid-fire/item', async (request) => {
    const { itemIndex } = z.object({ itemIndex: z.number().int().min(0) }).strict().parse(request.body);
    const { session, question } = rapidFireContext(request.params.sessionId, true);
    if (itemIndex >= question.rapidFireItems.length) throw new ApiError(400, 'INVALID_ITEM', 'That rapid-fire prompt does not exist.');
    const selection = database.connection.prepare(
      'SELECT selected_participant_id FROM session_rapid_fire_control WHERE session_id = ? AND question_id = ?'
    ).get(session.id, question.id) as { selected_participant_id: string | null } | undefined;
    if (!selection?.selected_participant_id) throw new ApiError(409, 'CONTESTANT_NOT_SELECTED', 'Select a contestant before choosing a rapid-fire prompt.');
    const result = database.connection.prepare(`
      SELECT status FROM session_rapid_fire_results
      WHERE session_id = ? AND question_id = ? AND participant_id = ? AND item_index = ?
    `).get(session.id, question.id, selection.selected_participant_id, itemIndex) as { status: string } | undefined;
    if (result && result.status !== 'passed') throw new ApiError(409, 'PROMPT_ALREADY_JUDGED', 'A judged rapid-fire prompt cannot be asked again.');
    database.connection.prepare(`
      UPDATE session_rapid_fire_progress SET current_item_index = ?
      WHERE session_id = ? AND question_id = ? AND participant_id = ?
    `).run(itemIndex, session.id, question.id, selection.selected_participant_id);
    broadcastRapidFireState(session.id, session.eventId);
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/rapid-fire/next', async (request) => {
    const { participantId, itemIndex: expectedItemIndex } = z.object({
      participantId: z.string().uuid(),
      itemIndex: z.number().int().min(0),
    }).strict().parse(request.body);
    const { session, question } = rapidFireContext(request.params.sessionId, true);
    const advance = database.connection.transaction(() => {
      const selection = database.connection.prepare(
        'SELECT selected_participant_id FROM session_rapid_fire_control WHERE session_id = ? AND question_id = ?'
      ).get(session.id, question.id) as { selected_participant_id: string | null } | undefined;
      if (!selection?.selected_participant_id) throw new ApiError(409, 'CONTESTANT_NOT_SELECTED', 'Select a contestant before advancing rapid-fire prompts.');
      if (selection.selected_participant_id !== participantId) throw new ApiError(409, 'STALE_CONTESTANT', 'The selected contestant has changed; review the current rapid-fire prompt.');
      const progress = database.connection.prepare(
        'SELECT current_item_index FROM session_rapid_fire_progress WHERE session_id = ? AND question_id = ? AND participant_id = ?'
      ).get(session.id, question.id, participantId) as { current_item_index: number } | undefined;
      const currentItemIndex = progress?.current_item_index ?? 0;
      if (currentItemIndex !== expectedItemIndex) throw new ApiError(409, 'STALE_PROMPT', 'The current rapid-fire prompt has changed; review it before advancing.');
      const results = database.connection.prepare(`
        SELECT item_index, status FROM session_rapid_fire_results
        WHERE session_id = ? AND question_id = ? AND participant_id = ?
      `).all(session.id, question.id, participantId) as Array<{ item_index: number; status: 'passed' | 'correct' | 'incorrect' }>;
      const statusByIndex = new Map(results.map((result) => [result.item_index, result.status]));
      const nextItemIndex = Array.from({ length: question.rapidFireItems.length - 1 }, (_, offset) =>
        (currentItemIndex + offset + 1) % question.rapidFireItems.length
      ).find((index) => {
        const status = statusByIndex.get(index);
        return status === undefined || status === 'passed';
      });
      if (nextItemIndex === undefined) throw new ApiError(409, 'NO_UNJUDGED_PROMPTS', 'There are no unanswered or passed prompts left to ask.');
      database.connection.prepare(`
        UPDATE session_rapid_fire_progress SET current_item_index = ?
        WHERE session_id = ? AND question_id = ? AND participant_id = ?
      `).run(nextItemIndex, session.id, question.id, participantId);
    });
    advance();
    broadcastRapidFireState(session.id, session.eventId);
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/rapid-fire/judge', async (request) => {
    const { participantId, itemIndex: expectedItemIndex, isCorrect } = z.object({
      participantId: z.string().uuid(),
      itemIndex: z.number().int().min(0),
      isCorrect: z.boolean(),
    }).strict().parse(request.body);
    const { session, question } = rapidFireContext(request.params.sessionId, true);
    const result = database.connection.transaction(() => {
      const selection = database.connection.prepare(
        'SELECT selected_participant_id FROM session_rapid_fire_control WHERE session_id = ? AND question_id = ?'
      ).get(session.id, question.id) as { selected_participant_id: string | null } | undefined;
      if (!selection?.selected_participant_id) throw new ApiError(409, 'CONTESTANT_NOT_SELECTED', 'Select a contestant before judging an answer.');
      if (selection.selected_participant_id !== participantId) throw new ApiError(409, 'STALE_CONTESTANT', 'The selected contestant has changed; review the current rapid-fire prompt.');
      const progress = database.connection.prepare(
        'SELECT current_item_index FROM session_rapid_fire_progress WHERE session_id = ? AND question_id = ? AND participant_id = ?'
      ).get(session.id, question.id, selection.selected_participant_id) as { current_item_index: number } | undefined;
      const itemIndex = progress?.current_item_index ?? 0;
      if (itemIndex !== expectedItemIndex) throw new ApiError(409, 'STALE_PROMPT', 'The current rapid-fire prompt has changed; review it before judging.');
      const previous = database.connection.prepare(`
        SELECT status FROM session_rapid_fire_results
        WHERE session_id = ? AND question_id = ? AND participant_id = ? AND item_index = ?
      `).get(session.id, question.id, selection.selected_participant_id, itemIndex) as { status: string } | undefined;
      if (previous && previous.status !== 'passed') throw new ApiError(409, 'PROMPT_ALREADY_JUDGED', 'This rapid-fire prompt has already been judged.');

      const status = isCorrect ? 'correct' : 'incorrect';
      const timestamp = Date.now();
      database.connection.prepare(`
        INSERT INTO session_rapid_fire_results (session_id, question_id, participant_id, item_index, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, question_id, participant_id, item_index)
        DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
      `).run(session.id, question.id, selection.selected_participant_id, itemIndex, status, timestamp);

      if (isCorrect) {
        const points = Math.floor(question.points / question.rapidFireItems.length)
          + (itemIndex < question.points % question.rapidFireItems.length ? 1 : 0);
        const event = repositories.getEvent(session.eventId);
        if (!event) throw new ApiError(404, 'EVENT_NOT_FOUND', 'Event not found.');
        const generation = database.connection.prepare(
          'SELECT score_generation FROM events WHERE id = ?'
        ).get(session.eventId) as { score_generation: number };
        database.connection.prepare(`
          INSERT INTO score_transactions
            (id, participant_id, event_id, session_id, round_id, question_id, transaction_type, points_delta, generation, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'answer', ?, ?, ?, ?)
        `).run(randomUUID(), selection.selected_participant_id, session.eventId, session.id, question.roundId, question.id, points, generation.score_generation, `Rapid-fire prompt ${itemIndex + 1} answered correctly`, timestamp);
      }

      const results = database.connection.prepare(`
        SELECT item_index, status FROM session_rapid_fire_results
        WHERE session_id = ? AND question_id = ? AND participant_id = ?
      `).all(session.id, question.id, selection.selected_participant_id) as Array<{
        item_index: number;
        status: 'passed' | 'correct' | 'incorrect';
      }>;
      const statusByIndex = new Map(results.map((result) => [result.item_index, result.status]));
      const nextItemIndex = Array.from(
        { length: question.rapidFireItems.length - 1 },
        (_, offset) => (itemIndex + offset + 1) % question.rapidFireItems.length,
      ).find((index) => {
        const nextStatus = statusByIndex.get(index);
        return nextStatus === undefined || nextStatus === 'passed';
      });
      if (nextItemIndex !== undefined) {
        database.connection.prepare(`
          UPDATE session_rapid_fire_progress SET current_item_index = ?
          WHERE session_id = ? AND question_id = ? AND participant_id = ?
        `).run(nextItemIndex, session.id, question.id, selection.selected_participant_id);
      }
    });
    result();
    broadcastRapidFireState(session.id, session.eventId, isCorrect);
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/rapid-fire/pass', async (request) => {
    const { participantId, itemIndex: expectedItemIndex } = z.object({
      participantId: z.string().uuid(),
      itemIndex: z.number().int().min(0),
    }).strict().parse(request.body);
    const { session, question } = rapidFireContext(request.params.sessionId, true);
    const updatePass = database.connection.transaction(() => {
      const selection = database.connection.prepare(
        'SELECT selected_participant_id FROM session_rapid_fire_control WHERE session_id = ? AND question_id = ?'
      ).get(session.id, question.id) as { selected_participant_id: string | null } | undefined;
      if (!selection?.selected_participant_id) throw new ApiError(409, 'CONTESTANT_NOT_SELECTED', 'Select a contestant before passing a prompt.');
      if (selection.selected_participant_id !== participantId) throw new ApiError(409, 'STALE_CONTESTANT', 'The selected contestant has changed; review the current rapid-fire prompt.');
      const progress = database.connection.prepare(
        'SELECT current_item_index FROM session_rapid_fire_progress WHERE session_id = ? AND question_id = ? AND participant_id = ?'
      ).get(session.id, question.id, selection.selected_participant_id) as { current_item_index: number } | undefined;
      const itemIndex = progress?.current_item_index ?? 0;
      if (itemIndex !== expectedItemIndex) throw new ApiError(409, 'STALE_PROMPT', 'The current rapid-fire prompt has changed; review it before passing.');
      const previous = database.connection.prepare(`
        SELECT status FROM session_rapid_fire_results
        WHERE session_id = ? AND question_id = ? AND participant_id = ? AND item_index = ?
      `).get(session.id, question.id, selection.selected_participant_id, itemIndex) as { status: string } | undefined;
      if (previous && previous.status !== 'passed') throw new ApiError(409, 'PROMPT_ALREADY_JUDGED', 'This rapid-fire prompt has already been judged.');
      database.connection.prepare(`
        INSERT INTO session_rapid_fire_results (session_id, question_id, participant_id, item_index, status, updated_at)
        VALUES (?, ?, ?, ?, 'passed', ?)
        ON CONFLICT(session_id, question_id, participant_id, item_index)
        DO UPDATE SET status = 'passed', updated_at = excluded.updated_at
      `).run(session.id, question.id, selection.selected_participant_id, itemIndex, Date.now());
      const answered = database.connection.prepare(`
        SELECT item_index FROM session_rapid_fire_results
        WHERE session_id = ? AND question_id = ? AND participant_id = ?
      `).all(session.id, question.id, selection.selected_participant_id) as Array<{ item_index: number }>;
      const answeredIndexes = new Set(answered.map((result) => result.item_index));
      const nextUnansweredIndex = Array.from({ length: question.rapidFireItems.length - 1 }, (_, offset) =>
        (itemIndex + offset + 1) % question.rapidFireItems.length
      ).find((index) => !answeredIndexes.has(index));
      if (nextUnansweredIndex !== undefined) {
        database.connection.prepare(`
          UPDATE session_rapid_fire_progress SET current_item_index = ?
          WHERE session_id = ? AND question_id = ? AND participant_id = ?
        `).run(nextUnansweredIndex, session.id, question.id, selection.selected_participant_id);
      }
    });
    updatePass();
    broadcastRapidFireState(session.id, session.eventId);
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.put<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/audience-choice', async (request) => {
    const { choiceId } = z.object({ choiceId: z.string().uuid() }).strict().parse(request.body);
    const session = repositories.getSession(request.params.sessionId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status === 'ended' || !session.currentQuestionId || session.questionState === 'revealed' || session.questionState === 'completed') {
      throw new ApiError(409, 'INVALID_STATE', 'A contestant choice can only be confirmed before the answer is revealed.');
    }

    const question = repositories.getQuestionAdmin(session.currentQuestionId);
    if (!question || question.questionType !== 'multiple_choice') {
      throw new ApiError(409, 'INVALID_QUESTION_TYPE', 'Contestant choices can only be confirmed for multiple-choice questions.');
    }
    if (!repositories.getQuestionReveal(session.id, question.id).questionRevealed) {
      throw new ApiError(409, 'QUESTION_NOT_REVEALED', 'Reveal the question before confirming the contestant choice.');
    }
    if (!question.choices.some((choice) => choice.id === choiceId)) {
      throw new ApiError(400, 'INVALID_CHOICE', 'The selected choice does not belong to the current question.');
    }

    repositories.confirmAudienceChoice(session.id, question.id, choiceId);
    wsHub.broadcast(
      'audience_choice_confirmed',
      () => repositories.getSessionState(session.id, 'admin'),
      () => repositories.getSessionState(session.id, 'public'),
    );
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.post<{ Params: { sessionId: string } }>('/api/admin/sessions/:sessionId/reveal-question', async (request) => {
    const session = repositories.getSession(request.params.sessionId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status === 'ended' || !session.currentQuestionId || session.questionState === 'revealed' || session.questionState === 'completed') {
      throw new ApiError(409, 'INVALID_STATE', 'The question cannot be revealed in the current session state.');
    }

    const question = repositories.getQuestionAdmin(session.currentQuestionId);
    if ((question?.questionType === 'rapid_fire' || question?.questionType === 'buzzer') && session.status === 'active' && session.questionState === 'ready') {
      gameEngine.startQuestion(session.id);
    }

    repositories.revealQuestion(session.id, session.currentQuestionId);
    wsHub.broadcast(
      'question_revealed',
      () => repositories.getSessionState(session.id, 'admin'),
      () => repositories.getSessionState(session.id, 'public'),
    );
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.post<{ Params: { sessionId: string } }>('/api/admin/sessions/:sessionId/reveal-next-choice', async (request) => {
    const session = repositories.getSession(request.params.sessionId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status === 'ended' || !session.currentQuestionId || session.questionState === 'revealed' || session.questionState === 'completed') {
      throw new ApiError(409, 'INVALID_STATE', 'An option cannot be revealed in the current session state.');
    }
    const question = repositories.getQuestionAdmin(session.currentQuestionId);
    if (!question || question.questionType !== 'multiple_choice') {
      throw new ApiError(409, 'INVALID_QUESTION_TYPE', 'Options can only be revealed one at a time for multiple-choice questions.');
    }
    const revealState = repositories.getQuestionReveal(session.id, question.id);
    if (!revealState.questionRevealed) {
      throw new ApiError(409, 'QUESTION_NOT_REVEALED', 'Reveal the question before revealing its options.');
    }
    if (revealState.revealedChoiceCount >= question.choices.length) {
      throw new ApiError(409, 'ALL_CHOICES_REVEALED', 'All options for this question have already been revealed.');
    }

    repositories.revealNextChoice(session.id, question.id, question.choices.length);
    wsHub.broadcast(
      'choice_revealed',
      () => repositories.getSessionState(session.id, 'admin'),
      () => repositories.getSessionState(session.id, 'public'),
    );
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/media-fullscreen', async (request) => {
    const session = repositories.getSession(request.params.sessionId);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    const { fullscreen } = z.object({ fullscreen: z.boolean() }).parse(request.body);
    repositories.setMediaFullscreen(session.id, fullscreen);
    wsHub.broadcast(
      'media_fullscreen_toggled',
      () => repositories.getSessionState(session.id, 'admin'),
      () => repositories.getSessionState(session.id, 'public'),
    );
    return { status: 'ok', data: repositories.getSessionState(session.id, 'admin') };
  });

  app.post<{ Params: { sessionId: string }; Body: unknown }>('/api/admin/sessions/:sessionId/control', async (request) => {
    const validated = sessionControlSchema.parse(request.body);
    const updatedState = gameEngine.executeAction(request.params.sessionId, validated);
    return { status: 'ok', data: updatedState };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ status: 'error', error: { code: error.code, message: error.message } });
    }
    if (error instanceof GameEngineError) {
      return reply.status(error.statusCode).send({ status: 'error', error: { code: error.code, message: error.message } });
    }
    if (error instanceof CompetitionError) {
      return reply.status(error.statusCode).send({ status: 'error', error: { code: error.code, message: error.message } });
    }
    if (error instanceof OverlayError) {
      return reply.status(error.statusCode).send({ status: 'error', error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ status: 'error', error: { code: 'VALIDATION_ERROR', message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') } });
    }
    if (error instanceof Error) {
      if (error.message.startsWith('SESSION_ALREADY_ACTIVE:')) {
        return reply.status(409).send({ status: 'error', error: { code: 'SESSION_ALREADY_ACTIVE', message: error.message.replace('SESSION_ALREADY_ACTIVE: ', '') } });
      }
      if (error.message.startsWith('NO_ROUNDS_FOUND:')) {
        return reply.status(400).send({ status: 'error', error: { code: 'NO_ROUNDS_FOUND', message: error.message.replace('NO_ROUNDS_FOUND: ', '') } });
      }
      if (error.message.startsWith('NO_QUESTIONS_FOUND:')) {
        return reply.status(400).send({ status: 'error', error: { code: 'NO_QUESTIONS_FOUND', message: error.message.replace('NO_QUESTIONS_FOUND: ', '') } });
      }
      if (error.message.startsWith('EVENT_NOT_FOUND:')) {
        return reply.status(404).send({ status: 'error', error: { code: 'EVENT_NOT_FOUND', message: error.message.replace('EVENT_NOT_FOUND: ', '') } });
      }
    }
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      const constraintError = error as Error & { code: string };
      app.log.error({ err: constraintError }, 'Database constraint rejected the request');
      return reply.status(409).send({
        status: 'error',
        error: { code: 'CONFLICT', message: constraintError.message },
      });
    }
    app.log.error(error);
    return reply.status(500).send({ status: 'error', error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
  });

  return app;
}

function isAuthorizedAdmin(authorization: string | undefined, expected: string): boolean {
  const supplied = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function readBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match) throw new CompetitionError(401, 'PARTICIPANT_UNAUTHORIZED', 'A valid participant token is required.');
  return match[1];
}

function enforceSubmissionRate(
  attempts: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
): void {
  const now = Date.now();
  const active = (attempts.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (active.length >= limit) {
    attempts.set(key, active);
    throw new ApiError(429, 'RATE_LIMITED', 'Too many submissions. Wait briefly and try again.');
  }
  active.push(now);
  attempts.set(key, active);
  if (attempts.size > 2000) {
    for (const [attemptKey, timestamps] of attempts) {
      if (timestamps.every((timestamp) => now - timestamp >= windowMs)) attempts.delete(attemptKey);
    }
  }
}
