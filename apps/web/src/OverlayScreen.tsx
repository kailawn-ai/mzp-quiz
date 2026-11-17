import { useEffect, useRef, useState } from "react";
import Countdown, { type CountdownRenderProps } from "react-countdown";
import {
  api,
  wsBaseUrl,
  type LeaderboardEntry,
  type OverlayLayout,
  type OverlaySettings,
  type PublicSessionState,
  type WebSocketMessage,
} from "./api";

const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
const defaults: OverlaySettings = {
  layout: "classic",
  primaryColor: "#7dd3fc",
  secondaryColor: "#a78bfa",
  backgroundColor: "#020617",
  panelColor: "#0f172a",
  panelOpacity: 0.86,
  showPanelBackground: true,
  questionFontSize: 52,
  choiceFontSize: 30,
  choiceGap: 20,
  contentScale: 0.72,
  countdownStyle: "ring",
  eventTitle: "",
  logoPath: null,
  backgroundImagePath: null,
  lowerThirdText: "",
  customFontFamily: "",
  participantBadgeMode: "manual",
  participantBadgeParticipantId: null,
};

export function OverlayScreen() {
  const query = new URLSearchParams(window.location.search);
  const pathKind = window.location.pathname.match(
    /\/overlay\/(main|question|timer|leaderboard|round|announcement)/,
  )?.[1];
  const requestedKind = query.get("overlay") ?? pathKind ?? "main";
  const requestedLayout = query.get("layout") as OverlayLayout | null;
  const requestedScale = query.get("scale");
  const requestedEventId = query.get("eventId");
  const [session, setSession] = useState<PublicSessionState | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [settings, setSettings] = useState<OverlaySettings>(defaults);
  const [participants, setParticipants] = useState<
    Array<{
      id: string;
      participantType: "team" | "contestant";
      displayName: string;
      teamIdentifier: string | null;
    }>
  >([]);
  const eventIdRef = useRef<string | null>(requestedEventId);

  useEffect(() => {
    let active = true;
    void api
      .activeSessions()
      .then(async (sessions) => {
        const selected = sessions.find(
          (item) => !requestedEventId || item.eventId === requestedEventId,
        );
        if (!selected) return;
        const [state, overlaySettings, scores] = await Promise.all([
          api.publicSession(selected.id),
          api.overlaySettings(selected.eventId),
          api.leaderboard(selected.eventId),
        ]);
        if (!active) return;
        eventIdRef.current = selected.eventId;
        setSession(state);
        setSettings(overlaySettings);
        setLeaderboard(scores);
        void api
          .publicParticipants(selected.eventId)
          .then(setParticipants)
          .catch(() => {});
      })
      .catch(() => {
        /* The overlay remains in standby until the server reconnects. */
      });
    return () => {
      active = false;
    };
  }, [requestedEventId]);

  useEffect(() => {
    if (!eventIdRef.current) return;
    const refresh = () => {
      const eventId = eventIdRef.current;
      if (eventId)
        void Promise.all([
          api.overlaySettings(eventId),
          api.publicParticipants(eventId),
        ])
          .then(([nextSettings, nextParticipants]) => {
            setSettings(nextSettings);
            setParticipants(nextParticipants);
          })
          .catch(() => {});
    };
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  }, [session?.eventId]);

  useEffect(() => {
    let reconnect: ReturnType<typeof setTimeout>;
    let active = true;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (!active) return;
      socket = new WebSocket(`${wsBaseUrl}/ws`);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          if (
            message.payload &&
            typeof message.payload === "object" &&
            "sessionId" in message.payload
          ) {
            const state = message.payload as PublicSessionState;
            if (!eventIdRef.current || state.eventId === eventIdRef.current) {
              eventIdRef.current = state.eventId;
              setSession(state);
              void api
                .overlaySettings(state.eventId)
                .then(setSettings)
                .catch(() => {});
            }
          }
          if (
            message.type === "leaderboard_updated" &&
            message.payload &&
            "entries" in message.payload
          ) {
            const update = message.payload as {
              eventId: string;
              entries: LeaderboardEntry[];
            };
            if (!eventIdRef.current || update.eventId === eventIdRef.current)
              setLeaderboard(update.entries);
          }
        } catch {
          /* Ignore malformed messages and keep the last good frame. */
        }
      };
      socket.onclose = () => {
        if (active) reconnect = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      active = false;
      clearTimeout(reconnect);
      socket?.close();
    };
  }, []);

  const layout = requestedLayout ?? settings.layout;
  const question = session?.question;
  const badgeParticipantId =
    question?.questionType === "buzzer"
      ? session?.buzzerParticipantId
      : question?.questionType === "rapid_fire"
        ? settings.participantBadgeMode === "rapid_fire"
          ? (session?.rapidFire?.selectedParticipantId ?? null)
          : settings.participantBadgeParticipantId
        : (question?.assignedParticipantId ??
          (settings.participantBadgeMode === "manual"
            ? settings.participantBadgeParticipantId
            : null));
  const badgeParticipant = participants.find(
    (participant) => participant.id === badgeParticipantId,
  );
  const scaleOverride =
    requestedScale === null ? Number.NaN : Number(requestedScale);
  const contentScale =
    Number.isFinite(scaleOverride) &&
    scaleOverride >= 0.5 &&
    scaleOverride <= 1.2
      ? scaleOverride
      : settings.contentScale;
  const revealed = session?.questionState === "revealed";
  const style = {
    "--overlay-primary": settings.primaryColor,
    "--overlay-secondary": settings.secondaryColor,
    "--overlay-bg": settings.backgroundColor,
    "--overlay-panel": settings.panelColor,
    "--overlay-panel-opacity": settings.panelOpacity,
    "--overlay-question-size": `${settings.questionFontSize}px`,
    "--overlay-choice-size": `${settings.choiceFontSize}px`,
    "--overlay-choice-gap": `${settings.choiceGap}px`,
    "--overlay-content-scale": contentScale,
    "--overlay-position-x": `${Number.isFinite(Number(query.get("x"))) && query.has("x") ? Math.max(-50, Math.min(50, Number(query.get("x")))) : (settings.positionX ?? 0)}vw`,
    "--overlay-position-y": `${Number.isFinite(Number(query.get("y"))) && query.has("y") ? Math.max(-80, Math.min(20, Number(query.get("y")))) : (settings.positionY ?? 0)}vh`,
    fontFamily: settings.customFontFamily || "inherit",
    "--overlay-image": settings.backgroundImagePath
      ? `url(${settings.backgroundImagePath})`
      : "none",
  } as React.CSSProperties;

  const header = (
    <header className="overlay-header">
      <div>
        {settings.logoPath && (
          <img className="overlay-logo" src={settings.logoPath} alt="" />
        )}
        <div className="overlay-event-title">
          {settings.eventTitle || session?.eventTitle || "MZP QUIZ"}
        </div>
      </div>
      {session?.round && (
        <span className="overlay-round">
          Round {session.round.orderIndex + 1} · {session.round.name}
        </span>
      )}
    </header>
  );
  const participantBadge = badgeParticipant ? (
    <div className="overlay-participant-badge">
      <span>
        {badgeParticipant.participantType === "team" ? "TEAM" : "PARTICIPANT"}
        {question?.questionType === "buzzer"
          ? ` ${participants.findIndex((participant) => participant.id === badgeParticipant.id) + 1}`
          : ""}
      </span>
      <strong>{badgeParticipant.displayName}</strong>
    </div>
  ) : null;
  const timerDurationMs = Math.max(session?.timer.durationMs ?? 0, 1);
  const timerDate =
    session?.questionState === "active" && session.timer.deadlineTimestamp
      ? session.timer.deadlineTimestamp
      : Date.now() + Math.max(0, session?.timer.timeRemainingMs ?? 0);
  const timerKey = `${session?.sessionId ?? "standby"}-${question?.id ?? "no-question"}-${session?.questionState ?? "idle"}-${session?.timer.deadlineTimestamp ?? session?.timer.timeRemainingMs ?? 0}`;
  const timerActive =
    session?.questionState === "active" &&
    Boolean(session.timer.deadlineTimestamp);
  const timer = (
    <Countdown
      key={timerKey}
      date={timerDate}
      autoStart={timerActive}
      intervalDelay={100}
      precision={1}
      renderer={({ total, completed }: CountdownRenderProps) => {
        const remainingMs = Math.max(0, total);
        const minutes = Math.floor(remainingMs / 60_000);
        const seconds = Math.floor((remainingMs % 60_000) / 1_000);
        const progress = Math.min(1, remainingMs / timerDurationMs);
        const warning = timerActive && remainingMs <= 10_000 && remainingMs > 0;
        const expired = completed || remainingMs === 0;
        const ringOffset = 283 * (1 - progress);
        return (
          <div
            className={`overlay-timer ${settings.countdownStyle}${warning ? " warning" : ""}${expired ? " expired" : ""}`}
            role="timer"
            aria-label={`Time remaining: ${minutes} minutes, ${seconds} seconds`}
          >
            {settings.countdownStyle === "ring" && (
              <svg
                className="overlay-timer-ring"
                viewBox="0 0 100 100"
                aria-hidden="true"
              >
                <circle
                  className="overlay-timer-ring-track"
                  cx="50"
                  cy="50"
                  r="45"
                />
                <circle
                  className="overlay-timer-ring-progress"
                  cx="50"
                  cy="50"
                  r="45"
                  style={{ strokeDashoffset: ringOffset }}
                />
              </svg>
            )}
            <span className="overlay-timer-label">TIME LEFT</span>
            <span className="overlay-timer-value">
              {String(minutes).padStart(2, "0")}:
              {String(seconds).padStart(2, "0")}
            </span>
            {settings.countdownStyle === "bar" && (
              <span className="overlay-timer-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${progress})` }} />
              </span>
            )}
          </div>
        );
      }}
    />
  );
  const correctChoiceIds = new Set(
    session?.revealedAnswer?.correctChoices?.map((choice) => choice.id) ?? [],
  );
  const revealedTextAnswers =
    session?.revealedAnswer?.acceptedAnswers.map(
      (answer) => answer.answerText,
    ) ?? [];
  const revealedAnswerValues =
    session?.revealedAnswer?.correctValue !== null &&
    session?.revealedAnswer?.correctValue !== undefined
      ? [session.revealedAnswer.correctValue ? "True" : "False"]
      : revealedTextAnswers;
  const choices = question?.choices?.map((choice, index) => {
    const isAudienceChoice = session?.audienceChoiceId === choice.id;
    const isCorrect = revealed && correctChoiceIds.has(choice.id);
    const audienceResultClass =
      revealed && isAudienceChoice
        ? isCorrect
          ? "audience-choice-correct"
          : "audience-choice-incorrect"
        : "";
    const revealedOption =
      revealed || index < (session?.revealedChoiceCount ?? 0);
    return (
      <div
        key={choice.id}
        className={`overlay-choice ${isAudienceChoice && !revealed ? "audience-choice" : ""} ${isCorrect ? "correct answer-revealed" : ""} ${revealed && !isCorrect && !isAudienceChoice ? "answer-muted" : ""} ${audienceResultClass}`}
        style={isCorrect ? { animationDelay: `${index * 100}ms` } : undefined}
      >
        <b>{letters[index] ?? index + 1}</b>
        {revealedOption && (
          <span className="overlay-choice-text">{choice.choiceText}</span>
        )}
      </div>
    );
  });
  const questionIsLive =
    session?.status === "active" &&
    Boolean(question) &&
    session.questionState !== "completed";
  const questionVisibleToAudience =
    questionIsLive &&
    Boolean(
      session?.questionRevealed ||
      (question?.questionType === "rapid_fire" && session?.rapidFire),
    );
  const showLeaderboard = requestedKind === "leaderboard";
  const hasOverlayContent =
    requestedKind === "announcement"
      ? Boolean(settings.lowerThirdText)
      : requestedKind === "round"
        ? Boolean(session?.round)
        : showLeaderboard
          ? leaderboard.length > 0
          : questionIsLive;
  const questionBlock =
    questionIsLive && question ? (
      <>
        {question.questionType === "rapid_fire" ? (
          session.rapidFire && (
            <div
              className="overlay-rapid-fire-stage"
              key={`${question.id}-${session.rapidFire.currentItemIndex}`}
              aria-live="polite"
            >
              <div className="overlay-rapid-fire-active-label">
                NOW ASKING · QUESTION {session.rapidFire.currentItemIndex + 1}
              </div>
              <div className="overlay-rapid-fire-prompt">
                {session.rapidFire.items[session.rapidFire.currentItemIndex]
                  ?.prompt ?? ""}
              </div>
              <div
                className="overlay-rapid-fire-progress"
                aria-label="Rapid-fire prompt results"
              >
                {session.rapidFire.items.map((item) => (
                  <span
                    className={`overlay-rapid-fire-circle status-${item.status} ${item.index === session.rapidFire?.currentItemIndex ? "is-current" : ""}`}
                    key={`${question.id}-${item.index}`}
                    aria-current={
                      item.index === session.rapidFire?.currentItemIndex
                        ? "step"
                        : undefined
                    }
                    aria-label={`Question ${item.index + 1}: ${item.status}${item.index === session.rapidFire?.currentItemIndex ? ", active" : ""}`}
                    title={`Question ${item.index + 1}: ${item.status}`}
                  >
                    {item.index + 1}
                  </span>
                ))}
              </div>
              {revealed &&
                session.rapidFire.items[session.rapidFire.currentItemIndex]
                  ?.answerText && (
                  <div className="overlay-rapid-fire-answer">
                    Answer:{" "}
                    {
                      session.rapidFire.items[
                        session.rapidFire.currentItemIndex
                      ].answerText
                    }
                  </div>
                )}
            </div>
          )
        ) : question.questionType === "image_audio_clue" ? (
          session.questionRevealed && (
            <div className="overlay-clue-stage">
              <div className="overlay-clue-heading">
                <span>VISUAL ROUND</span>
              </div>
              <div className="overlay-clue-media" key={question.id}>
                {question.mediaPath ? (
                  /\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(
                    question.mediaPath,
                  ) ? (
                    <div className="overlay-audio-clue">
                      <div className="overlay-clue-wave" aria-hidden="true">
                        {Array.from({ length: 25 }, (_, index) => (
                          <i
                            key={index}
                            style={{ height: `${20 + ((index * 37) % 80)}%` }}
                          />
                        ))}
                      </div>
                      <span>AUDIO CLUE</span>
                      <audio
                        controls
                        preload="metadata"
                        src={question.mediaPath}
                        aria-label="Audio clue"
                      />
                    </div>
                  ) : (
                    <img src={question.mediaPath} alt="Quiz image clue" />
                  )
                ) : (
                  <div className="overlay-clue-placeholder">
                    Clue media not configured
                  </div>
                )}
              </div>
              <div className="overlay-clue-caption">
                <div>{question.prompt}</div>
              </div>
            </div>
          )
        ) : (
          <>
            <div className="overlay-question-stage">
              <div className="overlay-question-type">
                {question.questionType.replace(/_/g, " ")}
              </div>
              {session.questionRevealed && (
                <div className="overlay-question">{question.prompt}</div>
              )}
            </div>
            {session.questionRevealed && (
              <div
                className="overlay-choices"
                style={{ gap: `${settings.choiceGap}px` }}
              >
                {choices}
              </div>
            )}
          </>
        )}
        {revealed &&
          question.questionType !== "multiple_choice" &&
          question.questionType !== "rapid_fire" &&
          session.revealedAnswer && (
            <section
              className="overlay-answer-reveal"
              key={`answer-${question.id}`}
              aria-live="polite"
            >
              {revealedAnswerValues.length > 0 ? (
                <div className="overlay-answer-values">
                  {revealedAnswerValues.map((answer, index) => (
                    <span
                      className="overlay-answer-value"
                      key={`${answer}-${index}`}
                    >
                      {answer}
                    </span>
                  ))}
                </div>
              ) : (
                <strong className="overlay-answer-unavailable">
                  See the host for the accepted answer
                </strong>
              )}
              {session.revealedAnswer.explanation && (
                <p className="overlay-answer-explanation">
                  {session.revealedAnswer.explanation}
                </p>
              )}
            </section>
          )}
      </>
    ) : null;
  const leaderboardBlock = (
    <div className="overlay-leaderboard">
      {leaderboard.slice(0, 8).map((entry) => (
        <div className="overlay-leaderboard-row" key={entry.participantId}>
          <span>
            #{entry.rank} {entry.displayName}
          </span>
          <strong>{entry.totalPoints} pts</strong>
        </div>
      ))}
      {leaderboard.length === 0 && (
        <div className="overlay-standby">No scores recorded yet.</div>
      )}
    </div>
  );

  return (
    <main
      className={`overlay-screen overlay-${layout} overlay-kind-${requestedKind} ${settings.showPanelBackground ? "" : "overlay-transparent-background"} ${settings.backgroundImagePath ? "has-background-image" : ""}`}
      style={style}
      aria-label="OBS quiz overlay"
    >
      {hasOverlayContent &&
        (showLeaderboard ? (
          leaderboardBlock
        ) : requestedKind === "timer" ? (
          timer
        ) : requestedKind !== "round" &&
          requestedKind !== "announcement" &&
          questionVisibleToAudience ? (
          <div className="overlay-composition">
            <section className="overlay-content">{questionBlock}</section>
            {timer}
          </div>
        ) : null)}
      {hasOverlayContent && participantBadge}
      {hasOverlayContent && header}
      {hasOverlayContent && requestedKind === "round" && session?.round && (
        <div className="overlay-transition">{session.round.name}</div>
      )}
      {hasOverlayContent &&
        requestedKind === "announcement" &&
        settings.lowerThirdText && (
          <div className="overlay-lower-third">{settings.lowerThirdText}</div>
        )}
      {/* Real-time Fullscreen Image Spotlight with Blurred Liquid Glass Background */}
      {session?.mediaFullscreen &&
        question?.mediaPath &&
        !/\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i.test(question.mediaPath) && (
          <div
            className="overlay-media-fullscreen-backdrop"
            role="dialog"
            aria-label="Fullscreen visual clue"
          >
            <div
              className="overlay-media-fullscreen-liquid-layer"
              aria-hidden="true"
            />
            <div className="overlay-media-fullscreen-card">
              <div className="overlay-media-fullscreen-header">
                <span className="overlay-media-fullscreen-badge">
                  <span className="fullscreen-live-dot" /> VISUAL CLUE ·
                  QUESTION {question.orderIndex + 1}
                </span>
                <div className="overlay-media-fullscreen-prompt">
                  {question.prompt}
                </div>
              </div>
              <div className="overlay-media-fullscreen-frame">
                <img
                  src={question.mediaPath}
                  alt={question.prompt || "Visual clue"}
                  className="overlay-media-fullscreen-image"
                />
              </div>
            </div>
          </div>
        )}
    </main>
  );
}
