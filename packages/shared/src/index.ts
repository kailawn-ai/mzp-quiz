import { z } from 'zod';

export const eventStatuses = ['draft', 'live', 'completed', 'archived'] as const;
export const roundTypes = ['quick_questions', 'rapid_fire', 'multiple_choice', 'buzzer', 'written_answer', 'true_false', 'image_audio_clue', 'bonus_round', 'tie_breaker'] as const;
export const questionTypes = ['short_answer', 'quick_question', 'rapid_fire', 'multiple_choice', 'buzzer', 'written_answer', 'true_false', 'image_audio_clue', 'bonus_round', 'tie_breaker'] as const;
export const questionStatuses = ['draft', 'ready', 'retired'] as const;

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const eventSettingsSchema = jsonObjectSchema.default({});
export const roundConfigurationSchema = jsonObjectSchema.default({});

export const eventCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(eventStatuses).default('draft'),
  settings: eventSettingsSchema,
});
export const eventUpdateSchema = eventCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one event field is required.');

export const roundCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  roundType: z.enum(roundTypes),
  orderIndex: z.number().int().min(0).max(10000),
  configuration: roundConfigurationSchema,
});
export const roundUpdateSchema = roundCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one round field is required.');

export const questionCreateSchema = z.object({
  questionType: z.enum(questionTypes),
  prompt: z.string().trim().min(1).max(10000),
  explanation: z.string().trim().max(5000).optional(),
  mediaPath: z.string().trim().max(1000).optional(),
  durationMs: z.number().int().min(100).max(86_400_000),
  points: z.number().int().min(0).max(1_000_000),
  penaltyPoints: z.number().int().min(0).max(1_000_000),
  orderIndex: z.number().int().min(0).max(100000),
  status: z.enum(questionStatuses).default('draft'),
  assignedParticipantId: z.string().uuid().nullable().optional(),
});

export const acceptedAnswerCreateSchema = z.object({
  answerText: z.string().trim().min(1).max(1000),
  judgeNotes: z.string().trim().max(2000).optional(),
});

export const choiceCreateSchema = z.object({
  choiceText: z.string().trim().min(1).max(1000),
  orderIndex: z.number().int().min(0).max(1000),
  isCorrect: z.boolean().default(false),
});

export const rapidFireItemSchema = z.object({
  prompt: z.string().trim().min(1).max(10000),
  answerText: z.string().trim().min(1).max(1000),
});

export const questionScoringSchema = z.object({
  speedBonus: z.object({
    thresholdMs: z.number().int().min(0).max(86_400_000),
    points: z.number().int().min(0).max(1_000_000),
  }).optional(),
}).default({});

export const questionWriteSchema = questionCreateSchema.extend({
  manualJudging: z.boolean().default(false),
  correctValue: z.boolean().optional(),
  acceptedAnswers: z.array(acceptedAnswerCreateSchema).max(50).default([]),
  choices: z.array(choiceCreateSchema).max(20).default([]),
  rapidFireItems: z.array(rapidFireItemSchema).max(50).default([]),
  scoring: questionScoringSchema,
}).superRefine((value, context) => {
  if (value.questionType === 'rapid_fire' && value.rapidFireItems.length === 0) {
    context.addIssue({ code: 'custom', path: ['rapidFireItems'], message: 'Rapid-fire questions need at least one prompt and answer.' });
  }
  if (value.questionType === 'multiple_choice') {
    if (value.choices.length < 2) context.addIssue({ code: 'custom', path: ['choices'], message: 'Multiple-choice questions need at least two options.' });
    if (value.choices.filter((choice) => choice.isCorrect).length !== 1) context.addIssue({ code: 'custom', path: ['choices'], message: 'Multiple-choice questions need exactly one correct option.' });
  }
  if (value.questionType === 'true_false' && value.correctValue === undefined) context.addIssue({ code: 'custom', path: ['correctValue'], message: 'True or False questions need a correct value.' });
});

export type EventSettings = z.infer<typeof eventSettingsSchema>;
export type RoundConfiguration = z.infer<typeof roundConfigurationSchema>;
export type Event = { id: string; title: string; description: string | null; status: typeof eventStatuses[number]; settings: EventSettings; createdAt: number; updatedAt: number };
export type Round = { id: string; eventId: string; name: string; roundType: typeof roundTypes[number]; orderIndex: number; configuration: RoundConfiguration; createdAt: number; updatedAt: number };
export type Question = { id: string; roundId: string; questionType: typeof questionTypes[number]; prompt: string; explanation: string | null; mediaPath: string | null; durationMs: number; points: number; penaltyPoints: number; orderIndex: number; status: typeof questionStatuses[number]; assignedParticipantId?: string | null; manualJudging: boolean; correctValue: boolean | null; scoring: QuestionScoring; createdAt: number; updatedAt: number };
export type AcceptedAnswer = { id: string; questionId: string; answerText: string; normalizedAnswer: string; judgeNotes: string | null; createdAt: number };
export type QuestionChoice = { id: string; questionId: string; choiceText: string; orderIndex: number; isCorrect: boolean; createdAt: number };
export type RapidFireItem = { id: number; questionId: string; orderIndex: number; prompt: string; answerText: string };
export type QuestionScoring = z.infer<typeof questionScoringSchema>;
export type QuestionAdmin = Question & { acceptedAnswers: AcceptedAnswer[]; choices: QuestionChoice[]; rapidFireItems: RapidFireItem[] };

