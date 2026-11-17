import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, removeTemporaryDatabase, temporaryDatabase } from './test-utils.js';

describe('Game Session Management & Engine', () => {
  let fixture: ReturnType<typeof temporaryDatabase> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (fixture) {
      fixture.database.close();
      removeTemporaryDatabase(fixture.directory);
    }
  });

  async function createTestEventWithQuestions() {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);

    // Create Event
    const eventRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { title: 'Championship Live Quiz' },
    });
    const eventId = eventRes.json().data.id;

    // Create Round 1
    const round1Res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/rounds`,
      payload: { name: 'Round 1: Quick Fire', roundType: 'quick_questions', orderIndex: 0 },
    });
    const round1Id = round1Res.json().data.id;

    // Create Questions for Round 1
    const q1Res = await app.inject({
      method: 'POST',
      url: `/api/admin/rounds/${round1Id}/questions`,
      payload: {
        questionType: 'multiple_choice',
        prompt: 'What is 2 + 2?',
        durationMs: 500, // Short for testing
        points: 10,
        penaltyPoints: 0,
        orderIndex: 0,
        choices: [
          { choiceText: '3', orderIndex: 0, isCorrect: false },
          { choiceText: '4', orderIndex: 1, isCorrect: true },
        ],
      },
    });
    const q1Id = q1Res.json().data.id;

    const q2Res = await app.inject({
      method: 'POST',
      url: `/api/admin/rounds/${round1Id}/questions`,
      payload: {
        questionType: 'true_false',
        prompt: 'The sky is green.',
        durationMs: 800,
        points: 5,
        penaltyPoints: 2,
        orderIndex: 1,
        correctValue: false,
      },
    });
    const q2Id = q2Res.json().data.id;

    // Create Round 2 with one question
    const round2Res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/rounds`,
      payload: { name: 'Round 2: Written', roundType: 'written_answer', orderIndex: 1 },
    });
    const round2Id = round2Res.json().data.id;

    const q3Res = await app.inject({
      method: 'POST',
      url: `/api/admin/rounds/${round2Id}/questions`,
      payload: {
        questionType: 'short_answer',
        prompt: 'Capital of France?',
        durationMs: 1000,
        points: 20,
        penaltyPoints: 0,
        orderIndex: 0,
        acceptedAnswers: [{ answerText: 'Paris' }, { answerText: 'paris' }],
      },
    });
    const q3Id = q3Res.json().data.id;

    return { eventId, round1Id, round2Id, q1Id, q2Id, q3Id };
  }

  it('starts a session and prevents duplicate simultaneous sessions for the same event', async () => {
    const { eventId, q1Id } = await createTestEventWithQuestions();

    const startRes = await app!.inject({
      method: 'POST',
      url: `/api/events/${eventId}/session`,
    });
    expect(startRes.statusCode).toBe(201);
    const sessionData = startRes.json().data;
    expect(sessionData.status).toBe('active');
    expect(sessionData.questionState).toBe('ready');
    expect(sessionData.question.id).toBe(q1Id);
    expect(sessionData.timer.timeRemainingMs).toBe(500);

    // Attempt to start a second session for the same event
    const duplicateRes = await app!.inject({
      method: 'POST',
      url: `/api/events/${eventId}/session`,
    });
    expect(duplicateRes.statusCode).toBe(409);
    expect(duplicateRes.json().error.code).toBe('SESSION_ALREADY_ACTIVE');

    // Retrieve active session for event
    const activeRes = await app!.inject({
      method: 'GET',
      url: `/api/events/${eventId}/session`,
    });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json().data.sessionId).toBe(sessionData.sessionId);
  });

  it('manages question lifecycle: READY -> ACTIVE -> PAUSED -> ACTIVE -> EXPIRED -> REOPENED', async () => {
    const { eventId } = await createTestEventWithQuestions();
    const startRes = await app!.inject({ method: 'POST', url: `/api/events/${eventId}/session` });
    const sessionId = startRes.json().data.sessionId;

    // 1. Start question
    const qStartRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'start_question' },
    });
    expect(qStartRes.statusCode).toBe(200);
    expect(qStartRes.json().data.questionState).toBe('active');
    expect(qStartRes.json().data.timer.deadlineTimestamp).toBeGreaterThan(Date.now());

    // 2. Pause question
    const pauseRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'pause_question' },
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().data.questionState).toBe('paused');
    expect(pauseRes.json().data.timer.isPaused).toBe(true);
    expect(pauseRes.json().data.timer.deadlineTimestamp).toBeNull();
    const remainingAfterPause = pauseRes.json().data.timer.timeRemainingMs;
    expect(remainingAfterPause).toBeGreaterThan(0);
    expect(remainingAfterPause).toBeLessThanOrEqual(500);

    // 3. Resume question
    const resumeRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'resume_question' },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json().data.questionState).toBe('active');
    expect(resumeRes.json().data.timer.isPaused).toBe(false);

    // 4. Wait for timer expiration
    await new Promise((resolve) => setTimeout(resolve, 600));

    const checkExpiredRes = await app!.inject({
      method: 'GET',
      url: `/api/admin/sessions/${sessionId}`,
    });
    expect(checkExpiredRes.json().data.questionState).toBe('expired');
    expect(checkExpiredRes.json().data.timer.timeRemainingMs).toBe(0);

    // 5. Reopen question
    const reopenRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'reopen_question' },
    });
    expect(reopenRes.statusCode).toBe(200);
    expect(reopenRes.json().data.questionState).toBe('ready');
    expect(reopenRes.json().data.timer.timeRemainingMs).toBe(500);
  });

  it('rejects invalid state transitions with appropriate error codes', async () => {
    const { eventId } = await createTestEventWithQuestions();
    const startRes = await app!.inject({ method: 'POST', url: `/api/events/${eventId}/session` });
    const sessionId = startRes.json().data.sessionId;

    // Cannot pause when question is 'ready'
    const invalidPause = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'pause_question' },
    });
    expect(invalidPause.statusCode).toBe(409);
    expect(invalidPause.json().error.code).toBe('INVALID_STATE');

    // Cannot resume when question is 'ready'
    const invalidResume = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'resume_question' },
    });
    expect(invalidResume.statusCode).toBe(409);

    // Cannot reopen when question is 'ready'
    const invalidReopen = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'reopen_question' },
    });
    expect(invalidReopen.statusCode).toBe(409);
  });

  it('handles reveal answer, question advancing within round, across rounds, and session completion', async () => {
    const { eventId, q1Id, q2Id, q3Id } = await createTestEventWithQuestions();
    const startRes = await app!.inject({ method: 'POST', url: `/api/events/${eventId}/session` });
    const sessionId = startRes.json().data.sessionId;

    // Start Question 1
    await app!.inject({ method: 'POST', url: `/api/admin/sessions/${sessionId}/control`, payload: { action: 'start_question' } });

    // Reveal Answer for Question 1
    const revealRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'reveal_answer' },
    });
    expect(revealRes.statusCode).toBe(200);
    expect(revealRes.json().data.questionState).toBe('revealed');
    expect(revealRes.json().data.revealedAnswer).not.toBeNull();
    expect(revealRes.json().data.revealedAnswer.correctChoices[0].choiceText).toBe('4');

    // Advance to Question 2 in Round 1
    const next1Res = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'next_question' },
    });
    expect(next1Res.statusCode).toBe(200);
    expect(next1Res.json().data.question.id).toBe(q2Id);
    expect(next1Res.json().data.questionState).toBe('ready');
    expect(next1Res.json().data.round.currentQuestionIndex).toBe(1);

    // Advance to Question 3 in Round 2
    const next2Res = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'next_question' },
    });
    expect(next2Res.statusCode).toBe(200);
    expect(next2Res.json().data.question.id).toBe(q3Id);
    expect(next2Res.json().data.round.name).toBe('Round 2: Written');
    expect(next2Res.json().data.round.currentQuestionIndex).toBe(0);

    // Advance past last question -> session completes and ends
    const endRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'next_question' },
    });
    expect(endRes.statusCode).toBe(200);
    expect(endRes.json().data.status).toBe('ended');
    expect(endRes.json().data.questionState).toBe('completed');
  });

  it('pauses, resumes, and ends the overall quiz session', async () => {
    const { eventId } = await createTestEventWithQuestions();
    const startRes = await app!.inject({ method: 'POST', url: `/api/events/${eventId}/session` });
    const sessionId = startRes.json().data.sessionId;

    // Start question first
    await app!.inject({ method: 'POST', url: `/api/admin/sessions/${sessionId}/control`, payload: { action: 'start_question' } });

    // Pause session
    const pauseSessionRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'pause_session' },
    });
    expect(pauseSessionRes.statusCode).toBe(200);
    expect(pauseSessionRes.json().data.status).toBe('paused');
    expect(pauseSessionRes.json().data.questionState).toBe('paused');

    // Resume session
    const resumeSessionRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'resume_session' },
    });
    expect(resumeSessionRes.statusCode).toBe(200);
    expect(resumeSessionRes.json().data.status).toBe('active');

    // End session explicitly
    const endSessionRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/control`,
      payload: { action: 'end_session' },
    });
    expect(endSessionRes.statusCode).toBe(200);
    expect(endSessionRes.json().data.status).toBe('ended');

    // Now another session can be created for this event
    const newSessionRes = await app!.inject({
      method: 'POST',
      url: `/api/events/${eventId}/session`,
    });
    expect(newSessionRes.statusCode).toBe(201);
  });

  it('persists session state across server restarts and recovers cleanly', async () => {
    const { eventId } = await createTestEventWithQuestions();
    const startRes = await app!.inject({ method: 'POST', url: `/api/events/${eventId}/session` });
    const sessionId = startRes.json().data.sessionId;

    // Start Question
    await app!.inject({ method: 'POST', url: `/api/admin/sessions/${sessionId}/control`, payload: { action: 'start_question' } });

    // Pause it with remaining time preserved
    await app!.inject({ method: 'POST', url: `/api/admin/sessions/${sessionId}/control`, payload: { action: 'pause_question' } });

    // Simulate backend restart by closing app and creating a new app pointing to same database
    await app!.close();
    app = buildTestApp(fixture!.database);

    // Verify session state was cleanly recovered
    const recoveredRes = await app.inject({
      method: 'GET',
      url: `/api/admin/sessions/${sessionId}`,
    });
    expect(recoveredRes.statusCode).toBe(200);
    expect(recoveredRes.json().data.sessionId).toBe(sessionId);
    expect(recoveredRes.json().data.status).toBe('active');
    expect(recoveredRes.json().data.questionState).toBe('paused');
    expect(recoveredRes.json().data.timer.timeRemainingMs).toBeGreaterThan(0);
  });

  it('toggles realtime media fullscreen on and off for the active session', async () => {
    const { eventId } = await createTestEventWithQuestions();
    const startRes = await app!.inject({ method: 'POST', url: `/api/events/${eventId}/session` });
    const sessionId = startRes.json().data.sessionId;

    // Initially mediaFullscreen is false
    const initial = (await app!.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json().data;
    expect(initial.mediaFullscreen).toBe(false);

    // Turn on fullscreen
    const enableRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/media-fullscreen`,
      payload: { fullscreen: true },
    });
    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json().data.mediaFullscreen).toBe(true);

    const publicEnabled = (await app!.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json().data;
    expect(publicEnabled.mediaFullscreen).toBe(true);

    // Turn off fullscreen
    const disableRes = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${sessionId}/media-fullscreen`,
      payload: { fullscreen: false },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().data.mediaFullscreen).toBe(false);
  });
});
