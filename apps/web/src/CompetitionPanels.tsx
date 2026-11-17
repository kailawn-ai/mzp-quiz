import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminWebSocketProtocols, api, type EventItem, type LeaderboardEntry, type ParticipantItem, type SubmissionReviewItem, wsBaseUrl } from './api';

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

export function ParticipantManager({ event }: { event: EventItem }) {
  const [participants, setParticipants] = useState<ParticipantItem[]>([]);
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const [participantType, setParticipantType] = useState<'contestant' | 'team'>('contestant');
  const [names, setNames] = useState('');
  const [teamIdentifier, setTeamIdentifier] = useState('');
  const load = useCallback(async () => {
    try {
      setParticipants(await api.participants(event.id));
      setMessage('');
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }, [event.id]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(participant: ParticipantItem) {
    try {
      const updated = await api.updateParticipant(participant.id, { enabled: !participant.enabled });
      setParticipants((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function editParticipant(participant: ParticipantItem, body: Record<string, unknown>) {
    try {
      const updated = await api.updateParticipant(participant.id, body);
      setParticipants((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage('');
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function deleteParticipant(participant: ParticipantItem) {
    const confirmed = window.confirm(
      `Delete ${participant.displayName}? This permanently removes their registration. This cannot be undone.\n\nIf they have already played or scored, disable them instead so their event history is preserved.`,
    );
    if (!confirmed) return;
    try {
      await api.deleteParticipant(participant.id);
      setParticipants((current) => current.filter((item) => item.id !== participant.id));
      setMessage(`${participant.displayName} was deleted.`);
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function addParticipants(formEvent: FormEvent) {
    formEvent.preventDefault();
    const displayNames = names.split('\n').map((name) => name.trim()).filter(Boolean);
    if (displayNames.length === 0) {
      setMessage('Add at least one participant name.');
      return;
    }
    setAdding(true);
    setMessage('');
    try {
      const results = await Promise.allSettled(displayNames.map((displayName) => api.registerParticipant(event.id, {
        participantType,
        displayName,
        teamIdentifier: teamIdentifier.trim() || undefined,
      })));
      const created = results.filter((result): result is PromiseFulfilledResult<ParticipantItem & { token: string }> => result.status === 'fulfilled').map((result) => result.value);
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (created.length) {
        setParticipants((current) => [...current, ...created].sort((a, b) => a.displayName.localeCompare(b.displayName)));
        setNames('');
        setTeamIdentifier('');
      }
      setMessage(failed.length ? `${created.length} added. ${failed.length} could not be added (check for duplicate names).` : `${created.length} participant${created.length === 1 ? '' : 's'} added.`);
    } catch (cause) {
      setMessage(messageOf(cause));
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="panel participant-manager">
      <div className="panel-heading">
        <div><h3>Participants</h3><p>{participants.length} registered · disabled entries stay in score history.</p></div>
        <button className="button secondary small" onClick={() => void load()}>Refresh</button>
      </div>
      <form className="participant-add-form" onSubmit={addParticipants}>
        <div className="participant-add-heading"><strong>Add participants</strong><span>One name per line</span></div>
        <div className="participant-add-fields">
          <select aria-label="Participant type" value={participantType} onChange={(event) => setParticipantType(event.target.value as 'contestant' | 'team')}>
            <option value="contestant">Contestant</option>
            <option value="team">Team</option>
          </select>
          <textarea aria-label="Participant names" required value={names} onChange={(event) => setNames(event.target.value)} placeholder={'Aisha Khan\nRohan Patel\nTeam Orion'} rows={3} />
          <input aria-label="Team identifier" value={teamIdentifier} onChange={(event) => setTeamIdentifier(event.target.value)} placeholder="Group / team code (optional)" maxLength={80} />
          <button className="button" disabled={adding}>{adding ? 'Adding…' : 'Add participants'}</button>
        </div>
      </form>
      {participants.length === 0 && !message && <p className="muted">Add names above to register the first participants.</p>}
      <div className="table-list participant-list">
        {participants.map((participant) => (
          <div className="participant-row" key={participant.id}>
            <div className="participant-details">
              <select aria-label={`Type for ${participant.displayName}`} value={participant.participantType} onChange={(event) => void editParticipant(participant, { participantType: event.target.value })}>
                <option value="contestant">Contestant</option>
                <option value="team">Team</option>
              </select>
              <input
                aria-label={`Display name for ${participant.displayName}`}
                defaultValue={participant.displayName}
                onBlur={(event) => {
                  const displayName = event.currentTarget.value.trim();
                  if (displayName && displayName !== participant.displayName) {
                    void editParticipant(participant, { displayName });
                  }
                }}
              />
              <input
                aria-label={`Team identifier for ${participant.displayName}`}
                placeholder="Optional team identifier"
                defaultValue={participant.teamIdentifier ?? ''}
                onBlur={(event) => {
                  const teamIdentifier = event.currentTarget.value.trim();
                  if (teamIdentifier !== (participant.teamIdentifier ?? '')) {
                    void editParticipant(participant, { teamIdentifier });
                  }
                }}
              />
            </div>
            <div className="participant-actions">
              <span className={`pill ${participant.enabled ? 'success' : 'warning'}`}>{participant.enabled ? 'Enabled' : 'Disabled'}</span>
              <button className="button secondary small" onClick={() => void toggle(participant)}>
                {participant.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="button danger small" onClick={() => void deleteParticipant(participant)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {message && <p className="error-text">{message}</p>}
    </section>
  );
}

export function LeaderboardPanel({ event }: { event: EventItem }) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [participants, setParticipants] = useState<ParticipantItem[]>([]);
  const [participantId, setParticipantId] = useState('');
  const [pointsDelta, setPointsDelta] = useState(0);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const [leaderboard, registered] = await Promise.all([
        api.leaderboard(event.id),
        api.participants(event.id),
      ]);
      setEntries(leaderboard);
      setParticipants(registered);
      setParticipantId((current) => registered.some((item) => item.id === current) ? current : registered[0]?.id ?? '');
      setMessage('');
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }, [event.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let reconnect: ReturnType<typeof setTimeout>;
    let active = true;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (!active) return;
      socket = new WebSocket(`${wsBaseUrl}/ws`, adminWebSocketProtocols());
      socket.onmessage = (socketEvent) => {
        try {
          const message = JSON.parse(socketEvent.data) as {
            type?: string;
            payload?: { eventId?: string; entries?: LeaderboardEntry[] };
          };
          if (message.type === 'leaderboard_updated' && message.payload?.eventId === event.id && message.payload.entries) {
            setEntries(message.payload.entries);
          }
        } catch {
          setMessage('Unable to read a leaderboard update.');
        }
      };
      socket.onclose = () => {
        if (active) reconnect = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      active = false;
      clearTimeout(reconnect);
      socket?.close();
    };
  }, [event.id]);

  async function adjust(eventForm: FormEvent) {
    eventForm.preventDefault();
    try {
      await api.adjustScore(event.id, { participantId, pointsDelta, reason });
      setReason('');
      setPointsDelta(0);
      await load();
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  async function reset() {
    if (!window.confirm(`Reset ${event.title}'s leaderboard? This preserves all answer and score audit history.`)) return;
    try {
      await api.resetScores(event.id);
      await load();
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><h3>Leaderboard</h3><p>Points are server-scored. Equal scores use correct-answer count, then name.</p></div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button className="button secondary small" onClick={() => void load()}>Refresh</button>
          <button className="button secondary small" onClick={() => void reset()}>Reset scores</button>
        </div>
      </div>
      <div className="table-list">
        {entries.map((entry) => (
          <div className="table-row" key={entry.participantId}>
            <div><strong>#{entry.rank} {entry.displayName}</strong><span>{entry.teamIdentifier ?? 'Contestant'}</span></div>
            <div><strong>{entry.totalPoints} pts</strong><span>{entry.correctAnswers} correct</span></div>
          </div>
        ))}
        {entries.length === 0 && <p className="muted">No scored submissions yet.</p>}
      </div>
      <form className="inline-form" onSubmit={adjust}>
        <h4>Administrative score adjustment</h4>
        <div className="form-grid">
          <label className="field"><span>Participant</span><select value={participantId} onChange={(e) => setParticipantId(e.target.value)} required>
            {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.displayName}</option>)}
          </select></label>
          <label className="field"><span>Points (+/-)</span><input type="number" min="-1000000" max="1000000" value={pointsDelta} onChange={(e) => setPointsDelta(Number(e.target.value))} /></label>
        </div>
        <label className="field"><span>Reason (required for audit)</span><input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="button" disabled={!participantId}>Record adjustment</button>
      </form>
      {message && <p className="error-text">{message}</p>}
    </section>
  );
}

export function SubmissionReviewPanel({ event }: { event: EventItem }) {
  const [submissions, setSubmissions] = useState<SubmissionReviewItem[]>([]);
  const [reason, setReason] = useState('Host review');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try {
      setSubmissions(await api.reviewSubmissions(event.id));
      setMessage('');
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }, [event.id]);
  useEffect(() => { void load(); }, [load]);

  async function grade(submissionId: string, isCorrect: boolean) {
    try {
      await api.gradeSubmission(submissionId, isCorrect, reason);
      await load();
    } catch (cause) {
      setMessage(messageOf(cause));
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><h3>Answer review</h3><p>Manually judge answers marked for review.</p></div>
        <button className="button secondary small" onClick={() => void load()}>Refresh</button>
      </div>
      <label className="field"><span>Audit reason</span><input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="table-list">
        {submissions.map((submission) => (
          <div className="table-row" key={submission.id}>
            <div>
              <strong>{submission.displayName}: {submission.response ?? '(no text answer)'}</strong>
              <span>{submission.prompt}</span>
            </div>
            {submission.isCorrect === null ? (
              <div style={{ display: 'flex', gap: '.5rem' }}>
                <button className="button secondary small" disabled={!reason.trim()} onClick={() => void grade(submission.id, false)}>Incorrect</button>
                <button className="button small" disabled={!reason.trim()} onClick={() => void grade(submission.id, true)}>Correct</button>
              </div>
            ) : (
              <span className={`pill ${submission.isCorrect ? 'success' : 'warning'}`}>
                {submission.isCorrect ? `Correct · ${submission.pointsAwarded} pts` : 'Incorrect'}
              </span>
            )}
          </div>
        ))}
        {submissions.length === 0 && <p className="muted">No answer submissions yet.</p>}
      </div>
      {message && <p className="error-text">{message}</p>}
    </section>
  );
}
