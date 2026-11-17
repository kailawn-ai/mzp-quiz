import type { Question } from '@mzp-quiz/shared';

export function calculateQuestionScore(
  question: Pick<Question, 'points' | 'penaltyPoints' | 'scoring'>,
  isCorrect: boolean | null,
  elapsedMs: number | null,
): number {
  if (isCorrect === null) return 0;
  if (!isCorrect) return -question.penaltyPoints;

  const speedBonus = question.scoring.speedBonus;
  const bonus =
    speedBonus && elapsedMs !== null && elapsedMs <= speedBonus.thresholdMs ? speedBonus.points : 0;
  return question.points + bonus;
}
