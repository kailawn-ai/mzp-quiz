// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type AdminSessionState } from "./api";
import { LiveControl } from "./LiveControl";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LiveControl screen", () => {
  it("renders initial state when no active session exists", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <LiveControl
          events={[
            {
              id: "ev-1",
              title: "Annual Quiz Night",
              description: "General trivia",
              status: "ready",
              settings: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("Live Game Control");
    expect(container.textContent).toContain("Annual Quiz Night");
    expect(container.textContent).toContain("Launch Live Session");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("lets the host select a contestant and judge rapid-fire prompts", async () => {
    class MockWebSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", MockWebSocket);
    const session: AdminSessionState = {
      sessionId: "session-rf",
      eventId: "event-rf",
      eventTitle: "Rapid Fire Night",
      status: "active",
      round: {
        id: "round-rf",
        name: "Rapid Fire",
        roundType: "rapid_fire",
        orderIndex: 0,
        totalQuestions: 1,
        currentQuestionIndex: 0,
      },
      question: {
        id: "question-rf",
        roundId: "round-rf",
        questionType: "rapid_fire",
        prompt: "Answer as many as you can.",
        explanation: null,
        mediaPath: null,
        durationMs: 30000,
        points: 10,
        penaltyPoints: 0,
        orderIndex: 0,
        choices: [],
        correctValue: null,
        acceptedAnswers: [],
        acceptedAnswersCount: 0,
        rapidFireItems: [
          {
            id: 1,
            questionId: "question-rf",
            orderIndex: 0,
            prompt: "Name a city",
            answerText: "New York",
          },
          {
            id: 2,
            questionId: "question-rf",
            orderIndex: 1,
            prompt: "Name a river",
            answerText: "Nile",
          },
        ],
        totalAcceptedResponses: 0,
      },
      questionState: "active",
      audienceChoiceId: null,
      questionRevealed: true,
      revealedChoiceCount: 0,
      answerChangesAllowed: false,
      timer: {
        durationMs: 30000,
        timeRemainingMs: 30000,
        deadlineTimestamp: Date.now() + 30000,
        isPaused: false,
      },
      rapidFire: {
        selectedParticipantId: null,
        currentItemIndex: 0,
        items: [
          {
            index: 0,
            prompt: "Name a city",
            answerText: null,
            status: "pending",
          },
          { index: 1, prompt: null, answerText: null, status: "pending" },
        ],
      },
      revealedAnswer: null,
      updatedAt: Date.now(),
    };
    vi.spyOn(api, "activeSessions").mockResolvedValue([
      {
        id: session.sessionId,
        eventId: session.eventId,
        status: "active",
        currentRoundId: "round-rf",
        currentQuestionId: "question-rf",
        questionState: "active",
        timeRemainingMs: 30000,
        deadlineTimestamp: session.timer.deadlineTimestamp,
        autoAdvance: false,
        createdAt: 1,
        updatedAt: 1,
        endedAt: null,
      },
    ]);
    vi.spyOn(api, "adminSession").mockResolvedValue(session);
    vi.spyOn(api, "participants").mockResolvedValue([
      {
        id: "participant-rf",
        eventId: "event-rf",
        participantType: "contestant",
        displayName: "Ada",
        teamIdentifier: null,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const selectContestant = vi
      .spyOn(api, "selectRapidFireContestant")
      .mockResolvedValue({
        ...session,
        rapidFire: {
          ...session.rapidFire!,
          selectedParticipantId: "participant-rf",
        },
      });
    const nextItem = vi.spyOn(api, "nextRapidFireItem").mockResolvedValue({
      ...session,
      rapidFire: {
        ...session.rapidFire!,
        selectedParticipantId: "participant-rf",
        currentItemIndex: 1,
        items: [
          { index: 0, prompt: null, answerText: null, status: "pending" },
          {
            index: 1,
            prompt: "Name a river",
            answerText: null,
            status: "pending",
          },
        ],
      },
    });
    const secondPromptSession: AdminSessionState = {
      ...session,
      rapidFire: {
        ...session.rapidFire!,
        selectedParticipantId: "participant-rf",
        currentItemIndex: 1,
        items: [
          { index: 0, prompt: null, answerText: null, status: "pending" },
          {
            index: 1,
            prompt: "Name a river",
            answerText: null,
            status: "pending",
          },
        ],
      },
    };
    const judge = vi
      .spyOn(api, "judgeRapidFireItem")
      .mockResolvedValue(secondPromptSession);
    const pass = vi
      .spyOn(api, "passRapidFireItem")
      .mockResolvedValue(secondPromptSession);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<LiveControl events={[]} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
    });

    expect(container.textContent).toContain("Rapid-Fire Control");
    expect(container.textContent).toContain("Accepted answer: New York");
    expect(container.querySelector(".live-prompt")).toBeNull();
    const correctButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Mark Correct"));
    const incorrectButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Mark Incorrect"));
    const passButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Pass Question"));
    const nextButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) =>
      button.textContent?.includes("Next Rapid-Fire Question"),
    );
    expect(correctButton?.disabled).toBe(true);
    expect(incorrectButton?.disabled).toBe(true);
    expect(passButton?.disabled).toBe(true);
    expect(nextButton?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Select a contestant to enable judging",
    );

    const contestantSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Rapid-fire contestant"]',
    );
    expect(contestantSelect).not.toBeNull();
    await act(async () => {
      contestantSelect!.value = "participant-rf";
      contestantSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(selectContestant).toHaveBeenCalledWith(
      "session-rf",
      "participant-rf",
    );

    expect(nextButton?.disabled).toBe(false);
    expect(nextButton?.closest(".rapid-fire-judge-actions")).not.toBeNull();
    await act(async () => {
      nextButton?.click();
      await Promise.resolve();
    });
    expect(nextItem).toHaveBeenCalledWith("session-rf", "participant-rf", 0);

    expect(correctButton?.disabled).toBe(false);
    await act(async () => {
      correctButton?.click();
      await Promise.resolve();
    });
    expect(judge).toHaveBeenCalledWith("session-rf", "participant-rf", 1, true);
    expect(incorrectButton?.disabled).toBe(false);
    expect(passButton?.disabled).toBe(false);
    await act(async () => {
      passButton?.click();
      await Promise.resolve();
    });
    expect(pass).toHaveBeenCalledWith("session-rf", "participant-rf", 1);

    await act(async () => root.unmount());
    container.remove();
  });

  it("lets the admin confirm a contestant choice separately from revealing the answer", async () => {
    class MockWebSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close() {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", MockWebSocket);

    const session: AdminSessionState = {
      sessionId: "session-1",
      eventId: "event-1",
      eventTitle: "Quiz Night",
      status: "active",
      round: {
        id: "round-1",
        name: "Round One",
        roundType: "multiple_choice",
        orderIndex: 0,
        totalQuestions: 1,
        currentQuestionIndex: 0,
      },
      question: {
        id: "question-1",
        roundId: "round-1",
        questionType: "multiple_choice",
        prompt: "Which option?",
        explanation: null,
        mediaPath: null,
        durationMs: 30000,
        points: 10,
        penaltyPoints: 0,
        orderIndex: 0,
        choices: [
          {
            id: "choice-a",
            questionId: "question-1",
            choiceText: "Option A",
            orderIndex: 0,
            isCorrect: false,
            createdAt: 1,
          },
          {
            id: "choice-b",
            questionId: "question-1",
            choiceText: "Option B",
            orderIndex: 1,
            isCorrect: true,
            createdAt: 1,
          },
        ],
        correctValue: null,
        acceptedAnswers: [],
        acceptedAnswersCount: 0,
        rapidFireItems: [],
        totalAcceptedResponses: 0,
      },
      questionState: "active",
      audienceChoiceId: null,
      questionRevealed: false,
      revealedChoiceCount: 0,
      answerChangesAllowed: false,
      timer: {
        durationMs: 30000,
        timeRemainingMs: 30000,
        deadlineTimestamp: Date.now() + 30000,
        isPaused: false,
      },
      rapidFire: null,
      revealedAnswer: null,
      updatedAt: Date.now(),
    };
    vi.spyOn(api, "activeSessions").mockResolvedValue([
      {
        id: session.sessionId,
        eventId: session.eventId,
        status: "active",
        currentRoundId: "round-1",
        currentQuestionId: "question-1",
        questionState: "active",
        timeRemainingMs: 30000,
        deadlineTimestamp: Date.now() + 30000,
        autoAdvance: false,
        createdAt: 1,
        updatedAt: 1,
        endedAt: null,
      },
    ]);
    vi.spyOn(api, "adminSession").mockResolvedValue(session);
    const revealQuestion = vi.spyOn(api, "revealQuestion").mockResolvedValue({
      ...session,
      questionRevealed: true,
    });
    const revealNextChoice = vi
      .spyOn(api, "revealNextChoice")
      .mockResolvedValue({
        ...session,
        questionRevealed: true,
        revealedChoiceCount: 1,
      });
    const confirmChoice = vi
      .spyOn(api, "confirmAudienceChoice")
      .mockResolvedValue({
        ...session,
        questionRevealed: true,
        revealedChoiceCount: 1,
        audienceChoiceId: "choice-a",
      });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<LiveControl events={[]} />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const revealQuestionButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Reveal Question"));
    expect(revealQuestionButton).toBeDefined();
    expect(revealQuestionButton?.classList.contains("button")).toBe(true);
    expect(
      revealQuestionButton?.closest(".question-control-actions"),
    ).not.toBeNull();
    expect(container.querySelector(".question-reveal-controls")).toBeNull();
    const pauseTimerButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Pause Timer"));
    expect(pauseTimerButton?.closest(".question-control-actions")).toBe(
      revealQuestionButton?.closest(".question-control-actions"),
    );
    expect(
      container.querySelector(
        'select[aria-label="Contestant\'s spoken choice"]',
      ),
    ).toBeNull();
    await act(async () => {
      revealQuestionButton?.click();
      await Promise.resolve();
    });
    expect(revealQuestion).toHaveBeenCalledWith("session-1");

    const revealOptionButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Reveal Option A"));
    expect(revealOptionButton).toBeDefined();
    expect(revealOptionButton?.classList.contains("secondary")).toBe(true);
    expect(revealOptionButton?.closest(".question-control-actions")).toBe(
      revealQuestionButton?.closest(".question-control-actions"),
    );
    await act(async () => {
      revealOptionButton?.click();
      await Promise.resolve();
    });
    expect(revealNextChoice).toHaveBeenCalledWith("session-1");

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Contestant\'s spoken choice"]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = "choice-a";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const confirmButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Confirm choice for OBS"));
    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
    });

    expect(confirmChoice).toHaveBeenCalledWith("session-1", "choice-a");
    expect(container.textContent).toContain(
      "The confirmed choice is visible on the public overlay.",
    );
    expect(container.textContent).toContain("Reveal Answer Now");

    await act(async () => root.unmount());
    container.remove();
  });
});
