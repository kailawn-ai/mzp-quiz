import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp, removeTemporaryDatabase, temporaryDatabase } from './test-utils.js';

const fixture = temporaryDatabase();
const app = buildTestApp(fixture.database);

describe('health endpoint', () => {
  it('reports that the server is available', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('mzp-quiz-server');
  });
});

afterAll(async () => { await app.close(); fixture.database.close(); removeTemporaryDatabase(fixture.directory); });
