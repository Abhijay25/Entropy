import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface Config {
  api: { host: string; port: number };
  daytona: { apiKey?: string; apiUrl?: string; target?: string; snapshot?: string };
  neo4j: { uri?: string; username: string; password?: string; database: string };
  nosana: { baseUrl: string; apiKey?: string; model?: string };
  entropy: { sourceSha?: string; maxSandboxes: number };
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = optionalEnv(name);
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export const config: Config = {
  api: {
    host: optionalEnv('API_HOST') ?? '127.0.0.1',
    port: integerEnv('API_PORT', 3001, 1, 65_535)
  },
  daytona: {
    apiKey: optionalEnv('DAYTONA_API_KEY'),
    apiUrl: optionalEnv('DAYTONA_API_URL'),
    target: optionalEnv('DAYTONA_TARGET'),
    snapshot: optionalEnv('DAYTONA_SNAPSHOT')
  },
  neo4j: {
    uri: optionalEnv('NEO4J_URI'),
    username: optionalEnv('NEO4J_USERNAME') ?? 'neo4j',
    password: optionalEnv('NEO4J_PASSWORD'),
    database: optionalEnv('NEO4J_DATABASE') ?? 'neo4j'
  },
  nosana: {
    baseUrl: optionalEnv('NOSANA_BASE_URL') ?? 'https://inference.nosana.com/v1',
    apiKey: optionalEnv('NOSANA_API_KEY'),
    model: optionalEnv('NOSANA_MODEL')
  },
  entropy: {
    sourceSha: optionalEnv('ENTROPY_SOURCE_SHA'),
    maxSandboxes: integerEnv('ENTROPY_MAX_SANDBOXES', 2, 1, 2)
  }
};
