import type { Question, QuestionChoice } from '@mzp-quiz/shared';

export function normalizeAnswer(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
}

export type AnswerCandidate = {
  responseText?: string;
  choiceId?: string;
  booleanValue?: boolean;
};

export function validateAnswer(
  question: Question,
  candidate: AnswerCandidate,
  choices: QuestionChoice[],
  acceptedAnswers: Array<{ normalizedAnswer: string }>,
): boolean | null {
  if (question.manualJudging) return null;

  if (question.questionType === 'multiple_choice') {
    if (!candidate.choiceId) return false;
    return choices.some((choice) => choice.id === candidate.choiceId && choice.isCorrect);
  }
  if (question.questionType === 'true_false') {
    return candidate.booleanValue !== undefined && question.correctValue !== null
      ? candidate.booleanValue === question.correctValue
      : false;
  }
  if (
    question.questionType === 'written_answer' ||
    question.questionType === 'short_answer' ||
    question.questionType === 'quick_question' ||
    question.questionType === 'rapid_fire'
  ) {
    if (candidate.responseText === undefined) return false;
    const normalized = normalizeAnswer(candidate.responseText);
    return acceptedAnswers.some((answer) => answer.normalizedAnswer === normalized);
  }
  return null;
}

export function normalizeCandidate(candidate: AnswerCandidate): string | null {
  return candidate.responseText === undefined ? null : normalizeAnswer(candidate.responseText);
}
