import { describe, expect, it } from 'vitest';
import type { Question } from '@mzp-quiz/shared';
import { validateAnswer } from '../src/game/answer-validation.js';
import { calculateQuestionScore } from '../src/game/scoring.js';

const question = (overrides: Partial<Question> = {}): Question => ({
  id: 'question',
  roundId: 'round',
  questionType: 'written_answer',
  prompt: 'Prompt',
  explanation: null,
  mediaPath: null,
  durationMs: 10_000,
  points: 10,
  penaltyPoints: 0,
  orderIndex: 0,
  status: 'ready',
  manualJudging: false,
  correctValue: null,
  scoring: {},
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe('answer validation and scoring rules', () => {
  it('compares written answers by normalized case and whitespace without semantic matching', () => {
    const written = question();
    const accepted = [{ normalizedAnswer: 'new york' }];
    expect(validateAnswer(written, { responseText: ' NEW   YORK ' }, [], accepted)).toBe(true);
    expect(validateAnswer(written, { responseText: 'New York City' }, [], accepted)).toBe(false);
  });

  it('validates option and true/false values and defers manual judging', () => {
    const multipleChoice = question({ questionType: 'multiple_choice' });
    const options = [
      { id: 'wrong', questionId: 'question', choiceText: 'Wrong', orderIndex: 0, isCorrect: false, createdAt: 0 },
      { id: 'right', questionId: 'question', choiceText: 'Right', orderIndex: 1, isCorrect: true, createdAt: 0 },
    ];
    expect(validateAnswer(multipleChoice, { choiceId: 'right' }, options, [])).toBe(true);
    expect(validateAnswer(multipleChoice, { choiceId: 'unknown' }, options, [])).toBe(false);
    expect(validateAnswer(question({ questionType: 'true_false', correctValue: false }), { booleanValue: false }, [], [])).toBe(true);
    expect(validateAnswer(question({ manualJudging: true }), { responseText: 'anything' }, [], [])).toBeNull();
  });

  it('applies configured penalties, zero points and only explicitly configured speed bonuses', () => {
    expect(calculateQuestionScore(question({ points: 0 }), true, 100)).toBe(0);
    expect(calculateQuestionScore(question({ penaltyPoints: 3 }), false, 100)).toBe(-3);
    expect(calculateQuestionScore(question(), true, 1)).toBe(10);
    expect(calculateQuestionScore(question({ scoring: { speedBonus: { thresholdMs: 2000, points: 4 } } }), true, 1000)).toBe(14);
    expect(calculateQuestionScore(question({ scoring: { speedBonus: { thresholdMs: 2000, points: 4 } } }), true, 2001)).toBe(10);
  });
});
