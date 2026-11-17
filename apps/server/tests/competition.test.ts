import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, removeTemporaryDatabase, temporaryDatabase, testAdminToken } from './test-utils.js';
import type { DatabaseHandle } from '../src/database/database.js';

let fixture: ReturnType<typeof temporaryDatabase> | undefined;
let app: ReturnType<typeof buildTestApp> | undefined;

afterEach(async () => {
  if (app) await app.close();
  if (fixture) {
    fixture.database.close();
    removeTemporaryDatabase(fixture.directory);
  }
  app = undefined;
  fixture = undefined;
});

function auth(token: string) {
  return { authorization: ['Bearer ', token].join('') };
}

async function setup(
  questionType: string = 'multiple_choice',
  settings: Record<string, unknown> = {},
  questionOptions: Record<string, unknown> = {},
) {
  fixture = temporaryDatabase();
  app = buildTestApp(fixture.database);
  const event = (await app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { title: `Competition ${Date.now()}`, settings },
  })).json().data;
  const round = (await app.inject({
    method: 'POST',
    url: `/api/events/${event.id}/rounds`,
    payload: { name: 'Round One', roundType: questionType === 'buzzer' ? 'buzzer' : 'quick_questions', orderIndex: 0 },
  })).json().data;
  const participant = (await app.inject({
    method: 'POST',
    url: `/api/events/${event.id}/participants`,
    payload: { participantType: 'contestant', displayName: 'Ada' },
  })).json().data;
  const questionPayload: Record<string, unknown> = {
    questionType,
    prompt: 'Question prompt?',
    durationMs: 120_000,
    points: 10,
    penaltyPoints: 3,
    orderIndex: 0,
    status: 'ready',
  };
  if (questionType === 'multiple_choice') {
    questionPayload.choices = [
      { choiceText: 'Wrong', orderIndex: 0 },
      { choiceText: 'Right', orderIndex: 1, isCorrect: true },
    ];
  } else if (questionType === 'true_false') {
    questionPayload.correctValue = true;
  } else if (questionType === 'rapid_fire') {
    questionPayload.rapidFireItems = [{ prompt: 'Name a city', answerText: 'New York' }];
  } else if (questionType !== 'buzzer') {
    questionPayload.acceptedAnswers = [{ answerText: 'New York' }];
  }
  Object.assign(questionPayload, questionOptions);
  const question = (await app.inject({
    method: 'POST',
    url: `/api/admin/rounds/${round.id}/questions`,
    payload: questionPayload,
  })).json().data;
  const session = (await app.inject({
    method: 'POST',
    url: `/api/events/${event.id}/session`,
  })).json().data;
  return { event, round, participant, question, session };
}

async function startQuestion(sessionId: string) {
  return app!.inject({
    method: 'POST',
    url: `/api/admin/sessions/${sessionId}/control`,
    payload: { action: 'start_question' },
  });
}

