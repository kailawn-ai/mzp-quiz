// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type PublicSessionState } from './api';
import { OverlayScreen } from './OverlayScreen';

let socket: { onmessage: ((event: MessageEvent) => void) | null; close: () => void } | undefined;

class MockWebSocket {
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    socket = this;
  }
  close() {
    this.readyState = 3;
  }
}

describe('OverlayScreen staged question reveal', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    socket = undefined;
  });

  it('reveals question and options in stages before animating the confirmed choice on answer reveal', async () => {

    const activeSession = {
      id: 'session-1',
      eventId: 'event-1',
      status: 'active' as const,
      currentRoundId: 'round-1',
      currentQuestionId: 'question-1',
      questionState: 'active' as const,
      timeRemainingMs: 30000,
      deadlineTimestamp: Date.now() + 30000,
      autoAdvance: false,
      createdAt: 1,
      updatedAt: 1,
      endedAt: null,
    };
    const session: PublicSessionState = {
      sessionId: 'session-1',
      eventId: 'event-1',
      eventTitle: 'Quiz Night',
      status: 'active',
      round: { id: 'round-1', name: 'Round One', roundType: 'multiple_choice', orderIndex: 0, totalQuestions: 1, currentQuestionIndex: 0 },
      question: {
        id: 'question-1',
        roundId: 'round-1',
        questionType: 'multiple_choice',
        assignedParticipantId: 'participant-1',
        prompt: 'Choose an option',
        explanation: null,
        mediaPath: null,
        durationMs: 30000,
        points: 10,
        penaltyPoints: 0,
        orderIndex: 0,
        choices: [
          { id: 'choice-a', questionId: 'question-1', choiceText: 'Option A', orderIndex: 0 },
          { id: 'choice-b', questionId: 'question-1', choiceText: 'Option B', orderIndex: 1 },
        ],
        totalAcceptedResponses: 0,
      },
      questionState: 'active',
      audienceChoiceId: null,
      questionRevealed: false,
      revealedChoiceCount: 0,
      answerChangesAllowed: false,
      timer: { durationMs: 30000, timeRemainingMs: 30000, deadlineTimestamp: Date.now() + 30000, isPaused: false },
      rapidFire: null,
      revealedAnswer: null,
      updatedAt: Date.now(),
    };

    vi.spyOn(api, 'activeSessions').mockResolvedValue([activeSession]);
    vi.spyOn(api, 'publicSession').mockResolvedValue(session);
    vi.spyOn(api, 'overlaySettings').mockResolvedValue({
      layout: 'classic',
      primaryColor: '#7dd3fc',
      secondaryColor: '#a78bfa',
      backgroundColor: '#020617',
      panelColor: '#0f172a',
      panelOpacity: 0.86,
      showPanelBackground: false,
      questionFontSize: 52,
      choiceFontSize: 30,
      choiceGap: 20,
      contentScale: 0.72,
      countdownStyle: 'ring',
      eventTitle: '',
      logoPath: null,
      backgroundImagePath: null,
      lowerThirdText: '',
      customFontFamily: '',
      participantBadgeMode: 'rapid_fire',
      participantBadgeParticipantId: null,
    });
    vi.spyOn(api, 'leaderboard').mockResolvedValue([]);
    vi.spyOn(api, 'publicParticipants').mockResolvedValue([
      {
        id: 'participant-1',
        participantType: 'team',
        displayName: 'Team Alpha',
        teamIdentifier: 'A',
      },
    ]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<OverlayScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.overlay-screen')?.classList.contains('overlay-classic')).toBe(true);
    expect(container.querySelector('.overlay-screen')?.classList.contains('overlay-transparent-background')).toBe(true);
    expect(container.querySelector('.overlay-composition')).toBeNull();
    expect(container.querySelector('.overlay-participant-badge')?.textContent).toContain('Team Alpha');
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(container.querySelector('.overlay-question')).toBeNull();
    expect(container.querySelector('.overlay-choice')).toBeNull();
    expect(container.querySelector('.overlay-screen')?.getAttribute('style')).toContain('--overlay-content-scale: 0.72');
    expect(container.textContent).not.toContain("Contestant's choice");

    const questionRevealed: PublicSessionState = { ...session, questionRevealed: true };
    const revealedQuestion = session.question;
    if (!revealedQuestion) throw new Error('Expected the test session to include a question.');
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'question_revealed', payload: questionRevealed, timestamp: Date.now() }),
      } as MessageEvent);
    });
    expect(container.querySelector('[role="timer"]')?.textContent).toContain('TIME LEFT');
    expect(container.querySelector('.overlay-timer')?.parentElement?.classList.contains('overlay-composition')).toBe(true);
    expect(container.querySelector('.overlay-content')?.contains(container.querySelector('.overlay-timer'))).toBe(false);
    expect(container.querySelector('.overlay-timer-ring')).not.toBeNull();
    expect(container.querySelector('.overlay-timer-value')?.textContent).toMatch(/^00:\d{2}$/);
    expect(container.querySelector('.overlay-question-type')?.textContent).toBe('multiple choice');
    expect(container.querySelector('.overlay-question')?.textContent).toBe('Choose an option');
    expect(container.querySelectorAll('.overlay-choice')).toHaveLength(2);
    expect(container.querySelector('.overlay-participant-badge')?.textContent).toContain('Team Alpha');
    expect(container.querySelector('.overlay-choice-text')).toBeNull();

    const firstOptionRevealed: PublicSessionState = {
      ...questionRevealed,
      revealedChoiceCount: 1,
      question: {
        ...revealedQuestion,
        choices: revealedQuestion.choices.map((choice, index) => ({
          ...choice,
          choiceText: index === 0 ? choice.choiceText : '',
        })),
      },
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'choice_revealed', payload: firstOptionRevealed, timestamp: Date.now() }),
      } as MessageEvent);
    });
    expect(container.querySelector('.overlay-choice-announcement')).toBeNull();
    expect(container.querySelectorAll('.overlay-choice-text')).toHaveLength(1);
    expect(container.querySelectorAll('.overlay-choice')[1]?.textContent).toBe('B');

    const confirmedChoice: PublicSessionState = {
      ...firstOptionRevealed,
      audienceChoiceId: 'choice-a',
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'audience_choice_confirmed', payload: confirmedChoice, timestamp: Date.now() }),
      } as MessageEvent);
    });
    expect(container.querySelector('.overlay-choice.audience-choice')).not.toBeNull();

    const revealedSession: PublicSessionState = {
      ...confirmedChoice,
      questionState: 'revealed',
      revealedChoiceCount: 2,
      revealedAnswer: {
        correctValue: null,
        correctChoices: [{ id: 'choice-b', questionId: 'question-1', choiceText: 'Option B', orderIndex: 1, isCorrect: true, createdAt: 1 }],
        acceptedAnswers: [],
        explanation: null,
      },
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'answer_revealed', payload: revealedSession, timestamp: Date.now() }),
      } as MessageEvent);
    });

    expect(container.querySelector('.overlay-choice.audience-choice-incorrect')).not.toBeNull();
    const revealedCorrectChoice = container.querySelector('.overlay-choice.answer-revealed:not(.audience-choice-incorrect)');
    expect(revealedCorrectChoice).not.toBeNull();
    expect(revealedCorrectChoice?.getAttribute('style')).toContain('100ms');
    expect(container.textContent).not.toContain("Contestant's choice");

    const trueFalseQuestion: PublicSessionState = {
      ...revealedSession,
      question: {
        ...revealedQuestion,
        id: 'question-true-false',
        questionType: 'true_false',
        prompt: 'Is the Earth a planet?',
        choices: [],
      },
      questionState: 'active',
      questionRevealed: true,
      revealedAnswer: null,
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'question_changed', payload: trueFalseQuestion, timestamp: Date.now() }),
      } as MessageEvent);
    });
    const trueFalseAnswer: PublicSessionState = {
      ...trueFalseQuestion,
      questionState: 'revealed',
      revealedAnswer: {
        correctValue: true,
        correctChoices: [],
        acceptedAnswers: [],
        explanation: 'Earth orbits the Sun.',
      },
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'answer_revealed', payload: trueFalseAnswer, timestamp: Date.now() }),
      } as MessageEvent);
    });
    expect(container.querySelector('.overlay-answer-reveal')).not.toBeNull();
    expect(container.querySelector('.overlay-answer-value')?.textContent).toBe('True');
    expect(container.querySelector('.overlay-answer-explanation')?.textContent).toBe('Earth orbits the Sun.');

    const writtenAnswer: PublicSessionState = {
      ...trueFalseAnswer,
      question: {
        ...trueFalseQuestion.question!,
        id: 'question-written',
        questionType: 'written_answer',
        prompt: 'Name a color of the sky on a clear day.',
      },
      revealedAnswer: {
        correctValue: null,
        correctChoices: [],
        acceptedAnswers: [
          { id: 'answer-1', questionId: 'question-written', answerText: 'Blue', normalizedAnswer: 'blue', judgeNotes: null, createdAt: 1 },
          { id: 'answer-2', questionId: 'question-written', answerText: 'Light blue', normalizedAnswer: 'light blue', judgeNotes: null, createdAt: 2 },
        ],
        explanation: null,
      },
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'answer_revealed', payload: writtenAnswer, timestamp: Date.now() }),
      } as MessageEvent);
    });
    expect(container.querySelectorAll('.overlay-answer-value')).toHaveLength(2);
    expect(container.textContent).toContain('Blue');
    expect(container.textContent).toContain('Light blue');

    const rapidFireState: PublicSessionState = {
      ...writtenAnswer,
      question: {
        ...writtenAnswer.question!,
        id: 'question-rapid',
        questionType: 'rapid_fire',
        prompt: 'Answer quickly.',
      },
      questionState: 'active',
      rapidFire: {
        selectedParticipantId: 'participant-1',
        currentItemIndex: 1,
        items: [
          { index: 0, prompt: null, answerText: null, status: 'correct' },
          { index: 1, prompt: 'Name a river', answerText: null, status: 'pending' },
        ],
      },
      revealedAnswer: null,
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'rapid_fire_updated', payload: rapidFireState, timestamp: Date.now() }),
      } as MessageEvent);
    });
    expect(container.querySelectorAll('.overlay-rapid-fire-circle')).toHaveLength(2);
    expect(container.querySelector('.overlay-rapid-fire-circle.status-correct')?.textContent).toBe('1');
    expect(container.querySelector('.overlay-rapid-fire-circle[aria-current="step"]')?.textContent).toBe('2');
    expect(container.querySelector('.overlay-participant-badge')?.textContent).toContain('Team Alpha');
    expect(container.querySelector('.overlay-rapid-fire-active-label')?.textContent).toBe('NOW ASKING · QUESTION 2');
    expect(container.querySelector('.overlay-question')).toBeNull();
    expect(container.querySelector('.overlay-rapid-fire-prompt')?.textContent).toBe('Name a river');
    expect(container.textContent).not.toContain('Answer:');

    const rapidFireAnswerReveal: PublicSessionState = {
      ...rapidFireState,
      questionState: 'revealed',
      rapidFire: {
        ...rapidFireState.rapidFire!,
        items: [
          { ...rapidFireState.rapidFire!.items[0], answerText: 'New York' },
          { ...rapidFireState.rapidFire!.items[1], answerText: 'London' },
        ],
      },
    };
    await act(async () => {
      socket?.onmessage?.({
        data: JSON.stringify({ type: 'answer_revealed', payload: rapidFireAnswerReveal, timestamp: Date.now() }),
      } as MessageEvent);
    });
    expect(container.textContent).toContain('Answer: London');

    await act(async () => root.unmount());
    container.remove();
  });

  it('renders fullscreen image with blurred liquid glass background when mediaFullscreen is active', async () => {
    const clueSession: PublicSessionState = {
      sessionId: 'session-clue',
      eventId: 'event-1',
      eventTitle: 'Championship Quiz',
      status: 'active',
      round: {
        id: 'round-1',
        name: 'Visual Clue Round',
        roundType: 'image_audio_clue',
        orderIndex: 0,
        totalQuestions: 1,
        currentQuestionIndex: 0,
      },
      question: {
        id: 'q-clue',
        roundId: 'round-1',
        questionType: 'image_audio_clue',
        prompt: 'Identify this landscape',
        explanation: null,
        mediaPath: '/media/landscape.jpg',
        durationMs: 30000,
        points: 10,
        penaltyPoints: 0,
        orderIndex: 0,
        choices: [],
        totalAcceptedResponses: 0,
      },
      questionState: 'active',
      audienceChoiceId: null,
      questionRevealed: true,
      revealedChoiceCount: 0,
      answerChangesAllowed: false,
      timer: {
        durationMs: 30000,
        timeRemainingMs: 30000,
        deadlineTimestamp: null,
        isPaused: false,
      },
      rapidFire: null,
      mediaFullscreen: true,
      updatedAt: Date.now(),
    };

    vi.spyOn(api, 'activeSessions').mockResolvedValue([{ id: 'session-clue', eventId: 'event-1', status: 'active', currentRoundId: 'round-1', currentQuestionId: 'q-clue', questionState: 'active', timeRemainingMs: 30000, deadlineTimestamp: null, autoAdvance: false, createdAt: Date.now(), updatedAt: Date.now(), endedAt: null }]);
    vi.spyOn(api, 'publicSession').mockResolvedValue(clueSession);
    vi.spyOn(api, 'overlaySettings').mockResolvedValue({
      layout: 'classic',
      primaryColor: '#7dd3fc',
      secondaryColor: '#a78bfa',
      backgroundColor: '#020617',
      panelColor: '#0f172a',
      panelOpacity: 0.86,
      showPanelBackground: true,
      questionFontSize: 52,
      choiceFontSize: 30,
      choiceGap: 20,
      contentScale: 0.72,
      positionX: 0,
      positionY: 0,
      countdownStyle: 'ring',
      eventTitle: 'Championship Quiz',
      logoPath: null,
      backgroundImagePath: null,
      lowerThirdText: '',
      customFontFamily: '',
      participantBadgeMode: 'manual',
      participantBadgeParticipantId: null,
    });
    vi.spyOn(api, 'leaderboard').mockResolvedValue([]);
    vi.spyOn(api, 'publicParticipants').mockResolvedValue([]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<OverlayScreen />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const backdrop = container.querySelector('.overlay-media-fullscreen-backdrop');
    expect(backdrop).not.toBeNull();
    expect(container.querySelector('.overlay-media-fullscreen-liquid-layer')).not.toBeNull();
    const image = container.querySelector<HTMLImageElement>('.overlay-media-fullscreen-image');
    expect(image?.src).toContain('/media/landscape.jpg');
    expect(container.textContent).toContain('Identify this landscape');
    expect(container.textContent).toContain('VISUAL CLUE · QUESTION 1');

    await act(async () => root.unmount());
    container.remove();
  });
});
