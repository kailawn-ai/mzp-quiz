import type { Repositories } from '../database/repositories.js';
import type { WebSocketHub } from './websocket.js';
import type { SessionAction, SessionControlInput, WebSocketEventType } from '@mzp-quiz/shared';

export class GameEngineError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'GameEngineError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class GameEngine {
  private activeTimers = new Map<string, NodeJS.Timeout>();
  private repositories: Repositories;
  private wsHub: WebSocketHub;

  constructor(
    repositories: Repositories,
    wsHub: WebSocketHub
  ) {
    this.repositories = repositories;
    this.wsHub = wsHub;
    // Provide active session state to websocket clients on connect or get_state
    this.wsHub.registerStateProvider((role: 'admin' | 'public') => {
      const activeSessions = this.repositories.listActiveSessions();
      if (activeSessions.length > 0) {
        return this.repositories.getSessionState(activeSessions[0].id, role);
      }
      return null;
    });

    this.recoverFromRestart();
  }

  private clearTimer(sessionId: string) {
    const timer = this.activeTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(sessionId);
    }
  }

  private broadcastState(sessionId: string, event: WebSocketEventType) {
    this.wsHub.broadcast(
      event,
      () => this.repositories.getSessionState(sessionId, 'admin'),
      () => this.repositories.getSessionState(sessionId, 'public')
    );
  }

  public recoverFromRestart() {
    const activeSessions = this.repositories.listActiveSessions();
    const now = Date.now();

    for (const session of activeSessions) {
      if (session.status === 'active' && session.questionState === 'active') {
        if (session.deadlineTimestamp && session.deadlineTimestamp > now) {
          const remaining = session.deadlineTimestamp - now;
          this.clearTimer(session.id);
          this.activeTimers.set(
            session.id,
            setTimeout(() => this.onTimerExpired(session.id), remaining)
          );
        } else {
          // Timer expired while server was offline
          this.repositories.updateSession(session.id, {
            question_state: 'expired',
            time_remaining_ms: 0,
            deadline_timestamp: null,
          });
        }
      }
    }
  }

  private onTimerExpired(sessionId: string) {
    this.clearTimer(sessionId);
    const session = this.repositories.getSession(sessionId);
    if (!session || session.status !== 'active' || session.questionState !== 'active') {
      return;
    }

    this.repositories.updateSession(sessionId, {
      question_state: 'expired',
      time_remaining_ms: 0,
      deadline_timestamp: null,
    });

    this.broadcastState(sessionId, 'timer_expired');
  }

  public executeAction(sessionId: string, input: SessionControlInput) {
    const session = this.repositories.getSession(sessionId);
    if (!session) {
      throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Live quiz session not found.');
    }

    switch (input.action) {
      case 'start_question':
        return this.startQuestion(session.id);
      case 'pause_question':
        return this.pauseQuestion(session.id);
      case 'resume_question':
        return this.resumeQuestion(session.id);
      case 'expire_question':
        return this.expireQuestion(session.id);
      case 'reveal_answer':
        return this.revealAnswer(session.id);
      case 'reopen_question':
        return this.reopenQuestion(session.id, Boolean(input.reopenAutoStart));
      case 'next_question':
        return this.nextQuestion(session.id);
      case 'previous_question':
        return this.previousQuestion(session.id);
      case 'pause_session':
        return this.pauseSession(session.id);
      case 'resume_session':
        return this.resumeSession(session.id);
      case 'end_session':
        return this.endSession(session.id);
      default:
        throw new GameEngineError(400, 'INVALID_ACTION', `Unknown action: ${(input as any).action}`);
    }
  }

  public startQuestion(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status !== 'active') {
      throw new GameEngineError(409, 'INVALID_STATE', 'Cannot start a question when the session is not active.');
    }
    if (session.questionState !== 'ready') {
      throw new GameEngineError(409, 'INVALID_STATE', `Cannot start question from state: ${session.questionState}`);
    }

    const duration = session.timeRemainingMs > 0 ? session.timeRemainingMs : 30000;
    const deadline = Date.now() + duration;

    this.clearTimer(sessionId);
    this.repositories.updateSession(sessionId, {
      question_state: 'active',
      time_remaining_ms: duration,
      deadline_timestamp: deadline,
    });

    this.activeTimers.set(
      sessionId,
      setTimeout(() => this.onTimerExpired(sessionId), duration)
    );

    this.broadcastState(sessionId, 'timer_started');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public pauseQuestion(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.questionState !== 'active') {
      throw new GameEngineError(409, 'INVALID_STATE', 'Cannot pause question when it is not active.');
    }

    this.clearTimer(sessionId);
    const now = Date.now();
    const remaining = session.deadlineTimestamp ? Math.max(0, session.deadlineTimestamp - now) : session.timeRemainingMs;

    this.repositories.updateSession(sessionId, {
      question_state: 'paused',
      time_remaining_ms: remaining,
      deadline_timestamp: null,
    });

    this.broadcastState(sessionId, 'timer_paused');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public resumeQuestion(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.questionState !== 'paused') {
      throw new GameEngineError(409, 'INVALID_STATE', 'Cannot resume question when it is not paused.');
    }

    const remaining = session.timeRemainingMs;
    if (remaining <= 0) {
      this.repositories.updateSession(sessionId, {
        question_state: 'expired',
        time_remaining_ms: 0,
        deadline_timestamp: null,
      });
      this.broadcastState(sessionId, 'timer_expired');
      return this.repositories.getSessionState(sessionId, 'admin');
    }

    const deadline = Date.now() + remaining;
    this.clearTimer(sessionId);
    this.repositories.updateSession(sessionId, {
      question_state: 'active',
      deadline_timestamp: deadline,
    });

    this.activeTimers.set(
      sessionId,
      setTimeout(() => this.onTimerExpired(sessionId), remaining)
    );

    this.broadcastState(sessionId, 'timer_resumed');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public expireQuestion(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.questionState !== 'active' && session.questionState !== 'paused') {
      throw new GameEngineError(409, 'INVALID_STATE', 'Cannot expire question that is not active or paused.');
    }

    this.clearTimer(sessionId);
    this.repositories.updateSession(sessionId, {
      question_state: 'expired',
      time_remaining_ms: 0,
      deadline_timestamp: null,
    });

    this.broadcastState(sessionId, 'timer_expired');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public revealAnswer(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.questionState !== 'active' && session.questionState !== 'paused' && session.questionState !== 'expired') {
      throw new GameEngineError(409, 'INVALID_STATE', `Cannot reveal answer from state: ${session.questionState}`);
    }

    this.clearTimer(sessionId);
    this.repositories.updateSession(sessionId, {
      question_state: 'revealed',
      time_remaining_ms: 0,
      deadline_timestamp: null,
    });

    this.broadcastState(sessionId, 'answer_revealed');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public reopenQuestion(sessionId: string, autoStart = false) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.questionState !== 'expired' && session.questionState !== 'revealed' && session.questionState !== 'paused') {
      throw new GameEngineError(409, 'INVALID_STATE', `Cannot reopen question from state: ${session.questionState}`);
    }

    let durationMs = 30000;
    if (session.currentQuestionId) {
      const q = this.repositories.getQuestion(session.currentQuestionId);
      if (q) durationMs = q.durationMs;
      this.repositories.clearAudienceChoice(sessionId, session.currentQuestionId);
      this.repositories.clearQuestionReveal(sessionId, session.currentQuestionId);
    }

    this.clearTimer(sessionId);

    if (autoStart) {
      const deadline = Date.now() + durationMs;
      this.repositories.updateSession(sessionId, {
        question_state: 'active',
        time_remaining_ms: durationMs,
        deadline_timestamp: deadline,
      });

      this.activeTimers.set(
        sessionId,
        setTimeout(() => this.onTimerExpired(sessionId), durationMs)
      );
      this.broadcastState(sessionId, 'timer_started');
    } else {
      this.repositories.updateSession(sessionId, {
        question_state: 'ready',
        time_remaining_ms: durationMs,
        deadline_timestamp: null,
      });
      this.broadcastState(sessionId, 'question_reopened');
    }

    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public nextQuestion(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status === 'ended') {
      throw new GameEngineError(409, 'INVALID_STATE', 'Session has already ended.');
    }

    this.clearTimer(sessionId);
    const next = this.repositories.getNextQuestionAndRound(sessionId);

    if (next.isCompleted || !next.nextQuestionId || !next.nextRoundId) {
      // Session has completed all rounds and questions
      this.repositories.updateSession(sessionId, {
        status: 'ended',
        question_state: 'completed',
        deadline_timestamp: null,
        time_remaining_ms: 0,
        ended_at: Date.now(),
      });
      this.broadcastState(sessionId, 'round_completed');
      this.broadcastState(sessionId, 'session_ended');
      return this.repositories.getSessionState(sessionId, 'admin');
    }

    const roundChanged = next.nextRoundId !== session.currentRoundId;
    this.repositories.updateSession(sessionId, {
      current_round_id: next.nextRoundId,
      current_question_id: next.nextQuestionId,
      question_state: 'ready',
      time_remaining_ms: next.durationMs,
      deadline_timestamp: null,
    });

    if (roundChanged) {
      this.broadcastState(sessionId, 'round_completed');
    }
    this.broadcastState(sessionId, 'question_changed');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public previousQuestion(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status === 'ended') throw new GameEngineError(409, 'INVALID_STATE', 'Session has already ended.');
    const questions = this.repositories.listRounds(session.eventId).flatMap((round) =>
      this.repositories.listQuestions(round.id).filter((question) => question.status !== 'retired')
    );
    const index = questions.findIndex((question) => question.id === session.currentQuestionId);
    const previous = questions[index - 1];
    if (!previous) throw new GameEngineError(409, 'NO_PREVIOUS_QUESTION', 'This is the first question.');
    this.clearTimer(sessionId);
    this.repositories.clearQuestionReveal(sessionId, previous.id);
    this.repositories.clearAudienceChoice(sessionId, previous.id);
    this.repositories.updateSession(sessionId, {
      current_round_id: previous.roundId,
      current_question_id: previous.id,
      question_state: 'ready',
      time_remaining_ms: previous.durationMs,
      deadline_timestamp: null,
    });
    this.broadcastState(sessionId, 'question_changed');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public pauseSession(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status !== 'active') {
      throw new GameEngineError(409, 'INVALID_STATE', 'Session is not currently active.');
    }

    this.clearTimer(sessionId);
    const now = Date.now();
    const remaining = session.deadlineTimestamp ? Math.max(0, session.deadlineTimestamp - now) : session.timeRemainingMs;

    this.repositories.updateSession(sessionId, {
      status: 'paused',
      question_state: session.questionState === 'active' ? 'paused' : session.questionState,
      time_remaining_ms: remaining,
      deadline_timestamp: null,
    });

    this.broadcastState(sessionId, 'session_paused');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public resumeSession(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status !== 'paused') {
      throw new GameEngineError(409, 'INVALID_STATE', 'Session is not currently paused.');
    }

    this.repositories.updateSession(sessionId, {
      status: 'active',
    });

    this.broadcastState(sessionId, 'session_resumed');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public endSession(sessionId: string) {
    const session = this.repositories.getSession(sessionId);
    if (!session) throw new GameEngineError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    if (session.status === 'ended') {
      return this.repositories.getSessionState(sessionId, 'admin');
    }

    this.clearTimer(sessionId);
    this.repositories.updateSession(sessionId, {
      status: 'ended',
      question_state: 'completed',
      deadline_timestamp: null,
      time_remaining_ms: 0,
      ended_at: Date.now(),
    });

    this.broadcastState(sessionId, 'session_ended');
    return this.repositories.getSessionState(sessionId, 'admin');
  }

  public close() {
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }
}
