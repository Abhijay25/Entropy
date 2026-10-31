import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  constructed: [] as unknown[],
  deleteCalls: [] as unknown[][],
  sandbox: { id: 'sbx-1', labels: { project: 'entropy' }, target: 'eu', fs: { createFolder: async () => undefined } }
}));

vi.mock('@daytona/sdk', () => {
  class DaytonaNotFoundError extends Error {}
  class DaytonaTimeoutError extends Error {}
  class Daytona {
    constructor(config: unknown) { sdk.constructed.push(config); }
    async create() { return sdk.sandbox; }
    async get() { return sdk.sandbox; }
    async delete(...args: unknown[]) { sdk.deleteCalls.push(args); }
  }
  return { Daytona, DaytonaNotFoundError, DaytonaTimeoutError };
});

import { DaytonaProvider, DEFAULT_DAYTONA_API_URL } from './daytonaRunner.js';

beforeEach(() => { sdk.constructed.length = 0; sdk.deleteCalls.length = 0; });

describe('DaytonaProvider', () => {
  it('always passes an explicit endpoint so the SDK never has to guess', () => {
    new DaytonaProvider({ apiKey: 'key', target: 'eu' });
    expect(sdk.constructed[0]).toMatchObject({ apiUrl: DEFAULT_DAYTONA_API_URL, target: 'eu' });
  });

  it('waits for the sandbox to be destroyed before reporting deletion', async () => {
    const provider = new DaytonaProvider({ apiKey: 'key' });
    await provider.destroy('sbx-1', 30);
    expect(sdk.deleteCalls).toEqual([[sdk.sandbox, 30, true]]);
  });
});
