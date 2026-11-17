import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const participantSchema = z.object({
  participantType: z.enum(['team', 'contestant']).default('contestant'),
  displayName: z.string().trim().min(1).max(100),
  teamIdentifier: z.string().trim().max(80).optional(),
});
const participantUpdateSchema = participantSchema.partial().extend({
  enabled: z.boolean().optional(),
});
const normalizeIdentityPart = (value: string) =>
  value.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class CompetitionError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompetitionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type Participant = {
  id: string;
  eventId: string;
  participantType: 'team' | 'contestant';
  displayName: string;
  teamIdentifier: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

function mapParticipant(row: {
  id: string;
  event_id: string;
  participant_type: 'team' | 'contestant';
  display_name: string;
  team_identifier: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}): Participant {
  return {
    id: row.id,
    eventId: row.event_id,
    participantType: row.participant_type,
    displayName: row.display_name,
    teamIdentifier: row.team_identifier,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const participantSelect =
  'SELECT id, event_id, participant_type, display_name, team_identifier, enabled, created_at, updated_at FROM event_participants';

export function createParticipantService(database: Database.Database) {
  return {
    register(eventId: string, input: unknown): { participant: Participant; token: string } {
      const value = participantSchema.parse(input);
      if (!database.prepare('SELECT id FROM events WHERE id = ?').get(eventId)) {
        throw new CompetitionError(404, 'EVENT_NOT_FOUND', 'Event not found.');
      }

      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const timestamp = Date.now();
      const normalizedIdentity = [
        value.participantType,
        normalizeIdentityPart(value.displayName),
        normalizeIdentityPart(value.teamIdentifier ?? ''),
      ].join(':');
      database.prepare(`
        INSERT INTO event_participants
          (id, event_id, participant_type, display_name, normalized_identity, team_identifier, token_hash, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        eventId,
        value.participantType,
        value.displayName,
        normalizedIdentity,
        value.teamIdentifier || null,
        hashToken(token),
        timestamp,
        timestamp,
      );
      return { participant: this.get(id)!, token };
    },

    get(id: string): Participant | null {
      const row = database.prepare(`${participantSelect} WHERE id = ?`).get(id) as Parameters<typeof mapParticipant>[0] | undefined;
      return row ? mapParticipant(row) : null;
    },

    list(eventId: string): Participant[] {
      const rows = database.prepare(`${participantSelect} WHERE event_id = ? ORDER BY display_name COLLATE NOCASE, id`).all(eventId) as Parameters<typeof mapParticipant>[0][];
      return rows.map(mapParticipant);
    },

    update(id: string, input: unknown): Participant | null {
      const current = this.get(id);
      if (!current) return null;
      const value = participantUpdateSchema.parse(input);
      const participantType = value.participantType ?? current.participantType;
      const displayName = value.displayName ?? current.displayName;
      const teamIdentifier = value.teamIdentifier === undefined ? current.teamIdentifier : value.teamIdentifier || null;
      const normalizedIdentity = [
        participantType,
        normalizeIdentityPart(displayName),
        normalizeIdentityPart(teamIdentifier ?? ''),
      ].join(':');
      database.prepare(`
        UPDATE event_participants
        SET participant_type = ?, display_name = ?, normalized_identity = ?, team_identifier = ?,
            enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        participantType,
        displayName,
        normalizedIdentity,
        teamIdentifier,
        value.enabled === undefined ? Number(current.enabled) : Number(value.enabled),
        Date.now(),
        id,
      );
      return this.get(id);
    },

    remove(id: string): boolean {
      if (!this.get(id)) return false;
      const hasHistory = database.prepare(`
        SELECT 1 FROM answer_submissions WHERE participant_id = ?
        UNION ALL SELECT 1 FROM score_transactions WHERE participant_id = ?
        UNION ALL SELECT 1 FROM buzzer_requests WHERE participant_id = ?
        UNION ALL SELECT 1 FROM session_rapid_fire_control WHERE selected_participant_id = ?
        UNION ALL SELECT 1 FROM session_rapid_fire_progress WHERE participant_id = ?
        UNION ALL SELECT 1 FROM session_rapid_fire_results WHERE participant_id = ?
        LIMIT 1
      `).get(id, id, id, id, id, id);
      if (hasHistory) {
        throw new CompetitionError(409, 'PARTICIPANT_HAS_HISTORY', 'This participant has quiz activity and cannot be deleted. Disable them to preserve the event record.');
      }
      database.prepare('DELETE FROM event_participants WHERE id = ?').run(id);
      return true;
    },

    authenticate(token: string): Participant {
      const row = database.prepare(`${participantSelect} WHERE token_hash = ? AND enabled = 1`)
        .get(hashToken(token)) as Parameters<typeof mapParticipant>[0] | undefined;
      if (!row) throw new CompetitionError(401, 'PARTICIPANT_UNAUTHORIZED', 'A valid enabled participant token is required.');
      return mapParticipant(row);
    },

    leaderboard(eventId: string) {
      type TotalsRow = {
        id: string;
        display_name: string;
        team_identifier: string | null;
        total_points: number;
        correct_answers: number;
      };
      const totals = database.prepare(`
        SELECT p.id, p.display_name, p.team_identifier,
          COALESCE(SUM(st.points_delta), 0) AS total_points,
          (SELECT COUNT(*) FROM (
            SELECT s.question_id FROM answer_submissions s
            WHERE s.participant_id = p.id AND s.is_current = 1 AND s.is_correct = 1
              AND s.score_generation = e.score_generation
            UNION
            SELECT b.question_id FROM buzzer_requests b
            WHERE b.participant_id = p.id AND b.accepted = 1
              AND b.score_generation = e.score_generation
          )) AS correct_answers
        FROM event_participants p
        JOIN events e ON e.id = p.event_id
        LEFT JOIN score_transactions st ON st.participant_id = p.id AND st.event_id = p.event_id AND st.generation = e.score_generation
        WHERE p.event_id = ?
        GROUP BY p.id
        ORDER BY total_points DESC, correct_answers DESC, p.display_name COLLATE NOCASE ASC, p.id ASC
      `).all(eventId) as TotalsRow[];

      const roundTotals = database.prepare(`
        SELECT st.participant_id, st.round_id, r.name AS round_name,
          COALESCE(SUM(st.points_delta), 0) AS points,
          (SELECT COUNT(*) FROM (
            SELECT s.question_id FROM answer_submissions s
            WHERE s.participant_id = st.participant_id AND s.is_current = 1
              AND s.is_correct = 1 AND s.question_id IN (
                SELECT q.id FROM questions q WHERE q.round_id = st.round_id
              ) AND s.score_generation = e.score_generation
            UNION
            SELECT b.question_id FROM buzzer_requests b
            WHERE b.participant_id = st.participant_id AND b.accepted = 1
              AND b.question_id IN (SELECT q.id FROM questions q WHERE q.round_id = st.round_id)
              AND b.score_generation = e.score_generation
          )) AS correct_answers
        FROM score_transactions st
        JOIN rounds r ON r.id = st.round_id
        JOIN events e ON e.id = st.event_id
        WHERE st.event_id = ? AND st.generation = e.score_generation
        GROUP BY st.participant_id, st.round_id
      `).all(eventId) as Array<{
        participant_id: string;
        round_id: string;
        round_name: string;
        points: number;
        correct_answers: number;
      }>;
      const roundsByParticipant = new Map<string, Array<{
        roundId: string;
        roundName: string;
        points: number;
        correctAnswers: number;
      }>>();
      for (const round of roundTotals) {
        const values = roundsByParticipant.get(round.participant_id) ?? [];
        values.push({
          roundId: round.round_id,
          roundName: round.round_name,
          points: round.points,
          correctAnswers: round.correct_answers,
        });
        roundsByParticipant.set(round.participant_id, values);
      }
      return totals.map((row, index) => ({
        rank: index + 1,
        participantId: row.id,
        displayName: row.display_name,
        teamIdentifier: row.team_identifier,
        totalPoints: row.total_points,
        correctAnswers: row.correct_answers,
        rounds: roundsByParticipant.get(row.id) ?? [],
      }));
    },
  };
}

export type ParticipantService = ReturnType<typeof createParticipantService>;