describe('answer submission, scoring and standings', () => {
  it('starts the rapid-fire timer when the host reveals a question that is ready', async () => {
    const data = await setup('rapid_fire');

    const reveal = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-question`,
    });

    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().data.questionState).toBe('active');
    expect(reveal.json().data.questionRevealed).toBe(true);
    expect(reveal.json().data.timer.deadlineTimestamp).toBeGreaterThan(Date.now());
  });

  it('registers event-scoped participants and rejects duplicate identities', async () => {
    const data = await setup();
    const duplicate = await app!.inject({
      method: 'POST',
      url: `/api/events/${data.event.id}/participants`,
      payload: { participantType: 'contestant', displayName: ' ADA ' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(data.participant.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const adminList = await app!.inject({
      method: 'GET',
      url: `/api/admin/events/${data.event.id}/participants`,
    });
    expect(adminList.json().data[0]).not.toHaveProperty('token');
    expect(adminList.json().data[0]).not.toHaveProperty('tokenHash');
  });

  it('validates multiple choice on the server and awards a submission only once', async () => {
    const data = await setup();
    await startQuestion(data.session.sessionId);
    const questionAdmin = (await app!.inject({
      method: 'GET',
      url: `/api/admin/questions/${data.question.id}`,
    })).json().data;
    const choiceId = questionAdmin.choices.find((choice: { isCorrect: boolean }) => choice.isCorrect).id;
    const body = { requestId: 'mc-submit-request-0001', choiceId };
    const invalidChoice = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'mc-invalid-choice-0001', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(invalidChoice.statusCode).toBe(400);
    const first = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: body,
    });
    const replay = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.submissionId).toBe(first.json().data.submissionId);
    const crossSessionReplay = await app!.inject({
      method: 'POST',
      url: `/api/sessions/00000000-0000-4000-8000-000000000001/answers`,
      headers: auth(data.participant.token),
      payload: body,
    });
    expect(crossSessionReplay.statusCode).toBe(409);
    expect(first.json().data).not.toHaveProperty('isCorrect');
    const duplicate = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { ...body, requestId: 'mc-submit-request-0002' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect((await app!.inject({
      method: 'GET',
      url: `/api/events/${data.event.id}/leaderboard`,
    })).json().data[0]).toMatchObject({ totalPoints: 10, correctAnswers: 1 });
    const publicState = (await app!.inject({
      method: 'GET',
      url: `/api/sessions/${data.session.sessionId}`,
    })).json().data;
    expect(publicState.question).not.toHaveProperty('correctValue');
    expect(publicState.question.choices[1]).not.toHaveProperty('isCorrect');
    const own = await app!.inject({
      method: 'GET',
      url: `/api/sessions/${data.session.sessionId}/submissions/${data.question.id}`,
      headers: auth(data.participant.token),
    });
    expect(own.json().data.choiceId).toBe(choiceId);
    expect(own.json().data).not.toHaveProperty('isCorrect');
  });

  it('shows only the admin-confirmed contestant choice publicly without revealing correctness', async () => {
    const data = await setup();
    const question = (await app!.inject({
      method: 'GET',
      url: `/api/admin/questions/${data.question.id}`,
    })).json().data;
    const audienceChoiceId = question.choices.find((choice: { isCorrect: boolean }) => !choice.isCorrect).id;
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-question`,
    });
    const confirmed = await app!.inject({
      method: 'PUT',
      url: `/api/admin/sessions/${data.session.sessionId}/audience-choice`,
      payload: { choiceId: audienceChoiceId },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.audienceChoiceId).toBe(audienceChoiceId);

    const publicState = (await app!.inject({
      method: 'GET',
      url: `/api/sessions/${data.session.sessionId}`,
    })).json().data;
    expect(publicState.audienceChoiceId).toBe(audienceChoiceId);
    expect(publicState.question.choices[0]).not.toHaveProperty('isCorrect');
    expect(publicState.question).not.toHaveProperty('correctValue');
    expect(publicState.revealedAnswer).toBeNull();

    await startQuestion(data.session.sessionId);
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reveal_answer' },
    });
    const rejectedAfterReveal = await app!.inject({
      method: 'PUT',
      url: `/api/admin/sessions/${data.session.sessionId}/audience-choice`,
      payload: { choiceId: question.choices[1].id },
    });
    expect(rejectedAfterReveal.statusCode).toBe(409);

    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reopen_question' },
    });
    const reopenedState = (await app!.inject({
      method: 'GET',
      url: `/api/sessions/${data.session.sessionId}`,
    })).json().data;
    expect(reopenedState.audienceChoiceId).toBeNull();
  });

  it('reveals question text and multiple-choice options in admin-controlled stages', async () => {
    const data = await setup();
    fixture!.database.connection.prepare(
      'UPDATE questions SET assigned_participant_id = ? WHERE id = ?',
    ).run(data.participant.id, data.question.id);
    const publicUrl = `/api/sessions/${data.session.sessionId}`;
    const beforeReveal = (await app!.inject({ method: 'GET', url: publicUrl })).json().data;
    expect(beforeReveal.question.questionType).toBe('multiple_choice');
    expect(beforeReveal.question.assignedParticipantId).toBe(data.participant.id);
    expect(beforeReveal.question.prompt).toBe('');
    expect(beforeReveal.question.choices.map((choice: { choiceText: string }) => choice.choiceText)).toEqual(['', '']);
    expect(beforeReveal.questionRevealed).toBe(false);
    expect(beforeReveal.revealedChoiceCount).toBe(0);

    const prematureOption = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-next-choice`,
    });
    expect(prematureOption.statusCode).toBe(409);
    expect(prematureOption.json().error.code).toBe('QUESTION_NOT_REVEALED');

    const questionReveal = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-question`,
    });
    expect(questionReveal.statusCode).toBe(200);
    expect(questionReveal.json().data.questionRevealed).toBe(true);

    const afterQuestion = (await app!.inject({ method: 'GET', url: publicUrl })).json().data;
    expect(afterQuestion.question.prompt).toBe('Question prompt?');
    expect(afterQuestion.question.choices.map((choice: { choiceText: string }) => choice.choiceText)).toEqual(['', '']);

    const firstOption = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-next-choice`,
    });
    expect(firstOption.statusCode).toBe(200);
    expect(firstOption.json().data.revealedChoiceCount).toBe(1);
    const afterFirstOption = (await app!.inject({ method: 'GET', url: publicUrl })).json().data;
    expect(afterFirstOption.question.choices.map((choice: { choiceText: string }) => choice.choiceText)).toEqual(['Wrong', '']);

    const secondOption = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-next-choice`,
    });
    expect(secondOption.statusCode).toBe(200);
    expect(secondOption.json().data.revealedChoiceCount).toBe(2);
    const exhausted = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-next-choice`,
    });
    expect(exhausted.statusCode).toBe(409);
    expect(exhausted.json().error.code).toBe('ALL_CHOICES_REVEALED');

    const revealedQuestion = (await app!.inject({ method: 'GET', url: publicUrl })).json().data;
    expect(revealedQuestion.question.choices.map((choice: { choiceText: string }) => choice.choiceText)).toEqual(['Wrong', 'Right']);
    expect(revealedQuestion.question.choices.every((choice: object) => !('isCorrect' in choice))).toBe(true);
    expect(revealedQuestion.revealedAnswer).toBeNull();

    const started = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'start_question' },
    });
    expect(started.statusCode).toBe(200);
    const revealedAnswer = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reveal_answer' },
    });
    expect(revealedAnswer.statusCode).toBe(200);
    const finalState = (await app!.inject({ method: 'GET', url: publicUrl })).json().data;
    expect(finalState.questionRevealed).toBe(true);
    expect(finalState.revealedChoiceCount).toBe(2);
    expect(finalState.revealedAnswer).not.toBeNull();

    const reopened = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reopen_question' },
    });
    expect(reopened.statusCode).toBe(200);
    const reopenedState = (await app!.inject({ method: 'GET', url: publicUrl })).json().data;
    expect(reopenedState.questionRevealed).toBe(false);
    expect(reopenedState.revealedChoiceCount).toBe(0);
    expect(reopenedState.question.prompt).toBe('');
    expect(reopenedState.question.choices.map((choice: { choiceText: string }) => choice.choiceText)).toEqual(['', '']);
  });

  it('normalizes written answers exactly and scores wrong answers with configured penalties', async () => {
    const data = await setup('written_answer');
    await app!.inject({
      method: 'POST',
      url: `/api/admin/rounds/${data.round.id}/questions`,
      payload: {
        questionType: 'written_answer',
        prompt: 'Second question?',
        durationMs: 120_000,
        points: 8,
        penaltyPoints: 3,
        orderIndex: 1,
        status: 'ready',
        acceptedAnswers: [{ answerText: 'New York' }],
      },
    });
    await startQuestion(data.session.sessionId);
    const correct = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'written-request-0001', responseText: '  NEW   YORK ' },
    });
    expect(correct.statusCode).toBe(200);
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'next_question' },
    });
    await startQuestion(data.session.sessionId);
    const semanticallySimilar = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'written-request-0002', responseText: 'New York City' },
    });
    expect(semanticallySimilar.statusCode).toBe(200);
    const board = (await app!.inject({
      method: 'GET',
      url: `/api/events/${data.event.id}/leaderboard`,
    })).json().data;
    expect(board[0]).toMatchObject({ totalPoints: 7, correctAnswers: 1 });
    const totals = (await app!.inject({
      method: 'GET',
      url: `/api/admin/events/${data.event.id}/submissions`,
    })).json().data;
    expect(totals.map((submission: { isCorrect: boolean }) => submission.isCorrect)).toEqual([false, true]);
  });

  it('permits configured answer changes while reversing the previous score in the audit ledger', async () => {
    const data = await setup('written_answer', { allowAnswerChanges: true });
    await startQuestion(data.session.sessionId);
    const wrong = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'change-request-0001', responseText: 'wrong' },
    });
    const corrected = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'change-request-0002', responseText: 'New York' },
    });
    expect(wrong.statusCode).toBe(200);
    expect(corrected.json().data.changed).toBe(true);
    expect(corrected.json().data.revision).toBe(2);
    expect((await app!.inject({
      method: 'GET',
      url: `/api/events/${data.event.id}/leaderboard`,
    })).json().data[0].totalPoints).toBe(10);
    const ledger = fixture!.database.connection.prepare(
      'SELECT transaction_type, points_delta FROM score_transactions ORDER BY created_at, rowid',
    ).all();
    expect(ledger).toHaveLength(3);
    expect(ledger).toEqual([
      { transaction_type: 'answer', points_delta: -3 },
      { transaction_type: 'reversal', points_delta: 3 },
      { transaction_type: 'answer', points_delta: 10 },
    ]);
  });

  it('supports true/false, rapid-fire, and manually reviewed responses', async () => {
    const trueFalse = await setup('true_false');
    await startQuestion(trueFalse.session.sessionId);
    const truth = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${trueFalse.session.sessionId}/answers`,
      headers: auth(trueFalse.participant.token),
      payload: { requestId: 'true-false-request-001', booleanValue: true },
    });
    expect(truth.statusCode).toBe(200);
    expect((await app!.inject({
      method: 'GET',
      url: `/api/events/${trueFalse.event.id}/leaderboard`,
    })).json().data[0].totalPoints).toBe(10);

    await app!.close();
    fixture!.database.close();
    removeTemporaryDatabase(fixture!.directory);
    app = undefined;
    fixture = undefined;
    const rapid = await setup('rapid_fire');
    await startQuestion(rapid.session.sessionId);
    const rapidAnswer = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${rapid.session.sessionId}/answers`,
      headers: auth(rapid.participant.token),
      payload: { requestId: 'rapid-fire-request-001', responseText: 'New York' },
    });
    expect(rapidAnswer.statusCode).toBe(409);
    expect(rapidAnswer.json().error.code).toBe('HOST_JUDGED');

    await app!.close();
    fixture!.database.close();
    removeTemporaryDatabase(fixture!.directory);
    app = undefined;
    fixture = undefined;
    const manual = await setup('written_answer', {}, {
      manualJudging: true,
      scoring: { speedBonus: { points: 50, thresholdMs: 1 } },
    });
    await startQuestion(manual.session.sessionId);
    fixture!.database.connection.prepare('UPDATE quiz_sessions SET deadline_timestamp = ? WHERE id = ?')
      .run(Date.now() + manual.question.durationMs - 5_000, manual.session.sessionId);
    const pending = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${manual.session.sessionId}/answers`,
      headers: auth(manual.participant.token),
      payload: { requestId: 'manual-review-request-001', responseText: 'New York' },
    });
    expect(pending.json().data.status).toBe('pending_review');
    expect((await app!.inject({
      method: 'GET',
      url: `/api/events/${manual.event.id}/leaderboard`,
    })).json().data[0].totalPoints).toBe(0);
    const grade = await app!.inject({
      method: 'POST',
      url: `/api/admin/submissions/${pending.json().data.submissionId}/grade`,
      payload: { isCorrect: true, reason: 'Reviewed against the answer sheet' },
    });
    expect(grade.json().data.pointsAwarded).toBe(10);
    expect((await app!.inject({
      method: 'GET',
      url: `/api/events/${manual.event.id}/leaderboard`,
    })).json().data[0]).toMatchObject({ totalPoints: 10, correctAnswers: 1 });
  });

  it('scopes answer revisions and idempotency keys to a live session', async () => {
    const data = await setup();
    await startQuestion(data.session.sessionId);
    const choiceId = (await app!.inject({
      method: 'GET',
      url: `/api/admin/questions/${data.question.id}`,
    })).json().data.choices.find((choice: { isCorrect: boolean }) => choice.isCorrect).id;
    const first = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'session-one-answer-0001', choiceId },
    });
    expect(first.statusCode).toBe(200);
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'end_session' },
    });
    const secondSession = (await app!.inject({
      method: 'POST',
      url: `/api/events/${data.event.id}/session`,
    })).json().data;
    await startQuestion(secondSession.sessionId);
    const replay = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${secondSession.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'session-one-answer-0001', choiceId },
    });
    expect(replay.statusCode).toBe(409);
    const second = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${secondSession.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'session-two-answer-0001', choiceId },
    });
    expect(second.statusCode).toBe(200);
    expect(fixture!.database.connection.prepare(
      'SELECT count(*) AS count FROM answer_submissions WHERE participant_id = ? AND question_id = ? AND is_current = 1',
    ).get(data.participant.id, data.question.id)).toEqual({ count: 2 });
  });

  it('allows only one concurrent answer to become the current submission', async () => {
    const data = await setup();
    await startQuestion(data.session.sessionId);
    const choiceId = (await app!.inject({
      method: 'GET',
      url: `/api/admin/questions/${data.question.id}`,
    })).json().data.choices.find((choice: { isCorrect: boolean }) => choice.isCorrect).id;
    const responses = await Promise.all(['concurrent-request-0001', 'concurrent-request-0002'].map((requestId) =>
      app!.inject({
        method: 'POST',
        url: `/api/sessions/${data.session.sessionId}/answers`,
        headers: auth(data.participant.token),
        payload: { requestId, choiceId },
      }),
    ));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(fixture!.database.connection.prepare(
      'SELECT count(*) AS count FROM answer_submissions WHERE is_current = 1',
    ).get()).toEqual({ count: 1 });
  });

  it('rejects participants from other events and disabled participant tokens', async () => {
    const data = await setup();
    const otherEvent = (await app!.inject({
      method: 'POST',
      url: '/api/events',
      payload: { title: 'Another Event' },
    })).json().data;
    const outsider = (await app!.inject({
      method: 'POST',
      url: `/api/events/${otherEvent.id}/participants`,
      payload: { displayName: 'Outsider' },
    })).json().data;
    await startQuestion(data.session.sessionId);
    const rejected = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(outsider.token),
      payload: { requestId: 'cross-event-request-001', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(rejected.statusCode).toBe(403);
    await app!.inject({
      method: 'PATCH',
      url: `/api/admin/participants/${data.participant.id}`,
      payload: { enabled: false },
    });
    const disabled = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'disabled-participant-request', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(disabled.statusCode).toBe(401);
  });

  it('rate limits repeated answer attempts per participant', async () => {
    const data = await setup();
    const attempts = await Promise.all(Array.from({ length: 31 }, (_, index) =>
      app!.inject({
        method: 'POST',
        url: `/api/sessions/${data.session.sessionId}/answers`,
        headers: auth(data.participant.token),
        payload: { requestId: `rate-limit-request-${index.toString().padStart(3, '0')}`, choiceId: '00000000-0000-4000-8000-000000000000' },
      }),
    ));
    expect(attempts.at(-1)?.statusCode).toBe(429);
  });

  it('rejects unauthenticated, paused, expired, revealed, and late answers', async () => {
    const data = await setup();
    await startQuestion(data.session.sessionId);
    const missingIdentity = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      payload: { requestId: 'no-identity-request', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missingIdentity.statusCode).toBe(401);

    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'pause_question' },
    });
    const paused = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'paused-question-request', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(paused.statusCode).toBe(409);

    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reveal_answer' },
    });
    const revealed = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'revealed-question-request', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(revealed.statusCode).toBe(409);

    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reopen_question', reopenAutoStart: true },
    });
    fixture!.database.connection.prepare(
      "UPDATE quiz_sessions SET question_state = 'expired', deadline_timestamp = NULL WHERE id = ?",
    ).run(data.session.sessionId);
    const expired = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'expired-question-request', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(expired.statusCode).toBe(409);

    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reopen_question', reopenAutoStart: true },
    });
    fixture!.database.connection.prepare(
      'UPDATE quiz_sessions SET deadline_timestamp = ? WHERE id = ?',
    ).run(Date.now() - 1, data.session.sessionId);
    const late = await app!.inject({
      method: 'POST',
      url: `/api/sessions/${data.session.sessionId}/answers`,
      headers: auth(data.participant.token),
      payload: { requestId: 'expired-deadline-request', choiceId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(late.statusCode).toBe(409);
  });

  it('serializes concurrent submissions, validates the first buzzer, and ranks ties deterministically', async () => {
    const buzz = await setup('buzzer');
    const secondParticipant = (await app!.inject({
      method: 'POST',
      url: `/api/events/${buzz.event.id}/participants`,
      payload: { participantType: 'team', displayName: 'Bee Team', teamIdentifier: 'B' },
    })).json().data;
    await startQuestion(buzz.session.sessionId);
    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${buzz.session.sessionId}/buzzer-control`,
      payload: { action: 'open' },
    });
    const buzzerResults = await Promise.all([buzz.participant, secondParticipant].map((participant) =>
      app!.inject({
        method: 'POST',
        url: `/api/sessions/${buzz.session.sessionId}/buzzer`,
        headers: auth(participant.token),
        payload: { questionId: buzz.question.id },
      }),
    ));
    expect(buzzerResults.filter((result) => result.json().data.accepted)).toHaveLength(1);
    expect(fixture!.database.connection.prepare(
      'SELECT count(*) AS count FROM buzzer_requests WHERE accepted = 1',
    ).get()).toEqual({ count: 1 });
    expect(fixture!.database.connection.prepare(
      "SELECT count(*) AS count FROM score_transactions WHERE transaction_type = 'buzzer'",
    ).get()).toEqual({ count: 1 });
    const winnerId = (fixture!.database.connection.prepare(
      'SELECT participant_id FROM buzzer_requests WHERE accepted = 1',
    ).get() as { participant_id: string }).participant_id;
    const winner = (await app!.inject({
      method: 'GET',
      url: `/api/events/${buzz.event.id}/leaderboard`,
    })).json().data.find((entry: { participantId: string }) => entry.participantId === winnerId);
    expect(winner).toMatchObject({
      totalPoints: 10,
      correctAnswers: 1,
      rounds: [{ points: 10, correctAnswers: 1 }],
    });
    await app!.inject({
      method: 'POST',
      url: `/api/admin/events/${buzz.event.id}/scores/reset`,
      payload: { confirmation: 'RESET SCORES' },
    });
    const resetWinner = (await app!.inject({
      method: 'GET',
      url: `/api/events/${buzz.event.id}/leaderboard`,
    })).json().data.find((entry: { participantId: string }) => entry.participantId === winnerId);
    expect(resetWinner).toMatchObject({ totalPoints: 0, correctAnswers: 0 });

    await app!.close();
    fixture!.database.close();
    removeTemporaryDatabase(fixture!.directory);
    app = undefined;
    fixture = undefined;
    const tie = await setup('multiple_choice');
    const alpha = (await app!.inject({
      method: 'POST',
      url: `/api/events/${tie.event.id}/participants`,
      payload: { participantType: 'contestant', displayName: 'Alpha' },
    })).json().data;
    await startQuestion(tie.session.sessionId);
    const wrongChoice = (await app!.inject({
      method: 'GET',
      url: `/api/admin/questions/${tie.question.id}`,
    })).json().data.choices.find((choice: { isCorrect: boolean }) => !choice.isCorrect).id;
    const requests = [tie.participant, alpha].map((participant) => app!.inject({
      method: 'POST',
      url: `/api/sessions/${tie.session.sessionId}/answers`,
      headers: auth(participant.token),
      payload: { requestId: `tie-request-${participant.displayName}`, choiceId: wrongChoice },
    }));
    await Promise.all(requests);
    expect((await app!.inject({
      method: 'GET',
      url: `/api/events/${tie.event.id}/leaderboard`,
    })).json().data.map((entry: { displayName: string }) => entry.displayName)).toEqual(['Ada', 'Alpha']);
  });

  it('requires admin authorization and preserves score adjustment and reset audit records', async () => {
    fixture = temporaryDatabase();
    app = (await import('../src/app.js')).buildApp({
      database: fixture.database,
      adminToken: testAdminToken,
    }) as ReturnType<typeof buildTestApp>;
    const denied = await app.inject({ method: 'POST', url: '/api/events', payload: { title: 'Denied' } });
    expect(denied.statusCode).toBe(401);
    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/admin/auth',
      headers: auth('incorrect-admin-secret'),
    });
    expect(badLogin.statusCode).toBe(401);
    const created = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: auth(testAdminToken),
      payload: { title: 'Authorized Event' },
    });
    expect(created.statusCode).toBe(201);
    const eventId = created.json().data.id;
    const participant = (await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/participants`,
      payload: { displayName: 'Host-managed' },
    })).json().data;
    const adjustment = await app.inject({
      method: 'POST',
      url: `/api/admin/events/${eventId}/scores/adjust`,
      headers: auth(testAdminToken),
      payload: { participantId: participant.id, pointsDelta: 12, reason: 'Opening correction' },
    });
    expect(adjustment.statusCode).toBe(200);
    const invalidReset = await app.inject({
      method: 'POST',
      url: `/api/admin/events/${eventId}/scores/reset`,
      headers: auth(testAdminToken),
      payload: { confirmation: 'reset' },
    });
    expect(invalidReset.statusCode).toBe(400);
    const reset = await app.inject({
      method: 'POST',
      url: `/api/admin/events/${eventId}/scores/reset`,
      headers: auth(testAdminToken),
      payload: { confirmation: 'RESET SCORES' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET',
      url: `/api/events/${eventId}/leaderboard`,
    })).json().data[0]).toMatchObject({ totalPoints: 0, correctAnswers: 0 });
    expect(fixture.database.connection.prepare(
      'SELECT transaction_type, points_delta FROM score_transactions ORDER BY created_at, rowid',
    ).all()).toEqual([
      { transaction_type: 'admin_adjustment', points_delta: 12 },
      { transaction_type: 'reset', points_delta: 0 },
    ]);
  });

  it('lets the host pass, revisit, and score individual rapid-fire prompts without exposing answers publicly', async () => {
    const data = await setup('rapid_fire', {}, {
      points: 10,
      rapidFireItems: [
        { prompt: 'Prompt one?', answerText: 'Answer one' },
        { prompt: 'Prompt two?', answerText: 'Answer two' },
        { prompt: 'Prompt three?', answerText: 'Answer three' },
      ],
    });
    await startQuestion(data.session.sessionId);
    const reveal = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/reveal-question`,
    });
    expect(reveal.statusCode).toBe(200);
    const selectContestant = await app!.inject({
      method: 'PUT',
      url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/contestant`,
      payload: { participantId: data.participant.id },
    });
    expect(selectContestant.statusCode).toBe(200);
    const adminState = await app!.inject({
      method: 'GET',
      url: `/api/admin/sessions/${data.session.sessionId}`,
    });
    expect(adminState.json().data.question.rapidFireItems.map((item: { answerText: string }) => item.answerText))
      .toEqual(['Answer one', 'Answer two', 'Answer three']);

    const publicState = await app!.inject({
      method: 'GET',
      url: `/api/sessions/${data.session.sessionId}`,
    });
    expect(publicState.json().data.rapidFire.items.map((item: { prompt: string | null }) => item.prompt))
      .toEqual(['Prompt one?', null, null]);
    expect(JSON.stringify(publicState.json().data)).not.toContain('Answer one');

    const passFirst = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/pass`,
      payload: { participantId: data.participant.id, itemIndex: 0 },
    });
    expect(passFirst.statusCode).toBe(200);
    expect(passFirst.json().data.rapidFire.currentItemIndex).toBe(1);
    const staleJudge = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/judge`,
      payload: { participantId: data.participant.id, itemIndex: 0, isCorrect: true },
    });
    expect(staleJudge.statusCode).toBe(409);
    const passSecond = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/pass`,
      payload: { participantId: data.participant.id, itemIndex: 1 },
    });
    expect(passSecond.statusCode).toBe(200);
    expect(passSecond.json().data.rapidFire.currentItemIndex).toBe(2);
    const revisitSecond = await app!.inject({
      method: 'PUT',
      url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/item`,
      payload: { itemIndex: 1 },
    });
    expect(revisitSecond.statusCode).toBe(200);
    for (const [itemIndex, expectedNextIndex] of [[1, 2], [2, 0], [0, 0]]) {
      const judge = await app!.inject({
        method: 'POST',
        url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/judge`,
        payload: { participantId: data.participant.id, itemIndex, isCorrect: true },
      });
      expect(judge.statusCode).toBe(200);
      expect(judge.json().data.rapidFire.currentItemIndex).toBe(expectedNextIndex);
    }

    const leaderboard = await app!.inject({
      method: 'GET',
      url: `/api/events/${data.event.id}/leaderboard`,
    });
    expect(leaderboard.json().data[0].totalPoints).toBe(10);
    const answerLedger = fixture!.database.connection.prepare(
      "SELECT points_delta FROM score_transactions WHERE question_id = ? AND transaction_type = 'answer' ORDER BY created_at, rowid"
    ).all(data.question.id) as Array<{ points_delta: number }>;
    expect(answerLedger.map((row) => row.points_delta)).toEqual([3, 3, 4]);
    const publicAfterJudging = await app!.inject({
      method: 'GET',
      url: `/api/sessions/${data.session.sessionId}`,
    });
    expect(publicAfterJudging.json().data.rapidFire.items.map((item: { status: string }) => item.status))
      .toEqual(['correct', 'correct', 'correct']);
    const secondParticipant = (await app!.inject({
      method: 'POST',
      url: `/api/events/${data.event.id}/participants`,
      payload: { participantType: 'contestant', displayName: 'Grace' },
    })).json().data;
    await app!.inject({
      method: 'PUT',
      url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/contestant`,
      payload: { participantId: secondParticipant.id },
    });
    const incorrectJudge = await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/rapid-fire/judge`,
      payload: { participantId: secondParticipant.id, itemIndex: 0, isCorrect: false },
    });
    expect(incorrectJudge.statusCode).toBe(200);
    expect(incorrectJudge.json().data.rapidFire.currentItemIndex).toBe(1);
    expect(incorrectJudge.json().data.rapidFire.items[0].status).toBe('incorrect');

    await app!.inject({
      method: 'POST',
      url: `/api/admin/sessions/${data.session.sessionId}/control`,
      payload: { action: 'reveal_answer' },
    });
    const revealedPublicState = await app!.inject({
      method: 'GET',
      url: `/api/sessions/${data.session.sessionId}`,
    });
    expect(revealedPublicState.json().data.rapidFire.items.map((item: { answerText: string | null }) => item.answerText))
      .toEqual(['Answer one', 'Answer two', 'Answer three']);
  });
});
