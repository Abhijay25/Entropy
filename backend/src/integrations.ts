import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { IntegrationsStatusSchema, type IntegrationsStatus } from '../../shared/types.js';
import { ENTROPY_DIR } from './sandbox/payloadManifest.js';

/** Written by `npm run doctor`; read by GET /api/integrations. Contains no secrets. */
export const DOCTOR_REPORT = path.join(ENTROPY_DIR, 'doctor.json');

const UNCHECKED: IntegrationsStatus = {
  daytona: { available: false, message: 'Not checked yet; run npm run doctor.' },
  nosana: { available: false, message: 'Not checked yet; run npm run doctor.' },
  neo4j: { available: false, message: 'Not checked yet; run npm run doctor.' },
  mcp: { available: false, message: 'Not checked yet; run npm run doctor.' }
};

export function readIntegrations(): IntegrationsStatus {
  if (!existsSync(DOCTOR_REPORT)) return UNCHECKED;
  const parsed = IntegrationsStatusSchema.safeParse((JSON.parse(readFileSync(DOCTOR_REPORT, 'utf8')) as { integrations?: unknown }).integrations);
  return parsed.success ? parsed.data : UNCHECKED;
}

export function writeIntegrations(integrations: IntegrationsStatus, details: Record<string, unknown>): void {
  mkdirSync(ENTROPY_DIR, { recursive: true });
  writeFileSync(DOCTOR_REPORT, `${JSON.stringify({ integrations: IntegrationsStatusSchema.parse(integrations), details }, null, 2)}\n`);
}