export const sessionStatuses = ['active', 'paused', 'ended'] as const;
export type SessionStatus = typeof sessionStatuses[number];

export const sessionQuestionStates = ['ready', 'active', 'paused', 'expired', 'revealed', 'completed'] as const;
export type SessionQuestionState = typeof sessionQuestionStates[number];

export const sessionActions = [
  'start_question',
  'pause_question',
  'resume_question',
  'expire_question',
  'reveal_answer',
  'reopen_question',
  'next_question',
  'previous_question',
  'pause_session',
  'resume_session',
  'end_session',
] as const;
export type SessionAction = typeof sessionActions[number];

export const sessionControlSchema = z.object({
  action: z.enum(sessionActions),
  reopenAutoStart: z.boolean().optional(),
});
export type SessionControlInput = z.infer<typeof sessionControlSchema>;

export type QuizSession = {
  id: string;
  eventId: string;
  status: SessionStatus;
  currentRoundId: string | null;
  currentQuestionId: string | null;
  questionState: SessionQuestionState;
  timeRemainingMs: number;
  deadlineTimestamp: number | null;
  autoAdvance: boolean;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
};

export type PublicChoice = {
  id: string;
  questionId: string;
  choiceText: string;
  orderIndex: number;
};

export type RevealedChoice = PublicChoice & {
  isCorrect: boolean;
};

export type PublicQuestionState = {
  id: string;
  roundId: string;
  questionType: Question['questionType'];
  assignedParticipantId?: string | null;
  prompt: string;
  explanation: string | null;
  mediaPath: string | null;
  durationMs: number;
  points: number;
  penaltyPoints: number;
  orderIndex: number;
  choices: PublicChoice[];
  totalAcceptedResponses: number;
};

export type AdminQuestionState = Omit<PublicQuestionState, 'choices'> & {
  choices: QuestionChoice[];
  assignedParticipantId?: string | null;
  correctValue: boolean | null;
  acceptedAnswers: AcceptedAnswer[];
  acceptedAnswersCount: number;
  rapidFireItems: RapidFireItem[];
};

export type RapidFireProgress = {
  selectedParticipantId: string | null;
  currentItemIndex: number;
  items: Array<{
    index: number;
    prompt: string | null;
    answerText: string | null;
    status: 'pending' | 'passed' | 'correct' | 'incorrect';
  }>;
};

export type TimerState = {
  durationMs: number;
  timeRemainingMs: number;
  deadlineTimestamp: number | null;
  isPaused: boolean;
};

export type RoundSummary = {
  id: string;
  name: string;
  roundType: Round['roundType'];
  orderIndex: number;
  totalQuestions: number;
  currentQuestionIndex: number;
};

export type PublicSessionState = {
  buzzerParticipantId?: string | null;
  mediaFullscreen?: boolean;
  sessionId: string;
  eventId: string;
  eventTitle: string;
  status: SessionStatus;
  round: RoundSummary | null;
  question: PublicQuestionState | null;
  questionState: SessionQuestionState;
  audienceChoiceId: string | null;
  questionRevealed: boolean;
  revealedChoiceCount: number;
  answerChangesAllowed: boolean;
  timer: TimerState;
  rapidFire: RapidFireProgress | null;
  revealedAnswer?: {
    correctValue: boolean | null;
    correctChoices: QuestionChoice[];
    acceptedAnswers: AcceptedAnswer[];
    explanation: string | null;
  } | null;
  updatedAt: number;
};

export type AdminSessionState = Omit<PublicSessionState, 'question'> & {
  question: AdminQuestionState | null;
};

export const webSocketEventTypes = [
  'state_sync',
  'session_started',
  'session_paused',
  'session_resumed',
  'session_ended',
  'question_changed',
  'timer_started',
  'timer_paused',
  'timer_resumed',
  'timer_expired',
  'answer_revealed',
  'answer_submitted',
  'question_revealed',
  'choice_revealed',
  'question_reopened',
  'rapid_fire_updated',
  'audience_choice_confirmed',
  'media_fullscreen_toggled',
  'round_completed',
  'leaderboard_updated',
  'error',
] as const;
export type WebSocketEventType = typeof webSocketEventTypes[number];

export type LeaderboardEntry = {
  rank: number;
  participantId: string;
  displayName: string;
  teamIdentifier: string | null;
  totalPoints: number;
  correctAnswers: number;
  rounds: Array<{ roundId: string; roundName: string; points: number; correctAnswers: number }>;
};
export type LeaderboardUpdate = { eventId: string; entries: LeaderboardEntry[] };

export type WebSocketMessage = {
  type: WebSocketEventType;
  payload: PublicSessionState | AdminSessionState | LeaderboardUpdate | { message: string; code?: string };
  timestamp: number;
};
