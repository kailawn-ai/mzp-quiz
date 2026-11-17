import type {
  AdminSessionState,
  PublicSessionState,
  QuizSession,
  SessionAction,
  SessionQuestionState,
  SessionStatus,
  WebSocketMessage,
  LeaderboardEntry,
} from "@mzp-quiz/shared";

function getBaseUrl(): string {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (typeof window !== 'undefined' && window.location && window.location.hostname) {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:3001`;
  }
  return 'http://127.0.0.1:3001';
}

const apiBaseUrl = getBaseUrl();
const wsBaseUrl = apiBaseUrl.replace(/^http/, 'ws');

export type EventItem = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignedParticipantId?: string | null;
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};
export type RoundItem = {
  id: string;
  eventId: string;
  name: string;
  roundType: string;
  orderIndex: number;
  configuration: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};
export type AnswerItem = {
  id: string;
  questionId: string;
  answerText: string;
  normalizedAnswer: string;
  judgeNotes: string | null;
  createdAt: number;
};
export type ChoiceItem = {
  id: string;
  questionId: string;
  choiceText: string;
  orderIndex: number;
  isCorrect: boolean;
  createdAt: number;
};
export type QuestionItem = {
  id: string;
  roundId: string;
  questionType: string;
  prompt: string;
  explanation: string | null;
  mediaPath: string | null;
  durationMs: number;
  points: number;
  penaltyPoints: number;
  orderIndex: number;
  status: string;
  assignedParticipantId?: string | null;
  manualJudging: boolean;
  correctValue: boolean | null;
  scoring: { speedBonus?: { thresholdMs: number; points: number } };
  createdAt: number;
  updatedAt: number;
};
export type QuestionAdmin = QuestionItem & {
  acceptedAnswers: AnswerItem[];
  choices: ChoiceItem[];
  rapidFireItems: Array<{ id: number; questionId: string; orderIndex: number; prompt: string; answerText: string }>;
};
export type ParticipantItem = {
  id: string;
  eventId: string;
  participantType: 'team' | 'contestant';
  displayName: string;
  teamIdentifier: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};
export type SubmissionReviewItem = {
  id: string;
  sessionId: string;
  questionId: string;
  prompt: string;
  displayName: string;
  response: string | null;
  isCorrect: boolean | null;
  pointsAwarded: number;
  submittedAt: number;
};
export type { LeaderboardEntry };
export type OverlayLayout =
  | 'classic'
  | 'competition'
  | 'minimal'
  | 'rapid_fire'
  | 'neon'
  | 'studio'
  | 'ticker'
  | 'spotlight'
  | 'cards'
  | 'lower_third';
export type OverlaySettings = {
  layout: OverlayLayout;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  panelColor: string;
  panelOpacity: number;
  showPanelBackground: boolean;
  questionFontSize: number;
  choiceFontSize: number;
  choiceGap: number;
  contentScale: number;
  positionX?: number;
  positionY?: number;
  countdownStyle: 'ring' | 'bar' | 'badge';
  eventTitle: string;
  logoPath: string | null;
  backgroundImagePath: string | null;
  lowerThirdText: string;
  customFontFamily: string;
  participantBadgeMode?: 'manual' | 'rapid_fire';
  participantBadgeParticipantId?: string | null;
};

const adminTokenKey = 'mzp_admin_token';
const participantTokenKey = 'mzp_participant_token';
const participantInfoKey = 'mzp_participant_info';
export const getAdminToken = () => typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(adminTokenKey);
export const getParticipantToken = () => typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(participantTokenKey);
export const setParticipantSession = (participant: ParticipantItem, token: string) => {
  sessionStorage.setItem(participantTokenKey, token);
  sessionStorage.setItem(participantInfoKey, JSON.stringify(participant));
};
export const getParticipantInfo = (): ParticipantItem | null => {
  try {
    const stored = sessionStorage.getItem(participantInfoKey);
    return stored ? JSON.parse(stored) as ParticipantItem : null;
  } catch {
    return null;
  }
};
export const clearParticipantSession = () => {
  sessionStorage.removeItem(participantTokenKey);
  sessionStorage.removeItem(participantInfoKey);
};

export type {
  AdminSessionState,
  PublicSessionState,
  QuizSession,
  SessionAction,
  SessionQuestionState,
  SessionStatus,
  WebSocketMessage,
};

export async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const adminToken = getAdminToken();
  if (adminToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${adminToken}`);
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error?.message ?? `Request failed (${response.status})`,
    );
  return body.data as T;
}

