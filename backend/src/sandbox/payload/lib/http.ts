import http from 'node:http';

import { BODY_LIMIT_BYTES, LOOPBACK } from './constants.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class HttpInputError extends Error {
  constructor(readonly statusCode: 400 | 413, readonly code: 'INVALID_INPUT' | 'PAYLOAD_TOO_LARGE') {
    super(code);
  }
}

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

export function readJsonBody(request: http.IncomingMessage, limit = BODY_LIMIT_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit && !rejected) {
        rejected = true;
        reject(new HttpInputError(413, 'PAYLOAD_TOO_LARGE'));
      }
      if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new HttpInputError(400, 'INVALID_INPUT'));
      }
    });
    request.on('error', () => { if (!rejected) { rejected = true; reject(new HttpInputError(400, 'INVALID_INPUT')); } });
  });
}

/** Writes JSON unless the caller already disconnected (e.g. after its own deadline). */
export function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const payload = JSON.stringify(body);
  try {
    response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    response.end(payload);
  } catch {
    // Socket closed between the check and the write; the span still records the outcome.
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export type CallOutcome =
  | { kind: 'response'; statusCode: number; body: unknown; elapsedMs: number }
  | { kind: 'timeout'; elapsedMs: number }
  | { kind: 'error'; elapsedMs: number; message: string };

/**
 * Loopback JSON call with a hard deadline. On deadline the socket is destroyed; the
 * callee's handler is intentionally NOT cancelled (modeled fragility, see plan section 4).
 */
export function callJson(options: { port: number; method: 'GET' | 'POST'; path: string; body?: unknown; headers?: Record<string, string>; deadlineMs: number }): Promise<CallOutcome> {
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: CallOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = http.request({
      host: LOOPBACK, port: options.port, method: options.method, path: options.path, agent: keepAliveAgent,
      headers: { accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...options.headers }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        let body: unknown = null;
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : null; } catch { body = null; }
        finish({ kind: 'response', statusCode: response.statusCode ?? 0, body, elapsedMs: elapsed() });
      });
      response.on('error', (error) => finish({ kind: 'error', elapsedMs: elapsed(), message: error.message }));
    });
    const timer = setTimeout(() => {
      finish({ kind: 'timeout', elapsedMs: elapsed() });
      request.destroy();
    }, options.deadlineMs);
    request.on('error', (error) => finish({ kind: 'error', elapsedMs: elapsed(), message: error.message }));
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

export function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => { server.off('error', reject); resolve(); });
  });
}

export function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
