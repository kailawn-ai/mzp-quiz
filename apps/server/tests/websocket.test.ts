import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AppInstance } from '../src/app.js';
import { buildTestApp, removeTemporaryDatabase, temporaryDatabase, testAdminToken } from './test-utils.js';

describe('Real-Time WebSocket Communication & Answer Security', () => {
  let fixture: ReturnType<typeof temporaryDatabase> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let serverPort: number;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }
    sockets.length = 0;

    if (app) await app.close();
    if (fixture) {
      fixture.database.close();
      removeTemporaryDatabase(fixture.directory);
    }
  });

  async function startServerWithSession() {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);

    // Start listening on dynamic port
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = new URL(address);
    serverPort = Number(url.port);

    // Create Event, Round, Question
    const eventRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { title: 'WebSocket Live Championship' },
    });
    const eventId = eventRes.json().data.id;

    const roundRes = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/rounds`,
      payload: { name: 'Trivia Round', roundType: 'multiple_choice', orderIndex: 0 },
    });
    const roundId = roundRes.json().data.id;

    const qRes = await app.inject({
      method: 'POST',
      url: `/api/admin/rounds/${roundId}/questions`,
      payload: {
        questionType: 'multiple_choice',
        prompt: 'Which planet is known as the Red Planet?',
        durationMs: 400,
        points: 10,
        penaltyPoints: 0,
        orderIndex: 0,
        explanation: 'Mars appears red because of iron oxide.',
        choices: [
          { choiceText: 'Venus', orderIndex: 0, isCorrect: false },
          { choiceText: 'Mars', orderIndex: 1, isCorrect: true },
          { choiceText: 'Jupiter', orderIndex: 2, isCorrect: false },
        ],
      },
    });
    const questionId = qRes.json().data.id;

    // Start Session
    const sessionRes = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/session`,
    });
    const sessionId = sessionRes.json().data.sessionId;

    return { eventId, roundId, questionId, sessionId };
  }

  function connectClient(path = '/ws', authenticatedAdmin = false): Promise<{ ws: WebSocket; messages: any[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${serverPort}${path}`,
        authenticatedAdmin ? ['mzp-admin', `mzp-token.${testAdminToken}`] : undefined,
      );
      sockets.push(ws);
      const messages: any[] = [];

      ws.on('message', (data) => {
        try {
          messages.push(JSON.parse(data.toString()));
        } catch {
          // ignore non-json
        }
      });

      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', (err) => reject(err));
    });
  }

  function waitForMessage(messages: any[], predicate: (msg: any) => boolean, timeout = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        const found = messages.find(predicate);
        if (found) {
          clearInterval(interval);
          resolve(found);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for message matching predicate. Received: ${JSON.stringify(messages)}`));
        }
      }, 20);
    });
  }

  it('allows the WebSocket hub to be closed before Fastify shutdown without closing twice', async () => {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);
    const appInstance = app as AppInstance;

    appInstance.wsHub.close();
    expect(() => appInstance.wsHub.close()).not.toThrow();
    await app.close();
    app = undefined;
  });

  it('sends immediate state sync upon connection and prevents answer key leakage to public clients', async () => {
    const { sessionId } = await startServerWithSession();

    // Connect Public Client
    const { messages: publicMessages } = await connectClient('/ws');
    const syncMsg = await waitForMessage(publicMessages, (m) => m.type === 'state_sync');
    expect(syncMsg).toBeDefined();

    const publicPayload = syncMsg.payload;
    expect(publicPayload.sessionId).toBe(sessionId);
    expect(publicPayload.question.prompt).toBe('');
    expect(publicPayload.question.questionType).toBe('multiple_choice');
    expect(publicPayload.question.choices[0].choiceText).toBe('');
    // CRITICAL: Public client must NOT have correct answers, explanation, or correct choices before reveal
    expect(publicPayload.question).not.toHaveProperty('correctValue');
    expect(publicPayload.question).not.toHaveProperty('acceptedAnswers');
    expect(publicPayload.question.explanation).toBeNull();
    for (const choice of publicPayload.question.choices) {
      expect(choice).not.toHaveProperty('isCorrect');
    }
    expect(publicPayload.revealedAnswer).toBeNull();

    // Connect Admin Client
    const { messages: adminMessages } = await connectClient('/ws?role=admin', true);
    const adminSyncMsg = await waitForMessage(adminMessages, (m) => m.type === 'state_sync');
    const adminPayload = adminSyncMsg.payload;
    expect(adminPayload.question.choices.find((c: any) => c.isCorrect).choiceText).toBe('Mars');
    expect(adminPayload.question.explanation).toBe('Mars appears red because of iron oxide.');
  });

  it('does not grant admin state to a caller-controlled role query', async () => {
    await startServerWithSession();
    const { messages } = await connectClient('/ws?role=admin');
    const sync = await waitForMessage(messages, (message) => message.type === 'state_sync');
    expect(sync.payload.question).not.toHaveProperty('correctValue');
    expect(sync.payload.question.choices[1]).not.toHaveProperty('isCorrect');
  });

  it('broadcasts a confirmed contestant choice to the public overlay before reveal', async () => {
    const { questionId, sessionId } = await startServerWithSession();
    const question = (await app!.inject({
      method: 'GET',
      url: `/api/admin/questions/${questionId}`,
    })).json().data;
    const selectedChoice = question.choices[0];
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/reveal-question`,
    });
    const { messages } = await connectClient('/ws');
    await waitForMessage(messages, (message) => message.type === 'state_sync');

    const confirmed = await app!.inject({
      method: 'PUT',
      url: `/api/admin/sessions/${sessionId}/audience-choice`,
      payload: { choiceId: selectedChoice.id },
    });
    expect(confirmed.statusCode).toBe(200);

    const update = await waitForMessage(messages, (message) => message.type === 'audience_choice_confirmed');
    expect(update.payload.audienceChoiceId).toBe(selectedChoice.id);
    expect(update.payload.question.choices[0]).not.toHaveProperty('isCorrect');
    expect(update.payload.revealedAnswer).toBeNull();
  });

  it('continues broadcasting answer submissions without exposing vote counts or answer keys', async () => {
    const { eventId, questionId, sessionId } = await startServerWithSession();
    const participant = (await app!.inject({
      method: 'POST',
      url: `/api/events/${eventId}/participants`,
      payload: { participantType: 'contestant', displayName: 'Ada' },
    })).json().data;
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'start_question' },
    });
    const question = (await app!.inject({
      method: 'GET',
      url: `/api/admin/questions/${questionId}`,
    })).json().data;
    const { messages } = await connectClient('/ws');
    await waitForMessage(messages, (message) => message.type === 'state_sync');

    await app!.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/answers`,
      headers: { authorization: ['Bearer ', participant.token].join('') },
      payload: { requestId: 'ws-answer-submit-0001', choiceId: question.choices[0].id },
    });

    const update = await waitForMessage(messages, (message) => message.type === 'answer_submitted');
    expect(update.payload.question.choices[0]).not.toHaveProperty('selectionCount');
    expect(update.payload.question.choices[0]).not.toHaveProperty('isCorrect');
    expect(update.payload.revealedAnswer).toBeNull();
  });

  it('broadcasts real-time events for timer, question control, answer reveal, and session end', async () => {
    const { sessionId } = await startServerWithSession();

    const { messages: publicMessages } = await connectClient('/ws');
    const { messages: adminMessages } = await connectClient('/ws?role=admin');

    // Wait for initial sync
    await waitForMessage(publicMessages, (m) => m.type === 'state_sync');
    await waitForMessage(adminMessages, (m) => m.type === 'state_sync');

    // 1. Start question
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'start_question' },
    });

    const startMsg = await waitForMessage(publicMessages, (m) => m.type === 'timer_started');
    expect(startMsg.payload.questionState).toBe('active');
    expect(startMsg.payload.timer.deadlineTimestamp).toBeGreaterThan(Date.now());

    // 2. Pause question
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'pause_question' },
    });
    const pauseMsg = await waitForMessage(publicMessages, (m) => m.type === 'timer_paused');
    expect(pauseMsg.payload.questionState).toBe('paused');

    // 3. Reveal answer
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'reveal_answer' },
    });
    const revealMsg = await waitForMessage(publicMessages, (m) => m.type === 'answer_revealed');
    expect(revealMsg.payload.questionState).toBe('revealed');
    // Now that answers are revealed, public message safely includes the reveal info!
    expect(revealMsg.payload.revealedAnswer).toBeDefined();
    expect(revealMsg.payload.revealedAnswer.correctChoices[0].choiceText).toBe('Mars');

    // 4. End session
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'end_session' },
    });
    const endMsg = await waitForMessage(publicMessages, (m) => m.type === 'session_ended');
    expect(endMsg.payload.status).toBe('ended');
  });

  it('reconnecting client immediately receives updated state', async () => {
    const { sessionId } = await startServerWithSession();

    // Start question
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'start_question' },
    });

    // Reconnect new client
    const { messages: reconnectedMessages } = await connectClient('/ws');
    const syncMsg = await waitForMessage(reconnectedMessages, (m) => m.type === 'state_sync');
    expect(syncMsg.payload.questionState).toBe('active');
    expect(syncMsg.payload.timer.deadlineTimestamp).toBeGreaterThan(Date.now());
  });
});
