import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildTestApp, removeTemporaryDatabase, temporaryDatabase } from "./test-utils.js";

describe("database API", () => {
  let fixture: ReturnType<typeof temporaryDatabase> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    if (app) await app.close();
    if (fixture) {
      fixture.database.close();
      removeTemporaryDatabase(fixture.directory);
    }
  });

  it("creates, lists and retrieves events and rounds", async () => {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);
    const created = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { title: "API Event" },
    });
    expect(created.statusCode).toBe(201);
    const eventId = created.json().data.id;
    expect(
      (await app.inject({ method: "GET", url: "/api/events" })).json().data,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: `/api/events/${eventId}` }))
        .statusCode,
    ).toBe(200);
    const round = await app.inject({
      method: "POST",
      url: `/api/events/${eventId}/rounds`,
      payload: {
        name: "Round 1",
        roundType: "quick_questions",
        orderIndex: 0,
        configuration: {},
      },
    });
    expect(round.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/events/${eventId}/rounds`,
        })
      ).json().data,
    ).toHaveLength(1);
  });

  it("allows browser preflight for admin PUT requests from the local web app", async () => {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/admin/events/event-1/overlay/settings",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-methods"]).toContain("PUT");
    const allowedHeaders = response.headers["access-control-allow-headers"]?.toLowerCase();
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("content-type");
  });

  it("returns safe validation and missing-record responses", async () => {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: { title: "" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
    const missing = await app.inject({
      method: "GET",
      url: "/api/events/no-such-event",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("EVENT_NOT_FOUND");
    const health = await app.inject({
      method: "GET",
      url: "/api/health/database",
    });
    expect(health.json().data.database.connected).toBe(true);
    expect(health.json().data.migrations.applied).toBe(12);
  });

  it('returns the specific database constraint that caused a conflict', async () => {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);
    const event = (await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { title: 'Constraint Event' },
    })).json().data;
    const registration = {
      method: 'POST' as const,
      url: `/api/events/${event.id}/participants`,
      payload: { participantType: 'contestant', displayName: 'Ada' },
    };
    expect((await app.inject(registration)).statusCode).toBe(201);
    const duplicate = await app.inject(registration);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('UNIQUE constraint failed: event_participants'),
    });
  });

  it("supports event, round and question editing without exposing answer keys in lists", async () => {
    fixture = temporaryDatabase();
    app = buildTestApp(fixture.database);
    const event = (
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { title: "Editor Event" },
      })
    ).json().data;
    const editedEvent = await app.inject({
      method: "PUT",
      url: `/api/events/${event.id}`,
      payload: { title: "Edited Event" },
    });
    expect(editedEvent.statusCode).toBe(200);
    expect(editedEvent.json().data.title).toBe("Edited Event");
    const round = (
      await app.inject({
        method: "POST",
        url: `/api/events/${event.id}/rounds`,
        payload: {
          name: "Choices",
          roundType: "multiple_choice",
          orderIndex: 0,
          configuration: {},
        },
      })
    ).json().data;
    const editedRound = await app.inject({
      method: "PUT",
      url: `/api/events/${event.id}/rounds/${round.id}`,
      payload: { name: "Edited Choices" },
    });
    expect(editedRound.statusCode).toBe(200);
    expect(editedRound.json().data.name).toBe("Edited Choices");
    const created = await app.inject({
      method: "POST",
      url: `/api/admin/rounds/${round.id}/questions`,
      payload: {
        questionType: "multiple_choice",
        prompt: "One plus one?",
        durationMs: 10000,
        points: 5,
        penaltyPoints: 0,
        orderIndex: 0,
        choices: [
          { choiceText: "1", orderIndex: 0, isCorrect: false },
          { choiceText: "2", orderIndex: 1, isCorrect: true },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const questionId = created.json().data.id;
    const publicList = await app.inject({
      method: "GET",
      url: `/api/events/${event.id}/rounds/${round.id}/questions`,
    });
    expect(publicList.statusCode).toBe(200);
    expect(publicList.json().data[0]).not.toHaveProperty("correctValue");
    const adminQuestion = await app.inject({
      method: "GET",
      url: `/api/admin/questions/${questionId}`,
    });
    expect(adminQuestion.statusCode).toBe(200);
    expect(
      adminQuestion
        .json()
        .data.choices.find((choice: { isCorrect: boolean }) => choice.isCorrect)
        .choiceText,
    ).toBe("2");
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/admin/questions/${questionId}/duplicate`,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data.status).toBe("draft");
  });
});
