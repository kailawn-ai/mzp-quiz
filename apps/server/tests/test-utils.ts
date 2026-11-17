import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type DatabaseHandle } from '../src/database/database.js';
import { buildApp } from '../src/app.js';

export const testAdminToken = 'test-admin-token-0123456789';

export function buildTestApp(database: DatabaseHandle) {
  const app = buildApp({ database, adminToken: testAdminToken });
  app.addHook('onRequest', async (request) => {
    if (!request.headers.authorization) {
      request.headers.authorization = ['Bearer ', testAdminToken].join('');
    }
  });
  return app;
}

export function temporaryDatabase(): { directory: string; database: DatabaseHandle } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mzp-quiz-test-'));
  return { directory, database: createDatabase({ dataDir: directory }) };
}

export function removeTemporaryDatabase(directory: string) {
  fs.rmSync(directory, { recursive: true, force: true });
}