async function participantRequest<T>(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<T> {
  return request<T>(path, {
    ...options,
    headers: { ...options?.headers, Authorization: `Bearer ${token}` },
  });
}

export const api = {
  teamScreen: (eventId: string, participantId: string) => request<{ participant: { id: string; displayName: string }; session: PublicSessionState | null }>(`/api/events/${eventId}/team-screen/${participantId}`),
  buzzerControl: (sessionId: string) => request<{ control: { open: boolean; judged?: boolean }; winner: { id: string; participantId: string; name: string } | null }>(`/api/admin/sessions/${sessionId}/buzzer-control`),
  controlBuzzer: (sessionId: string, action: string, participantId?: string) => request(`/api/admin/sessions/${sessionId}/buzzer-control`, { method: 'POST', body: JSON.stringify({ action, participantId }) }),
  health: () => request<{ service: string }>("/api/health"),
  databaseHealth: () =>
    request<{
      database: { connected: boolean; migrationsApplied: number };
      migrations: { applied: number };
    }>("/api/health/database"),
  dashboard: () =>
    request<{ events: number; rounds: number; questions: number }>(
      "/api/dashboard",
    ),
  events: () => request<EventItem[]>("/api/events"),
  adminAuth: async (token: string) => {
    const result = await request<{ authorized: boolean }>('/api/admin/auth', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    sessionStorage.setItem(adminTokenKey, token);
    return result;
  },
  clearAdminToken: () => sessionStorage.removeItem(adminTokenKey),
  event: (id: string) => request<EventItem>(`/api/events/${id}`),
  createEvent: (body: unknown) =>
    request<EventItem>("/api/events", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateEvent: (id: string, body: unknown) =>
    request<EventItem>(`/api/events/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteEvent: (id: string) =>
    request<{ deleted: boolean }>(`/api/events/${id}`, { method: 'DELETE' }),
  rounds: (eventId: string) =>
    request<RoundItem[]>(`/api/events/${eventId}/rounds`),
  createRound: (eventId: string, body: unknown) =>
    request<RoundItem>(`/api/events/${eventId}/rounds`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateRound: (eventId: string, roundId: string, body: unknown) =>
    request<RoundItem>(`/api/events/${eventId}/rounds/${roundId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  participants: (eventId: string) =>
    request<ParticipantItem[]>(`/api/admin/events/${eventId}/participants`),
  publicParticipants: (eventId: string) =>
    request<Pick<ParticipantItem, 'id' | 'participantType' | 'displayName' | 'teamIdentifier'>[]>(`/api/events/${eventId}/participants`),
  reviewSubmissions: (eventId: string) =>
    request<SubmissionReviewItem[]>(`/api/admin/events/${eventId}/submissions`),
  gradeSubmission: (submissionId: string, isCorrect: boolean, reason: string) =>
    request<{ submissionId: string; isCorrect: boolean; pointsAwarded: number }>(
      `/api/admin/submissions/${submissionId}/grade`,
      { method: 'POST', body: JSON.stringify({ isCorrect, reason }) },
    ),
  updateParticipant: (participantId: string, body: unknown) =>
    request<ParticipantItem>(`/api/admin/participants/${participantId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteParticipant: (participantId: string) =>
    request<{ deleted: boolean }>(`/api/admin/participants/${participantId}`, {
      method: 'DELETE',
    }),
  registerParticipant: (eventId: string, body: unknown) =>
    request<ParticipantItem & { token: string }>(`/api/events/${eventId}/participants`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  leaderboard: (eventId: string) =>
    request<LeaderboardEntry[]>(`/api/events/${eventId}/leaderboard`),
  overlaySettings: (eventId: string) =>
    request<OverlaySettings>(`/api/events/${eventId}/overlay/settings`),
  updateOverlaySettings: (eventId: string, body: Partial<OverlaySettings>) =>
    request<OverlaySettings>(`/api/admin/events/${eventId}/overlay/settings`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
  uploadOverlayAsset: (eventId: string, body: { contentType: string; data: string }) =>
    request<{ assetId: string; contentType: string; url: string }>(`/api/admin/events/${eventId}/overlay/assets`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  adjustScore: (eventId: string, body: unknown) =>
    request<{ participantId: string; pointsDelta: number; reason: string }>(
      `/api/admin/events/${eventId}/scores/adjust`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  resetScores: (eventId: string) =>
    request<{ reset: boolean; participants: number }>(`/api/admin/events/${eventId}/scores/reset`, {
      method: 'POST',
      body: JSON.stringify({ confirmation: 'RESET SCORES' }),
    }),
  questions: (eventId: string, roundId: string) =>
    request<QuestionItem[]>(
      `/api/events/${eventId}/rounds/${roundId}/questions`,
    ),
  questionAdmin: (id: string) =>
    request<QuestionAdmin>(`/api/admin/questions/${id}`),
  createQuestion: (roundId: string, body: unknown) =>
    request<QuestionItem>(`/api/admin/rounds/${roundId}/questions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateQuestion: (id: string, body: unknown) =>
    request<QuestionItem>(`/api/admin/questions/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteQuestion: (id: string) => request<{ deleted: boolean }>(`/api/admin/questions/${id}`, { method: 'DELETE' }),
  duplicateQuestion: (id: string) =>
    request<QuestionItem>(`/api/admin/questions/${id}/duplicate`, {
      method: "POST",
    }),
  reorderQuestions: (roundId: string, orderedIds: string[]) =>
    request<QuestionItem[]>(`/api/admin/rounds/${roundId}/questions/order`, {
      method: "PUT",
      body: JSON.stringify({ orderedIds }),
    }),

  // Live Game Sessions
  activeSessions: () => request<QuizSession[]>("/api/sessions/active"),
  publicSession: (sessionId: string) => request<PublicSessionState>(`/api/sessions/${sessionId}`),
  activePublicSession: async () => {
    const activeList = await request<QuizSession[]>('/api/sessions/active');
    if (activeList.length === 0) return null;
    return request<PublicSessionState>(`/api/sessions/${activeList[0].id}`);
  },
  eventSession: (eventId: string) =>
    request<AdminSessionState>(`/api/events/${eventId}/session`),
  startSession: (eventId: string, autoAdvance = false) =>
    request<AdminSessionState>(`/api/events/${eventId}/session`, {
      method: "POST",
      body: JSON.stringify({ autoAdvance }),
    }),
  adminSession: (sessionId: string) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}`),
  controlSession: (
    sessionId: string,
    action: SessionAction,
    reopenAutoStart?: boolean,
  ) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/control`, {
      method: "POST",
      body: JSON.stringify({ action, reopenAutoStart }),
    }),
  confirmAudienceChoice: (sessionId: string, choiceId: string) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/audience-choice`, {
      method: 'PUT',
      body: JSON.stringify({ choiceId }),
    }),
  revealQuestion: (sessionId: string) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/reveal-question`, { method: 'POST' }),
  revealNextChoice: (sessionId: string) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/reveal-next-choice`, { method: 'POST' }),
  toggleMediaFullscreen: (sessionId: string, fullscreen: boolean) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/media-fullscreen`, {
      method: 'POST',
      body: JSON.stringify({ fullscreen }),
    }),
  selectRapidFireContestant: (sessionId: string, participantId: string) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/rapid-fire/contestant`, {
      method: 'PUT',
      body: JSON.stringify({ participantId }),
    }),
  selectRapidFireItem: (sessionId: string, itemIndex: number) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/rapid-fire/item`, {
      method: 'PUT',
      body: JSON.stringify({ itemIndex }),
    }),
  nextRapidFireItem: (sessionId: string, participantId: string, itemIndex: number) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/rapid-fire/next`, {
      method: 'POST',
      body: JSON.stringify({ participantId, itemIndex }),
    }),
  judgeRapidFireItem: (sessionId: string, participantId: string, itemIndex: number, isCorrect: boolean) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/rapid-fire/judge`, {
      method: 'POST',
      body: JSON.stringify({ participantId, itemIndex, isCorrect }),
    }),
  passRapidFireItem: (sessionId: string, participantId: string, itemIndex: number) =>
    request<AdminSessionState>(`/api/admin/sessions/${sessionId}/rapid-fire/pass`, {
      method: 'POST',
      body: JSON.stringify({ participantId, itemIndex }),
    }),
  submitAnswer: (sessionId: string, token: string, body: unknown) =>
    participantRequest<{ submissionId: string; submittedAt: number; revision: number; changed: boolean; status: string }>(
      `/api/sessions/${sessionId}/answers`,
      token,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  ownSubmission: (sessionId: string, questionId: string, token: string) =>
    participantRequest<{ responseText: string | null; choiceId: string | null; booleanValue: boolean | null; submittedAt: number } | null>(
      `/api/sessions/${sessionId}/submissions/${questionId}`,
      token,
    ),
  submitBuzzer: (sessionId: string, token: string, questionId: string) =>
    participantRequest<{ accepted: boolean; requestedAt: number; winner: string | null }>(
      `/api/sessions/${sessionId}/buzzer`,
      token,
      { method: 'POST', body: JSON.stringify({ questionId }) },
    ),
};

export { apiBaseUrl, wsBaseUrl };

export function adminWebSocketProtocols(): string[] {
  const token = getAdminToken();
  return token ? ['mzp-admin', `mzp-token.${token}`] : ['mzp-public'];
}
