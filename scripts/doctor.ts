// npm run doctor — real smoke checks for Daytona SDK, Nosana, Neo4j, and Daytona MCP.
// Prints redacted per-provider state, writes .entropy/doctor.json, exits nonzero if any is missing.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { IntegrationsStatus } from '../shared/types.js';
import { config } from '../backend/src/config.js';
import { Neo4jGraphRepository } from '../backend/src/graph/neo4jClient.js';
import { writeIntegrations } from '../backend/src/integrations.js';
import { DaytonaProvider } from '../backend/src/sandbox/daytonaRunner.js';
import { DaytonaMcpClient, deriveMapping, saveMapping } from '../backend/src/sandbox/mcpClient.js';
import { REMOTE_WORKDIR, SANDBOX_OWNER, type SandboxHandle } from '../backend/src/sandbox/provider.js';

type Check = { available: boolean; checkedAt: string; message: string; model?: string };
const now = () => new Date().toISOString();
const details: Record<string, unknown> = {};
const smokeRunId = `doctor-${Date.now()}`;
const SMOKE_FILE = 'smoke/entropy-smoke.txt';
const SMOKE_CONTENT = `entropy doctor smoke ${smokeRunId}\n`;

function fail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]').slice(0, 400);
}

function packageVersion(name: string): string {
  try { return (JSON.parse(readFileSync(path.resolve(__dirname, '..', 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version; } catch { return 'unknown'; }
}

async function checkDaytona(provider: DaytonaProvider, onReady: (sandboxId: string) => Promise<Check>): Promise<{ daytona: Check; mcp: Check }> {
  const created: SandboxHandle[] = [];
  let mcp: Check = { available: false, checkedAt: now(), message: 'Not reached: Daytona SDK smoke did not complete.' };
  try {
    // Two concurrent small sandboxes: proves the quota supports the parallel matched pair.
    const results = await Promise.allSettled([1, 2].map((index) => provider.create({ project: 'entropy', owner: SANDBOX_OWNER, runId: smokeRunId, trialId: `${smokeRunId}-${index}`, purpose: 'smoke', createdAt: now() }, 60)));
    for (const result of results) if (result.status === 'fulfilled') created.push(result.value);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw new Error(`Could not hold two simultaneous sandboxes: ${fail(rejected.reason)}`);
    const sandbox = created[0]!;
    const version = await provider.execute(sandbox.id, 'node-version', 30);
    if (version.exitCode !== 0) throw new Error('node --version failed in the sandbox.');
    await provider.upload(sandbox.id, [{ remotePath: SMOKE_FILE, bytes: Buffer.from(SMOKE_CONTENT) }], 30);
    const roundTrip = (await provider.download(sandbox.id, SMOKE_FILE, 30)).toString('utf8');
    if (roundTrip !== SMOKE_CONTENT) throw new Error('Uploaded and downloaded smoke file contents differ.');
    details.daytona = { sdk: `@daytona/sdk@${packageVersion('@daytona/sdk')}`, apiUrl: provider.apiUrl, target: config.daytona.target ?? 'account default', node: version.output.trim(), snapshot: config.daytona.snapshot ?? 'default', region: sandbox.region ?? 'unknown', concurrentSandboxes: created.length };
    mcp = await onReady(sandbox.id);
    return { daytona: { available: true, checkedAt: now(), message: `SDK ok: 2 concurrent sandboxes, node ${version.output.trim()}, file round-trip ok, region ${sandbox.region ?? 'unknown'}.` }, mcp };
  } catch (error) {
    return { daytona: { available: false, checkedAt: now(), message: fail(error) }, mcp };
  } finally {
    const cleanup: Record<string, string> = {};
    for (const handle of created) {
      try { await provider.destroy(handle.id, 30); cleanup[handle.id] = 'DELETED'; } catch (error) { cleanup[handle.id] = `FAILED: ${fail(error)}`; }
    }
    details.daytonaCleanup = cleanup;
  }
}

async function checkMcp(sandboxId: string): Promise<Check> {
  let client: DaytonaMcpClient | undefined;
  try {
    client = await DaytonaMcpClient.connect();
    const tools = await client.listAllTools();
    const mapping = deriveMapping(tools);
    saveMapping(mapping);
    const read = await client.call(mapping.readFile, sandboxId, `${REMOTE_WORKDIR}/${SMOKE_FILE}`);
    details.mcp = { tools: mapping.toolNames, readFile: mapping.readFile, execute: mapping.execute ?? null, smokeReadOk: read.ok };
    if (!read.ok || !read.text.includes(smokeRunId)) throw new Error(`MCP ${mapping.readFile.tool} did not return the smoke file: ${read.text.slice(0, 200)}`);
    return { available: true, checkedAt: now(), message: `MCP ok: ${tools.length} tools; ${mapping.readFile.tool} read the smoke file.` };
  } catch (error) {
    return { available: false, checkedAt: now(), message: `${fail(error)}${client ? '' : ` (is the Daytona CLI installed as "${config.daytonaCli.path}" and logged in with "daytona login"?)`}` };
  } finally {
    await client?.close();
  }
}

async function checkNosana(): Promise<Check> {
  if (!config.nosana.apiKey) return { available: false, checkedAt: now(), message: 'NOSANA_API_KEY is not set.' };
  const headers = { authorization: `Bearer ${config.nosana.apiKey}`, 'content-type': 'application/json' };
  const base = config.nosana.baseUrl.replace(/\/+$/, '');
  try {
    const listed = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!listed.ok) throw new Error(`GET /models returned HTTP ${listed.status}.`);
    const models = ((await listed.json()) as { data?: Array<{ id?: string }> }).data?.map((model) => model.id).filter((id): id is string => Boolean(id)) ?? [];
    if (!models.length) throw new Error('GET /models returned no models.');
    const model = config.nosana.model && models.includes(config.nosana.model) ? config.nosana.model : models[0]!;
    const started = Date.now();
    const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ model, max_tokens: 60, temperature: 0, messages: [{ role: 'user', content: 'Reply with only this JSON and nothing else: {"ok": true}' }] }) });
    if (!response.ok) throw new Error(`POST /chat/completions returned HTTP ${response.status}.`);
    const content = ((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '';
    const unfenced = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    const parsedOk = (() => { try { return (JSON.parse(unfenced) as { ok?: unknown }).ok === true; } catch { return false; } })();
    details.nosana = { baseUrl: base, models: models.slice(0, 20), selectedModel: model, configuredModel: config.nosana.model ?? null, latencyMs: Date.now() - started, plainJsonOk: parsedOk };
    const note = config.nosana.model && config.nosana.model !== model ? ` (configured NOSANA_MODEL "${config.nosana.model}" is not listed)` : config.nosana.model ? '' : ' (set NOSANA_MODEL to pin it)';
    return { available: parsedOk, checkedAt: now(), model, message: parsedOk ? `Inference ok with ${model}${note}.` : `Model ${model} answered but not with plain JSON: ${content.slice(0, 120)}` };
  } catch (error) {
    return { available: false, checkedAt: now(), message: fail(error) };
  }
}

async function checkNeo4j(): Promise<Check> {
  const { uri, username, password, database } = config.neo4j;
  if (!uri || !password) return { available: false, checkedAt: now(), message: 'NEO4J_URI and NEO4J_PASSWORD are required.' };
  const repository = new Neo4jGraphRepository({ uri, username, password, database });
  try {
    await repository.verifyConnectivity();
    await repository.ensureSchema();
    const graph = await repository.seedTopology();
    details.neo4j = { uri: uri.replace(/\/\/[^@]*@/, '//'), database, templateNodes: graph.nodes.length, templateEdges: graph.edges.length };
    return { available: graph.nodes.length === 6, checkedAt: now(), message: `Connected; schema ensured; template topology has ${graph.nodes.length} nodes and ${graph.edges.length} edges.` };
  } catch (error) {
    return { available: false, checkedAt: now(), message: fail(error) };
  } finally {
    await repository.close();
  }
}

async function main(): Promise<void> {
  const [neo4j, nosana, sandbox] = await Promise.all([
    checkNeo4j(),
    checkNosana(),
    config.daytona.apiKey
      ? checkDaytona(DaytonaProvider.fromConfig(), checkMcp)
      : Promise.resolve({ daytona: { available: false, checkedAt: now(), message: 'DAYTONA_API_KEY is not set.' }, mcp: { available: false, checkedAt: now(), message: 'Requires a Daytona sandbox; DAYTONA_API_KEY is not set.' } })
  ]);
  const integrations: IntegrationsStatus = { daytona: sandbox.daytona, nosana, neo4j, mcp: sandbox.mcp };
  writeIntegrations(integrations, details);
  for (const [name, check] of Object.entries(integrations)) console.log(`${check.available ? 'OK     ' : 'MISSING'} ${name.padEnd(8)} ${check.message}`);
  if (details.daytonaCleanup) console.log(`cleanup  ${JSON.stringify(details.daytonaCleanup)}`);
  const missing = Object.entries(integrations).filter(([, check]) => !check.available).map(([name]) => name);
  if (missing.length) console.log(`\nRequired access missing: ${missing.join(', ')}.`);
  process.exit(missing.length ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(fail(error));
  process.exit(1);
});
