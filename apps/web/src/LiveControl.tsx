import { useEffect, useRef, useState } from "react";

function TeamScreenLinks({ eventId }: { eventId: string }) {
  const [teams, setTeams] = useState<ParticipantItem[]>([]);
  useEffect(() => { let active = true; setTeams([]); if (eventId) void api.participants(eventId).then((items) => { if (active) setTeams(items.filter((item) => item.enabled)); }).catch(() => {}); return () => { active = false; }; }, [eventId]);
  return <section className="panel team-screen-links"><div className="panel-heading"><div><h3>Team table screens</h3><p>Open each display before launching. Use its link on the team's table computer on your local network.</p></div></div><div className="buzzer-team-grid">{teams.map((team, index) => <a className="button secondary" key={team.id} href={`/team-screen?eventId=${encodeURIComponent(eventId)}&participantId=${encodeURIComponent(team.id)}`} target="_blank" rel="noopener noreferrer">Open team {index + 1}<small>{team.displayName} ↗</small></a>)}</div>{teams.length === 0 && <p className="muted">Add enabled participants or teams to this event first.</p>}</section>;
}

function BuzzerControls({ sessionId, participants }: { sessionId: string; participants: ParticipantItem[] }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.buzzerControl>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => void api.buzzerControl(sessionId).then((value) => { if (active) setState(value); }).catch(() => {});
    load(); const interval = window.setInterval(load, 700);
    return () => { active = false; window.clearInterval(interval); };
  }, [sessionId]);
  async function control(action: string, participantId?: string) {
    setBusy(true); setError('');
    try { await api.controlBuzzer(sessionId, action, participantId); setState(await api.buzzerControl(sessionId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to control buzzer.'); }
    finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-heading"><div><h3>Buzzer control</h3><p>{state?.winner ? `First to buzz: ${state.winner.name}` : state?.control.open ? 'Buzzer open · waiting for a team' : 'Buzzer closed'}</p></div></div><div className="form-actions">
    <button className="button" disabled={busy || !state || Boolean(state.winner)} onClick={() => void control(state?.control.open ? 'close' : 'open')}>{state?.control.open ? 'Close buzzer' : 'Open buzzer'}</button>
    <button className="button" disabled={busy || !state?.winner || state.control.judged} onClick={() => void control('correct')}>Correct · award points</button>
    <button className="button danger" disabled={busy || !state?.winner || state.control.judged} onClick={() => void control('incorrect')}>Incorrect · apply penalty</button>
    <button className="button secondary" disabled={busy || !state?.winner || !state.control.judged} onClick={() => void control('reopen')}>Reopen for other teams</button>
  </div><div className="buzzer-team-grid">{participants.map((team, index) => <button type="button" className={`button secondary ${state?.winner?.participantId === team.id ? 'buzzer-team-selected' : ''}`} aria-pressed={state?.winner?.participantId === team.id} key={team.id} disabled={busy || state?.control.judged} onClick={() => void control('select', team.id)}><strong>{index + 1}</strong><span>{team.displayName}</span></button>)}</div>{error && <p className="error-text">{error}</p>}</section>;
}
import {
  api,
  adminWebSocketProtocols,
  wsBaseUrl,
  type AdminSessionState,
  type EventItem,
  type ParticipantItem,
  type SessionAction,
  type WebSocketMessage,
} from "./api";

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning";
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return `${minutes.toString().padStart(2, "0")}:${seconds.padStart(4, "0")}`;
}

export function LiveControl({ events }: { events: EventItem[] }) {
  const [selectedEventId, setSelectedEventId] = useState(events[0]?.id ?? "");
  const [session, setSession] = useState<AdminSessionState | null>(null);
  const [participants, setParticipants] = useState<ParticipantItem[]>([]);
  const [overlayParticipantId, setOverlayParticipantId] = useState("");
  const [overlayParticipantMode, setOverlayParticipantMode] = useState<
    "manual" | "rapid_fire"
  >("manual");
  const [selectedAudienceChoiceId, setSelectedAudienceChoiceId] = useState("");
  const [wsStatus, setWsStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [remainingMs, setRemainingMs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    detail: string;
    action: SessionAction;
    reopenAutoStart?: boolean;
  } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const autoRapidAssignmentRef = useRef<string | null>(null);

  useEffect(() => {
    setSelectedAudienceChoiceId(session?.audienceChoiceId ?? "");
  }, [session?.sessionId, session?.question?.id, session?.audienceChoiceId]);

  useEffect(() => {
    let active = true;
    if (!session) {
      setParticipants([]);
      return () => {
        active = false;
      };
    }
    void api
      .participants(session.eventId)
      .then((eventParticipants) => {
        if (active)
          setParticipants(
            eventParticipants.filter((participant) => participant.enabled),
          );
      })
      .catch((cause) => {
        if (active)
          setErrorMsg(
            cause instanceof Error
              ? cause.message
              : "Failed to load event contestants.",
          );
      });
    void api
      .overlaySettings(session.eventId)
      .then((overlaySettings) => {
        if (!active) return;
        setOverlayParticipantId(
          overlaySettings.participantBadgeParticipantId ?? "",
        );
        setOverlayParticipantMode(
          overlaySettings.participantBadgeMode ?? "manual",
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session?.eventId]);

  async function updateOverlayParticipant(
    participantId: string,
    mode = overlayParticipantMode,
  ) {
    if (!session) return;
    try {
      const saved = await api.updateOverlaySettings(session.eventId, {
        participantBadgeMode: mode,
        participantBadgeParticipantId: participantId || null,
      });
      setOverlayParticipantMode(saved.participantBadgeMode ?? "manual");
      setOverlayParticipantId(saved.participantBadgeParticipantId ?? "");
    } catch (cause) {
      setErrorMsg(
        cause instanceof Error
          ? cause.message
          : "Unable to update the overlay participant.",
      );
    }
  }

  useEffect(() => {
    const question = session?.question;
    const rapidFire = session?.rapidFire;
    const assignedParticipantId = question?.assignedParticipantId;
    const key =
      session && question
        ? `${session.sessionId}:${question.id}:${assignedParticipantId ?? ""}`
        : null;
    if (
      !session ||
      !question ||
      question.questionType !== "rapid_fire" ||
      !rapidFire ||
      overlayParticipantMode !== "rapid_fire" ||
      !assignedParticipantId ||
      rapidFire.selectedParticipantId ||
      autoRapidAssignmentRef.current === key
    )
      return;
    autoRapidAssignmentRef.current = key;
    void runRapidFireAction(() =>
      api.selectRapidFireContestant(session.sessionId, assignedParticipantId),
    );
  }, [
    overlayParticipantMode,
    session?.sessionId,
    session?.question?.id,
    session?.question?.questionType,
    session?.question?.assignedParticipantId,
    session?.rapidFire?.selectedParticipantId,
  ]);

  // Sync selected event if list updates
  useEffect(() => {
    if (!selectedEventId && events[0]) setSelectedEventId(events[0].id);
  }, [events, selectedEventId]);

  // Check for active sessions on load
  useEffect(() => {
    let isMounted = true;
    async function loadActive() {
      try {
        const activeList = await api.activeSessions();
        if (activeList.length > 0 && isMounted) {
          const first = activeList[0];
          setSelectedEventId(first.eventId);
          const full = await api.adminSession(first.id);
          if (isMounted) setSession(full);
        }
      } catch {
        // No active session
      }
    }
    void loadActive();
    return () => {
      isMounted = false;
    };
  }, []);

  // WebSocket Connection
  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout;

    function connect() {
      setWsStatus("connecting");
      try {
        const ws = new WebSocket(`${wsBaseUrl}/ws`, adminWebSocketProtocols());
        socketRef.current = ws;

        ws.onopen = () => {
          setWsStatus("connected");
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as WebSocketMessage;
            if (
              data.payload &&
              typeof data.payload === "object" &&
              "sessionId" in data.payload
            ) {
              const updatedSession = data.payload as AdminSessionState;
              setSession(updatedSession);
            }
          } catch {
            // ignore non-json
          }
        };

        ws.onclose = () => {
          setWsStatus("disconnected");
          reconnectTimer = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
          setWsStatus("disconnected");
        };
      } catch {
        setWsStatus("disconnected");
        reconnectTimer = setTimeout(connect, 3000);
      }
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  // Authoritative timer smooth display loop
  useEffect(() => {
    if (!session) {
      setRemainingMs(0);
      return;
    }

    if (
      session.status === "active" &&
      session.questionState === "active" &&
      session.timer.deadlineTimestamp
    ) {
      let active = true;
      const updateRem = () => {
        if (!active) return;
        const now = Date.now();
        const rem = Math.max(0, session.timer.deadlineTimestamp! - now);
        setRemainingMs(rem);
      };
      updateRem();
      const interval = setInterval(updateRem, 50);
      return () => {
        active = false;
        clearInterval(interval);
      };
    } else {
      setRemainingMs(session.timer.timeRemainingMs);
    }
  }, [session]);

  async function startNewSession() {
    if (!selectedEventId) return;
    setLoading(true);
    setErrorMsg("");
    try {
      const newSession = await api.startSession(selectedEventId);
      setSession(newSession);
    } catch (cause: any) {
      setErrorMsg(cause.message ?? "Failed to start session.");
    } finally {
      setLoading(false);
    }
  }

  async function handleControl(
    action: SessionAction,
    reopenAutoStart?: boolean,
  ) {
    if (!session) return;

    // Check for disruptive actions needing confirmation
    if (action === "previous_question") {
      setConfirmModal({ title: "Go to Previous Question?", detail: "This will stop the current countdown and return to the previous question with its timer reset. Existing scores and answers are preserved.", action });
      return;
    }
    if (action === "end_session") {
      setConfirmModal({
        title: "End Live Session?",
        detail:
          "This will close the live competition session for this event. All remaining questions will be marked completed.",
        action,
      });
      return;
    }

    if (action === "next_question" && session.questionState === "active") {
      setConfirmModal({
        title: "Skip Active Question?",
        detail:
          "The current question is still active and the countdown timer is running. Advancing will immediately conclude this question.",
        action,
      });
      return;
    }

    if (action === "reveal_answer" && session.questionState === "active") {
      setConfirmModal({
        title: "Reveal Answer Early?",
        detail:
          "The question timer has not expired yet. Revealing the answer will halt the countdown and show the correct answer.",
        action,
      });
      return;
    }

    if (action === "reopen_question" && session.questionState === "revealed") {
      setConfirmModal({
        title: "Reopen Revealed Question?",
        detail:
          "The correct answer has already been revealed. Reopening will reset the question state.",
        action,
        reopenAutoStart,
      });
      return;
    }

    await executeAction(action, reopenAutoStart);
  }

  async function executeAction(
    action: SessionAction,
    reopenAutoStart?: boolean,
  ) {
    if (!session) return;
    setLoading(true);
    setErrorMsg("");
    try {
      const updated = await api.controlSession(
        session.sessionId,
        action,
        reopenAutoStart,
      );
      setSession(updated);
    } catch (cause: any) {
      setErrorMsg(cause.message ?? "Failed to perform action.");
    } finally {
      setLoading(false);
    }
  }

  async function confirmAudienceChoice() {
    if (!session || !selectedAudienceChoiceId) return;
    setLoading(true);
    setErrorMsg("");
    try {
      setSession(
        await api.confirmAudienceChoice(
          session.sessionId,
          selectedAudienceChoiceId,
        ),
      );
    } catch (cause) {
      setErrorMsg(
        cause instanceof Error
          ? cause.message
          : "Failed to confirm the contestant choice.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function toggleMediaFullscreen(enable: boolean) {
    if (!session) return;
    setLoading(true);
    setErrorMsg("");
    try {
      const next = await api.toggleMediaFullscreen(session.sessionId, enable);
      setSession(next);
    } catch (cause) {
      setErrorMsg(
        cause instanceof Error
          ? cause.message
          : "Unable to toggle media fullscreen.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function revealQuestion() {
    if (!session) return;
    setLoading(true);
    setErrorMsg("");
    try {
      setSession(await api.revealQuestion(session.sessionId));
    } catch (cause) {
      setErrorMsg(
        cause instanceof Error
          ? cause.message
          : "Failed to reveal the question.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function revealNextChoice() {
    if (!session) return;
    setLoading(true);
    setErrorMsg("");
    try {
      setSession(await api.revealNextChoice(session.sessionId));
    } catch (cause) {
      setErrorMsg(
        cause instanceof Error
          ? cause.message
          : "Failed to reveal the next option.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function runRapidFireAction(action: () => Promise<AdminSessionState>) {
    if (!session) return;
    setLoading(true);
    setErrorMsg("");
    try {
      setSession(await action());
    } catch (cause) {
      setErrorMsg(
        cause instanceof Error
          ? cause.message
          : "Failed to update rapid-fire progress.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (!session || session.status === "ended") {
    return (
      <div className="page">
        <div className="section-header">
          <div>
            <div className="eyebrow">LIVE COMPETITION ENGINE</div>
            <h2>Live Game Control</h2>
            <p>
              Start a real-time quiz session for an event or manage the live
              room.
            </p>
          </div>
          <StatusPill tone={wsStatus === "connected" ? "success" : "warning"}>
            WS: {wsStatus}
          </StatusPill>
        </div>

        {errorMsg && <p className="error-text banner-message">{errorMsg}</p>}

        {session && session.status === "ended" && (
          <div className="info-box" style={{ borderColor: "#334967" }}>
            <small>Session Notice</small>
            <p>
              The previous live quiz session has ended. You can start a new live
              session below.
            </p>
          </div>
        )}

        <TeamScreenLinks eventId={selectedEventId} />
        <section className="panel" style={{ maxWidth: 640 }}>
          <div className="panel-heading">
            <div>
              <h3>Start a Live Session</h3>
              <p>Choose an event to launch the live competition engine.</p>
            </div>
          </div>

          {events.length === 0 ? (
            <p className="muted">
              No events found. Create an event and add rounds first.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "1.25rem" }}>
              <label className="field">
                <span>Select Event</span>
                <select
                  value={selectedEventId}
                  onChange={(e) => setSelectedEventId(e.target.value)}
                >
                  {events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.title} ({event.status})
                    </option>
                  ))}
                </select>
              </label>

              <div>
                <button
                  className="button"
                  disabled={loading || !selectedEventId}
                  onClick={() => {
                    void startNewSession();
                  }}
                >
                  {loading ? "Launching…" : "Launch Live Session"}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    );
  }

  const { question, round, questionState, timer } = session;
  const rapidFire = session.rapidFire;
  const selectedRapidFireParticipantId = rapidFire?.selectedParticipantId;
  const rapidFireItemIndex = rapidFire?.currentItemIndex ?? 0;
  const currentRapidFireItem =
    question?.questionType === "rapid_fire"
      ? question.rapidFireItems[rapidFireItemIndex]
      : undefined;
  const canAdvanceRapidFire = Boolean(
    rapidFire?.items.some(
      (item) =>
        item.index !== rapidFireItemIndex &&
        (item.status === "pending" || item.status === "passed"),
    ),
  );
  const rapidFireActionsDisabled =
    loading ||
    !session.questionRevealed ||
    !selectedRapidFireParticipantId ||
    session.status !== "active" ||
    questionState !== "active" ||
    remainingMs <= 0;
  const durationMs = timer.durationMs > 0 ? timer.durationMs : 30000;
  const progressPercent = Math.min(
    100,
    Math.max(0, (remainingMs / durationMs) * 100),
  );

  const timerTone =
    remainingMs <= 0 || questionState === "expired"
      ? "expired"
      : remainingMs <= 5000
        ? "warning"
        : "";

  const hasImageClue = Boolean(
    question?.mediaPath &&
      !/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(question.mediaPath),
  );

  return (
    <div className="page live-control-page">
      <div className="live-control-title">
        <div>
          <div className="eyebrow">LIVE COMPETITION ENGINE</div>
          <h2>Host console</h2>
          <p>
            Run the current question, manage the broadcast label, and keep the
            game moving.
          </p>
        </div>
        <div className="live-control-title-status">
          <span>NOW PLAYING</span>
          <strong>{session.eventTitle}</strong>
        </div>
      </div>
      {/* Session Header Bar */}
      <div className="session-bar">
        <div className="session-bar-info">
          <div>
            <div className="eyebrow" style={{ fontSize: ".65rem" }}>
              LIVE SESSION · {session.eventTitle}
            </div>
            <strong style={{ fontSize: "1.1rem" }}>
              {round
                ? `Round ${round.orderIndex + 1}: ${round.name}`
                : "No active round"}
            </strong>
          </div>
          <StatusPill
            tone={session.status === "active" ? "success" : "warning"}
          >
            Session: {session.status}
          </StatusPill>
          <StatusPill
            tone={
              questionState === "active" || questionState === "revealed"
                ? "success"
                : questionState === "paused" || questionState === "expired"
                  ? "warning"
                  : "neutral"
            }
          >
            Question: {questionState}
          </StatusPill>
        </div>

        <div className="session-bar-actions">
          <StatusPill tone={wsStatus === "connected" ? "success" : "warning"}>
            WS: {wsStatus}
          </StatusPill>
          {session.status === "active" ? (
            <button
              className="button secondary small"
              disabled={loading}
              onClick={() => void handleControl("pause_session")}
            >
              Pause Session
            </button>
          ) : (
            <button
              className="button small"
              disabled={loading}
              onClick={() => void handleControl("resume_session")}
            >
              Resume Session
            </button>
          )}
          <button
            className="button danger small"
            disabled={loading}
            onClick={() => void handleControl("end_session")}
          >
            End Session
          </button>
        </div>
      </div>

      {errorMsg && <p className="error-text banner-message">{errorMsg}</p>}

      {/* Main Grid: Left = Question & Choices, Right = Timer & Controls */}
      <div className="live-grid">
        {/* Left Column: Question Details */}
        <section className="panel live-question-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">
                QUESTION{" "}
                {round
                  ? `${round.currentQuestionIndex + 1} OF ${round.totalQuestions}`
                  : "1"}
              </div>
              <h3 style={{ textTransform: "capitalize" }}>
                {question
                  ? question.questionType.replace(/_/g, " ")
                  : "No Question"}
              </h3>
            </div>
            {question && (
              <div style={{ display: "flex", gap: ".5rem" }}>
                <StatusPill>{question.points} pts</StatusPill>
                {question.penaltyPoints > 0 && (
                  <StatusPill tone="warning">
                    -{question.penaltyPoints} pts
                  </StatusPill>
                )}
              </div>
            )}
          </div>
          {question?.assignedParticipantId && (
            <div className="assigned-question-banner">
              <span>ASSIGNED TO</span>
              <strong>
                {participants.find(
                  (participant) =>
                    participant.id === question.assignedParticipantId,
                )?.displayName ?? "Assigned participant"}
              </strong>
            </div>
          )}

          {question ? (
            <div>
              {question.questionType !== "rapid_fire" && (
                <div className="live-prompt">{question.prompt}</div>
              )}

              {/* OBS Fullscreen Liquid Glass Media Control for Image Clues */}
              {hasImageClue && (
                <section className="obs-media-control-card" aria-label="OBS clue layout controls">
                  <div className="obs-media-control-info">
                    <div className="obs-media-control-title">
                      <span className="eyebrow">OBS LAYOUT · MEDIA CLUE</span>
                      <strong>Fullscreen Image Spotlight</strong>
                    </div>
                    <p>
                      Broadcast this image in fullscreen on the OBS overlay with a blurred liquid glass background so the live audience can see details clearly.
                    </p>
                  </div>
                  <div className="obs-media-control-actions">
                    <button
                      type="button"
                      className={`button ${session.mediaFullscreen ? "secondary" : ""}`}
                      disabled={loading}
                      onClick={() => void toggleMediaFullscreen(!session.mediaFullscreen)}
                      aria-label={session.mediaFullscreen ? "Exit OBS Fullscreen" : "Fullscreen Image on OBS"}
                    >
                      {session.mediaFullscreen ? "⤓ Exit OBS Fullscreen" : "⤢ Fullscreen Image on OBS"}
                    </button>
                    <span className={`pill ${session.mediaFullscreen ? "success" : ""}`}>
                      {session.mediaFullscreen ? "OBS: Spotlight Active" : "OBS: Standard Layout"}
                    </span>
                  </div>
                  {question.mediaPath && (
                    <div className="live-media-thumbnail-preview">
                      <img src={question.mediaPath} alt="Question clue thumbnail" />
                    </div>
                  )}
                </section>
              )}

              {/* Choices (Multiple Choice) */}
              {question.questionType === "multiple_choice" &&
                question.choices && (
                  <div className="live-choices">
                    {question.choices.map((choice, index) => {
                      const isCorrect = Boolean(
                        (choice as { isCorrect?: boolean }).isCorrect,
                      );
                      const isRevealed = questionState === "revealed";
                      const isAudienceChoice =
                        session.audienceChoiceId === choice.id;
                      const audienceResultClass =
                        isRevealed && isAudienceChoice
                          ? isCorrect
                            ? "audience-choice-correct"
                            : "audience-choice-incorrect"
                          : "";
                      return (
                        <div
                          key={choice.id}
                          className={`live-choice ${isAudienceChoice && !isRevealed ? "is-audience-choice" : ""} ${audienceResultClass} ${isCorrect ? "is-correct" : ""} ${
                            isRevealed && isCorrect ? "revealed" : ""
                          }`}
                        >
                          <span className="choice-letter">
                            {letters[index] ?? index + 1}
                          </span>
                          <span className="choice-text">
                            {choice.choiceText}
                          </span>
                          {isCorrect && (
                            <span
                              style={{
                                fontSize: ".75rem",
                                fontWeight: 700,
                                color: isRevealed ? "#70d6c7" : "#a7f3d0",
                              }}
                            >
                              {isRevealed
                                ? "✓ Correct Answer"
                                : "✓ (Admin key)"}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

              {question.questionType === "multiple_choice" &&
                question.choices.length > 0 &&
                session.questionRevealed &&
                questionState !== "revealed" &&
                questionState !== "completed" && (
                  <section className="audience-choice-control">
                    <div>
                      <strong>Contestant's spoken choice</strong>
                      <p>
                        Select the option they said, then confirm it to show the
                        choice on OBS. This does not reveal whether it is
                        correct.
                      </p>
                    </div>
                    <div className="audience-choice-actions">
                      <select
                        aria-label="Contestant's spoken choice"
                        value={selectedAudienceChoiceId}
                        disabled={loading || session.status !== 'active' || questionState !== 'active' || remainingMs <= 0}
                        onChange={(event) =>
                          setSelectedAudienceChoiceId(event.target.value)
                        }
                      >
                        <option value="">Select an option…</option>
                        {question.choices.map((choice, index) => (
                          <option key={choice.id} value={choice.id}>
                            {letters[index] ?? index + 1}. {choice.choiceText}
                          </option>
                        ))}
                      </select>
                      <button
                        className="button"
                        disabled={
                          loading ||
                          session.status !== 'active' || questionState !== 'active' || remainingMs <= 0 ||
                          !selectedAudienceChoiceId ||
                          selectedAudienceChoiceId === session.audienceChoiceId
                        }
                        onClick={() => void confirmAudienceChoice()}
                      >
                        {session.audienceChoiceId
                          ? "Update confirmed choice"
                          : "Confirm choice for OBS"}
                      </button>
                    </div>
                    <small aria-live="polite">
                      {session.status !== 'active' || questionState !== 'active' || remainingMs <= 0
                        ? 'Start or resume the question timer to select and confirm a spoken choice.'
                        : session.audienceChoiceId
                        ? "The confirmed choice is visible on the public overlay. Confirm another option to change it."
                        : "No contestant choice is currently shown on the overlay."}
                    </small>
                  </section>
                )}

              {/* True/False Question */}
              {question.questionType === "true_false" && (
                <div className="live-choices">
                  {["true", "false"].map((val) => {
                    const isMatch = String(question.correctValue) === val;
                    const isRevealed = questionState === "revealed";
                    return (
                      <div
                        key={val}
                        className={`live-choice ${isMatch ? "is-correct" : ""} ${
                          isRevealed && isMatch ? "revealed" : ""
                        }`}
                      >
                        <span className="choice-letter">
                          {val === "true" ? "T" : "F"}
                        </span>
                        <span
                          className="choice-text"
                          style={{ textTransform: "capitalize" }}
                        >
                          {val}
                        </span>
                        {isMatch && (
                          <span
                            style={{
                              fontSize: ".75rem",
                              fontWeight: 700,
                              color: isRevealed ? "#70d6c7" : "#a7f3d0",
                            }}
                          >
                            {isRevealed ? "✓ Correct Answer" : "✓ (Admin key)"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Short Answer / Written */}
              {question.questionType !== "multiple_choice" &&
                question.questionType !== "true_false" && (
                  <div className="info-box">
                    <small>
                      Accepted Answer Variations (
                      {question.acceptedAnswersCount})
                    </small>
                    <p>
                      {question.acceptedAnswers &&
                      question.acceptedAnswers.length > 0
                        ? question.acceptedAnswers
                            .map((a) => a.answerText)
                            .join(", ")
                        : "No specific accepted answers configured."}
                    </p>
                  </div>
                )}

              {/* Explanation (Admin sees always, marked hidden from public) */}
              {question.explanation && (
                <div className="info-box">
                  <small>
                    Explanation{" "}
                    {questionState !== "revealed" && (
                      <span style={{ color: "#f59e0b" }}>
                        (Hidden from public until reveal)
                      </span>
                    )}
                  </small>
                  <p>{question.explanation}</p>
                </div>
              )}

              {/* Responses Count */}
              <div className="live-question-metrics">
                <div>
                  <small style={{ color: "#71849d", display: "block" }}>
                    Total Accepted Responses
                  </small>
                  <strong style={{ fontSize: "1.2rem", color: "#70d6c7" }}>
                    {question.totalAcceptedResponses}
                  </strong>
                </div>
                <div>
                  <small style={{ color: "#71849d", display: "block" }}>
                    Configured Answer Variations
                  </small>
                  <strong style={{ fontSize: "1.2rem", color: "#e8eef8" }}>
                    {question.acceptedAnswersCount}
                  </strong>
                </div>
              </div>
            </div>
          ) : (
            <p className="muted">No active question for this session.</p>
          )}
        </section>

        {/* Right Column: Timer & Controls */}
        <aside className="live-command-column">
          {/* Authoritative Server Countdown Widget */}
          <div className="timer-card">
            <div className="timer-header">
              <span className="eyebrow">SERVER TIMER</span>
              <StatusPill
                tone={
                  questionState === "active"
                    ? "success"
                    : questionState === "paused"
                      ? "warning"
                      : "neutral"
                }
              >
                {questionState}
              </StatusPill>
            </div>

            <div className={`timer-value ${timerTone}`}>
              {formatTime(remainingMs)}
            </div>

            <div className="timer-progress">
              <div
                className={`timer-fill ${timerTone}`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <small style={{ color: "#71849d" }}>
              Allocated: {durationMs / 1000}s · Synced with Authoritative Server
              Clock
            </small>
          </div>

          {/* Question Controls Toolbar */}
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h3>Question Controls</h3>
                <p>
                  {question && session.questionRevealed
                    ? question.questionType === "multiple_choice"
                      ? `Question revealed · Options: ${session.revealedChoiceCount} / ${question.choices.length}`
                      : "Question revealed"
                    : "Reveal the question and options to the audience in stages."}
                </p>
              </div>
            </div>

            <div
              className="question-control-actions"
              aria-label="Question actions"
            >
              <button type="button" className="button secondary" disabled={loading || (round?.orderIndex === 0 && round?.currentQuestionIndex === 0)} onClick={() => void handleControl("previous_question")}>← Previous Question</button>
              {question &&
                questionState !== "revealed" &&
                questionState !== "completed" &&
                (!session.questionRevealed ? (
                  <button
                    className="button"
                    disabled={loading}
                    onClick={() => void revealQuestion()}
                  >
                    Reveal Question
                  </button>
                ) : question.questionType === "multiple_choice" &&
                  session.revealedChoiceCount < question.choices.length ? (
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void revealNextChoice()}
                  >
                    Reveal Option{" "}
                    {letters[session.revealedChoiceCount] ??
                      session.revealedChoiceCount + 1}
                    {question.choices[session.revealedChoiceCount]?.choiceText
                      ? `: ${question.choices[session.revealedChoiceCount].choiceText}`
                      : ""}
                  </button>
                ) : null)}

              {hasImageClue && (
                <button
                  type="button"
                  className={`button ${session.mediaFullscreen ? "secondary" : ""}`}
                  disabled={loading}
                  onClick={() => void toggleMediaFullscreen(!session.mediaFullscreen)}
                  title="Toggle fullscreen image for live audience overlay"
                >
                  {session.mediaFullscreen ? "⤓ Exit OBS Fullscreen" : "⤢ OBS Fullscreen Image"}
                </button>
              )}

              {/* Ready State */}
              {questionState === "ready" && (
                <>
                  <button
                    className="button"
                    disabled={loading || session.status === "paused"}
                    onClick={() => void handleControl("start_question")}
                  >
                    Start Question Timer
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("next_question")}
                  >
                    Skip to Next Question
                  </button>
                </>
              )}

              {/* Active State */}
              {questionState === "active" && (
                <>
                  <button
                    className="button warning-btn"
                    disabled={loading}
                    onClick={() => void handleControl("pause_question")}
                  >
                    Pause Timer
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("reveal_answer")}
                  >
                    Reveal Answer Now
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("expire_question")}
                  >
                    Expire Timer Immediately
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("next_question")}
                  >
                    Next Question
                  </button>
                </>
              )}

              {/* Paused State */}
              {questionState === "paused" && (
                <>
                  <button
                    className="button"
                    disabled={loading || session.status === "paused"}
                    onClick={() => void handleControl("resume_question")}
                  >
                    Resume Timer
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("reveal_answer")}
                  >
                    Reveal Answer
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("reopen_question")}
                  >
                    Reset Question Timer
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("next_question")}
                  >
                    Next Question
                  </button>
                </>
              )}

              {/* Expired State */}
              {questionState === "expired" && (
                <>
                  <button
                    className="button"
                    disabled={loading}
                    onClick={() => void handleControl("reveal_answer")}
                  >
                    Reveal Answer
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("reopen_question")}
                  >
                    Reopen Question
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("next_question")}
                  >
                    Next Question
                  </button>
                </>
              )}

              {/* Revealed State */}
              {questionState === "revealed" && (
                <>
                  <button
                    className="button"
                    disabled={loading}
                    onClick={() => void handleControl("next_question")}
                  >
                    Next Question →
                  </button>
                  <button
                    className="button secondary"
                    disabled={loading}
                    onClick={() => void handleControl("reopen_question")}
                  >
                    Reopen Question
                  </button>
                </>
              )}

              {/* Completed State */}
              {questionState === "completed" && (
                <button
                  className="button"
                  disabled={loading}
                  onClick={() => void handleControl("end_session")}
                >
                  Conclude Session
                </button>
              )}
            </div>
          </section>
          {question?.questionType === 'buzzer' && <BuzzerControls key={question.id} sessionId={session.sessionId} participants={participants} />}
          <section className="panel overlay-participant-control">
            <div className="panel-heading">
              <div>
                <h3>Current question participant</h3>
                <p>
                  Manually override the planned participant/team for this live
                  question. The selected name is shown on OBS.
                </p>
              </div>
              <StatusPill
                tone={
                  overlayParticipantMode === "rapid_fire"
                    ? "warning"
                    : "success"
                }
              >
                {overlayParticipantMode === "rapid_fire"
                  ? "Rapid-fire automation"
                  : "Manual control"}
              </StatusPill>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Controller</span>
                <select
                  value={overlayParticipantMode}
                  onChange={(event) =>
                    void updateOverlayParticipant(
                      overlayParticipantId,
                      event.target.value as "manual" | "rapid_fire",
                    )
                  }
                >
                  <option value="manual">Manual · choose below</option>
                  <option value="rapid_fire">
                    Auto · follow rapid-fire contestant
                  </option>
                </select>
              </label>
              <label className="field">
                <span>Participant or team</span>
                <select
                  value={overlayParticipantId}
                  disabled={overlayParticipantMode === "rapid_fire"}
                  onChange={(event) =>
                    void updateOverlayParticipant(event.target.value)
                  }
                >
                  <option value="">Hide participant label</option>
                  {participants.map((participant) => (
                    <option key={participant.id} value={participant.id}>
                      {participant.displayName}
                      {participant.teamIdentifier
                        ? ` (${participant.teamIdentifier})`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {question?.assignedParticipantId && (
              <div className="participant-override-note">
                <span>
                  Planned assignment:{" "}
                  <strong>
                    {participants.find(
                      (participant) =>
                        participant.id === question.assignedParticipantId,
                    )?.displayName ?? "Assigned participant"}
                  </strong>
                </span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    void updateOverlayParticipant(
                      question.assignedParticipantId!,
                      "manual",
                    )
                  }
                >
                  Use planned assignment
                </button>
              </div>
            )}
          </section>
          {question?.questionType === "rapid_fire" && rapidFire && (
            <section className="panel rapid-fire-controls">
              <div className="panel-heading">
                <div>
                  <h3>Rapid-Fire Control</h3>
                  <p>
                    Select the contestant, then judge or pass each prompt while
                    the timer is running.
                  </p>
                </div>
              </div>
              {!(
                overlayParticipantMode === "rapid_fire" &&
                question.assignedParticipantId
              ) && (
                <label className="field">
                  <span className="field-title">Contestant</span>
                  <select
                    aria-label="Rapid-fire contestant"
                    value={rapidFire.selectedParticipantId ?? ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        void runRapidFireAction(() =>
                          api.selectRapidFireContestant(
                            session.sessionId,
                            event.target.value,
                          ),
                        );
                      }
                    }}
                  >
                    <option value="">Select a contestant</option>
                    {participants.map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.displayName}
                        {participant.teamIdentifier
                          ? ` (${participant.teamIdentifier})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {overlayParticipantMode === "rapid_fire" &&
                question.assignedParticipantId && (
                  <div className="rapid-fire-assignment">
                    <span>USING PRE-ASSIGNED PARTICIPANT</span>
                    <strong>
                      {participants.find(
                        (participant) =>
                          participant.id === question.assignedParticipantId,
                      )?.displayName ?? "Assigned participant"}
                    </strong>
                  </div>
                )}
              <div className="rapid-fire-current-prompt">
                <strong>
                  Question {rapidFireItemIndex + 1} of{" "}
                  {question.rapidFireItems.length}
                </strong>
                <span>{currentRapidFireItem?.prompt}</span>
                <small>
                  Accepted answer: {currentRapidFireItem?.answerText}
                </small>
                <div
                  className="rapid-fire-admin-progress"
                  aria-label="Prompt results"
                >
                  {rapidFire.items.map((item) => (
                    <button
                      type="button"
                      className={`rapid-fire-admin-circle status-${item.status} ${item.index === rapidFireItemIndex ? "is-current" : ""}`}
                      key={item.index}
                      disabled={
                        rapidFireActionsDisabled ||
                        item.index === rapidFireItemIndex ||
                        (item.status !== "pending" && item.status !== "passed")
                      }
                      onClick={() =>
                        void runRapidFireAction(() =>
                          api.selectRapidFireItem(
                            session.sessionId,
                            item.index,
                          ),
                        )
                      }
                      aria-current={
                        item.index === rapidFireItemIndex ? "step" : undefined
                      }
                      aria-label={`Go to rapid-fire question ${item.index + 1}: ${item.status}${item.index === rapidFireItemIndex ? ", active" : ""}`}
                      title={
                        item.index === rapidFireItemIndex
                          ? `Question ${item.index + 1} is active`
                          : item.status === "pending" ||
                              item.status === "passed"
                            ? `Go to question ${item.index + 1}`
                            : `Question ${item.index + 1} is already judged`
                      }
                    >
                      {item.index + 1}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rapid-fire-judge-actions">
                <button
                  className="button"
                  disabled={rapidFireActionsDisabled}
                  onClick={() => {
                    if (selectedRapidFireParticipantId) {
                      void runRapidFireAction(() =>
                        api.judgeRapidFireItem(
                          session.sessionId,
                          selectedRapidFireParticipantId,
                          rapidFireItemIndex,
                          true,
                        ),
                      );
                    }
                  }}
                >
                  Mark Correct (+
                  {Math.floor(
                    question.points / question.rapidFireItems.length,
                  ) +
                    (rapidFireItemIndex <
                    question.points % question.rapidFireItems.length
                      ? 1
                      : 0)}
                  )
                </button>
                <button
                  className="button danger"
                  disabled={rapidFireActionsDisabled}
                  onClick={() => {
                    if (selectedRapidFireParticipantId) {
                      void runRapidFireAction(() =>
                        api.judgeRapidFireItem(
                          session.sessionId,
                          selectedRapidFireParticipantId,
                          rapidFireItemIndex,
                          false,
                        ),
                      );
                    }
                  }}
                >
                  Mark Incorrect
                </button>
                <button
                  className="button secondary"
                  disabled={rapidFireActionsDisabled}
                  onClick={() => {
                    if (selectedRapidFireParticipantId) {
                      void runRapidFireAction(() =>
                        api.passRapidFireItem(
                          session.sessionId,
                          selectedRapidFireParticipantId,
                          rapidFireItemIndex,
                        ),
                      );
                    }
                  }}
                >
                  Pass Question
                </button>
                <button
                  className="button secondary"
                  disabled={rapidFireActionsDisabled || !canAdvanceRapidFire}
                  onClick={() => {
                    if (selectedRapidFireParticipantId) {
                      void runRapidFireAction(() =>
                        api.nextRapidFireItem(
                          session.sessionId,
                          selectedRapidFireParticipantId,
                          rapidFireItemIndex,
                        ),
                      );
                    }
                  }}
                >
                  Next Rapid-Fire Question
                </button>
              </div>
              {!selectedRapidFireParticipantId ? (
                <small className="muted">
                  Select a contestant to enable judging, passing, and advancing
                  prompts.
                </small>
              ) : !session.questionRevealed ? (
                <small className="muted">
                  Reveal the rapid-fire question to enable its controls.
                </small>
              ) : questionState !== "active" || remainingMs <= 0 ? (
                <small className="muted">
                  Start or resume the timer to enable rapid-fire controls.
                </small>
              ) : !canAdvanceRapidFire ? (
                <small className="muted">
                  No other unanswered or passed prompts are available to advance
                  to.
                </small>
              ) : null}
              {rapidFire.items.some((item) => item.status === "passed") && (
                <small className="muted">
                  Passed prompts can be revisited with Next Rapid-Fire Question
                  while time remains.
                </small>
              )}
            </section>
          )}
        </aside>
      </div>

      {/* Disruptive Action Confirmation Modal */}
      {confirmModal && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>{confirmModal.title}</h3>
            <p>{confirmModal.detail}</p>
            <div className="modal-actions">
              <button
                className="button secondary"
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                className="button danger"
                disabled={loading}
                onClick={async () => {
                  const modal = confirmModal;
                  setConfirmModal(null);
                  await executeAction(modal.action, modal.reopenAutoStart);
                }}
              >
                Confirm Action
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
