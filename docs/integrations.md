# Integration setup

Entropy uses Neo4j as the topology and evidence store, Nosana for bounded inference, Daytona SDK for measured trials, and Daytona MCP for a separate post-run diagnostic. These are required sponsor integrations for a live demo. Development fixtures may be used only with an explicit development label; they never silently replace an unavailable provider.

## Prerequisites and secrets

- Node.js 22 and npm workspaces.
- A Neo4j Aura or local Neo4j Community database.
- Daytona API access, a verified target/snapshot, and separately authenticated Daytona CLI access.
- A Nosana inference API key and an available model ID.

### Tested versions

Record the exact versions used for the live run in handoff notes.

#### Verified in Lane B workspace

| Component | Tested version |
| --- | --- |
| Node.js | 22.22.2 |
| TypeScript | 7.0.2 |
| `neo4j-driver` | 6.3.0 |
| `zod` | 4.6.7 |
| `@xyflow/react` | 12.12.0 |
| `vitest` | 4.1.12 |

#### Lane A / live provider targets

| Component | Version / verification |
| --- | --- |
| `@daytona/sdk` | 0.227.0 (types checked; live SDK calls not yet run) |
| `@modelcontextprotocol/client` | 2.4.0 (types checked; Daytona CLI not yet installed) |
| `esbuild` (payload bundler) | 0.28.2 |
| `tsx` | 4.23.15 |
| Neo4j image (`compose.yaml`) | `neo4j:5.26.16-community` (migration, persistence, and restart recovery verified locally) |
| Node.js used for local payload checks | 24.14.0 (sandbox runtime must be >= 22 and is recorded per trial) |

Lane A owns the operational scripts (`doctor`, `db:migrate`, `payload:check`, `prepare:payload`, and `cleanup`) and executes the live provider smoke gate against those targets.

Create a root `.env` locally. Do not commit it, pass it to browser code, put it in payload archives, prompts, artifacts, or terminal output. In particular, no sponsor secret may use a `VITE_*` variable.

```dotenv
API_HOST=127.0.0.1
API_PORT=3001
DAYTONA_API_KEY=
DAYTONA_API_URL=
DAYTONA_TARGET=
DAYTONA_SNAPSHOT=
NOSANA_BASE_URL=https://inference.nosana.com/v1
NOSANA_API_KEY=
NOSANA_MODEL=
NEO4J_URI=
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=
NEO4J_DATABASE=neo4j
ENTROPY_SOURCE_SHA=
ENTROPY_MAX_SANDBOXES=2
DAYTONA_CLI_PATH=daytona
ENTROPY_MODE=live
```

`ENTROPY_MODE=live` (default) requires every sponsor. `ENTROPY_MODE=development` allows explicitly labeled substitutes: the in-memory graph store when Neo4j is unset, local child-process trials when `DAYTONA_API_KEY` is unset (serialized, one slot), and the working-tree payload when `ENTROPY_SOURCE_SHA` is unset. Every such run carries development warnings and is excluded from live acceptance.

Load this root file explicitly from backend/scripts. `ENTROPY_MAX_SANDBOXES` is at most two. The live demo needs quota for two simultaneous small sandboxes; a one-slot development run is allowed only when clearly labeled as serialized.

## First-time integration gate

Run these checks before a live experiment:

```sh
npm ci
npm run doctor
npm run db:migrate
npm run payload:check
```

`doctor` must exit nonzero when a required integration is inaccessible and must report only redacted status and last-checked time. Record the tested SDK, CLI, Node runtime, snapshot identity, account region, and chosen Nosana model in the deployment/handoff notes; availability and model IDs are account-dependent.

Expected smoke checks:

| Integration | Required smoke check |
| --- | --- |
| Neo4j | Connect, run `RETURN 1`, and run idempotent schema setup. |
| Nosana | `GET /models`, choose and save an available model ID, then make one short plain-JSON completion. |
| Daytona SDK | Create a small sandbox, run `node --version`, upload/download a file, confirm quota for two sandboxes, and delete in `finally`. |
| Daytona MCP | Authenticate the CLI separately, run `daytona mcp start` over stdio, list tools (including pagination where applicable), read a smoke file with the discovered file-read tool, then clean up. |

SDK credentials do not prove Daytona CLI authentication. Store discovered MCP tool names and validated argument shapes only in ignored `.entropy/mcp-tools.json` and sanitized notes.

## Neo4j

### Local Docker setup

Aura users can skip this section. For a local database, first set `NEO4J_URI=bolt://127.0.0.1:7687`, `NEO4J_USERNAME=neo4j`, and `NEO4J_PASSWORD` in `.env`. The project `compose.yaml` pins `neo4j:5.26.16-community`, binds only to loopback, uses the `entropy-neo4j` named volume, and reads those credentials from `.env`:

```sh
docker compose up -d --wait
```

Then run `npm run db:migrate` and verify `RETURN 1` in Neo4j Browser. Use the project `compose.yaml` instead of adding a second database definition.

### Migration and persistence rules

Run `npm run db:migrate` before starting the backend. Migrations use `IF NOT EXISTS` and ordinary uniqueness constraints compatible with Community and Aura. Use a project namespace and parameterized Cypher; never interpolate user or model text.

The graph includes `Service`, `Datastore`, `EntropyRun`, `EntropyTrial`, `EntropyMetric`, `EntropyHypothesis`, `EntropyAnalysis`, `EntropyDiagnostic`, and `EntropyOperation`. Service/datastore keys are unique; other entity IDs and operation IDs are unique. Template keys use `entropy:template:<topologyHash>:<serviceId>` and run-scoped keys use `entropy:<runId>:<serviceId>`.

Each run copies the six-node topology. This prevents later runs from changing historical states. Structured nested values are stored as canonical JSON strings where Neo4j properties cannot represent them. Convert driver integer and temporal values to ordinary JSON at the boundary.

The migration owns the exact label set, but its idempotent constraints follow this shape:

```cypher
CREATE CONSTRAINT entropy_service_key IF NOT EXISTS
FOR (node:Service) REQUIRE node.key IS UNIQUE;
CREATE CONSTRAINT entropy_datastore_key IF NOT EXISTS
FOR (node:Datastore) REQUIRE node.key IS UNIQUE;
CREATE CONSTRAINT entropy_run_id IF NOT EXISTS
FOR (node:EntropyRun) REQUIRE node.id IS UNIQUE;
CREATE CONSTRAINT entropy_trial_id IF NOT EXISTS
FOR (node:EntropyTrial) REQUIRE node.id IS UNIQUE;
CREATE CONSTRAINT entropy_metric_id IF NOT EXISTS
FOR (node:EntropyMetric) REQUIRE node.id IS UNIQUE;
CREATE CONSTRAINT entropy_hypothesis_id IF NOT EXISTS
FOR (node:EntropyHypothesis) REQUIRE node.id IS UNIQUE;
CREATE CONSTRAINT entropy_analysis_id IF NOT EXISTS
FOR (node:EntropyAnalysis) REQUIRE node.id IS UNIQUE;
CREATE CONSTRAINT entropy_diagnostic_id IF NOT EXISTS
FOR (node:EntropyDiagnostic) REQUIRE node.id IS UNIQUE;
CREATE CONSTRAINT entropy_operation_id IF NOT EXISTS
FOR (node:EntropyOperation) REQUIRE node.id IS UNIQUE;
```

Configured relationships point caller to dependency. An observed `CASCADED_TO` overlay points degraded dependency to affected caller and carries `trialId` and supporting span IDs. A prediction remains a hypothesis record; it never changes measured node health.

```cypher
// Fixed, parameterized risk retrieval. Never execute model-generated Cypher.
MATCH p=(s:Service)-[:CALLS|READS|VERIFY_TOKEN*1..5]->(r:Datastore)
WHERE r.key = $redisKey
  AND all(n IN nodes(p) WHERE n.projectId = $projectId AND n.scope = $scope)
RETURN [n IN nodes(p) | n.id] AS path,
       [e IN relationships(p) | {type: type(e), timeoutMs: e.timeoutMs}] AS edges
ORDER BY size(path) DESC
LIMIT 10;
```

The backend records this fixed query and parameters in the hypothesis inspector. It retrieves context only; it does not prove a single point of failure.

A comparison must explicitly select the run and control/chaos trial IDs. Query metrics and observed overlays separately so optional overlays do not multiply metric rows:

```cypher
MATCH (run:EntropyRun {id: $runId})-[:HAS_TRIAL]->(control:EntropyTrial {id: $controlTrialId})
MATCH (run)-[:HAS_TRIAL]->(chaos:EntropyTrial {id: $chaosTrialId})
MATCH (control)-[:HAS_METRIC]->(controlMetric:EntropyMetric)-[:OF_SERVICE]->(service)
MATCH (chaos)-[:HAS_METRIC]->(chaosMetric:EntropyMetric)-[:OF_SERVICE]->(service)
WHERE chaosMetric.channel = controlMetric.channel
RETURN service.id, controlMetric, chaosMetric;
```

```cypher
MATCH (dependency)-[cascade:CASCADED_TO {trialId: $chaosTrialId}]->(affected)
RETURN dependency.id, affected.id, cascade.supportingSpanIds;
```

`saveTrial` commits trial state, metrics, artifact metadata, and source/workload hashes atomically. Deterministic metric IDs are `<trialId>:<serviceId>:<channel>` and writes use idempotent `MERGE`. Keep sessions short-lived and closed. Managed transaction callbacks may retry, so provider calls, file writes, and random ID allocation occur outside them.

## Nosana

Use native `fetch` with `Authorization: Bearer $NOSANA_API_KEY` against `$NOSANA_BASE_URL/chat/completions`. Pin a model discovered from `GET /models`. v1 uses ordinary non-streaming JSON content; it does not rely on tool calling, streaming, or provider schema modes.

```http
POST /v1/chat/completions
Authorization: Bearer <redacted>
Content-Type: application/json

{
  "model": "<pinned model id>",
  "messages": [{ "role": "user", "content": "<bounded JSON-only prompt>" }],
  "max_tokens": 700,
  "stream": false
}
```

Record model, request timestamp, latency, prompt version, and returned usage when available. Never retain or display provider private reasoning fields, including `reasoning_content` and `<think>` content.

### JSON contract and fallback behavior

The hypothesis prompt contains retrieved Neo4j paths, known deadlines, Payment gate configuration, the fixed traffic schedule, allowed service IDs, and only this executable intervention:

```json
{
  "targetServiceId": "redis-cache",
  "faultType": "LATENCY_SPIKE",
  "faultParams": { "delayMs": 3000, "durationSec": 10 }
}
```

The model may supply only `title`, `question`, `targetServiceId`, `faultType`, `faultParams`, `predictedBlastRadiusIds`, and `rationale`. Validate a strict object: reject unknown fields, unknown/non-graph service IDs, any alternate fault value, and an invalid rationale. The backend - not the model - adds the generated hypothesis ID, source, model, and the fixed server Cypher query. A prediction is not an observation.

Analysis prompts contain valid control/chaos summaries, backend-calculated affected IDs, queue counters, fault witnesses, and selected spans. Cap input near 12 KiB, prioritizing changed metrics, counters, witnesses, then supporting spans. Each returned hypothesis must cite at least one supplied metric ID; validate every hypothesis/remediation metric or span ID against supplied measurements. Prose cannot replace backend counts, percentiles, or statuses.

Parse the complete response as JSON after removing at most one enclosing Markdown fence. One repair completion is allowed for invalid JSON/schema output. Each request has a 30-second timeout, bounded output tokens, and at most one transient network/5xx retry.

- An unconfigured, unreachable, or invalid hypothesis response returns the explicitly labeled `catalogue_fallback` Redis-delay hypothesis (`catalogue_fallback` does not satisfy live acceptance).
- An unavailable or invalid analysis returns `status: "unavailable"`, `source: "deterministic"`, and preserves measured facts.
- Invalid model output is never executable. No v1 remediation applies a patch or promises self-healing.

## Daytona SDK and MCP

Only the Daytona adapter creates, uploads to, executes in, downloads from, destroys, and reconciles sandboxes. Use installed stable `@daytona/sdk` method signatures, explicit timeouts, and labels for project, run, trial/purpose, and creation time. All trial sandboxes use the same immutable payload hash, source revision, workload hash, and verified runtime.

A run creates a fresh healthy baseline first, then fresh matched healthy-control and Redis-chaos sandboxes in parallel after baseline success. Keep at most two live reservations, collect bounded evidence before `finally` deletion, and persist sandbox IDs immediately. Reconcile an ambiguous create timeout by labels before retrying. Cleanup status remains distinct from measurement outcome.

The MCP diagnostic is separate from trial measurement:

1. Confirm the original run has terminal measured evidence and reserve one diagnostic slot.
2. Create a separate sandbox with the immutable payload/runtime and upload sanitized `.entropy-diagnostic/evidence.json`.
3. Ask Nosana for one restricted action: `read_evidence`, optional `probe_auth`, or `finish` with verified evidence IDs.
4. Map actions to discovered tool names and fixed local templates only. The model never selects a command, path, URL, credential, sandbox ID, or arbitrary tool.
5. Save the actual tool trace and delete the sandbox in `finally`.

Use at most two MCP calls, three model turns including final explanation, and three minutes. Treat tool output as untrusted data. Handle thrown `callTool` errors and `isError` results. Record tool name, action, timing, success/error, bounded redacted output, sandbox ID, and cleanup result. A no-tool final explanation is labeled no-tool evidence and does not meet live acceptance.

## Payload, execution, and recovery (lane A)

- `npm run payload:check` bundles the working tree and runs a real local healthy control and Redis-chaos trial, then checks the section 16.C local gates (healthy gates, business fault witness, checkout error fraction +0.20, Payment queue/reject or 500 ms saturation, unknown token fails closed under both modes). It is a development check and never recorded evidence.
- `npm run prepare:payload -- <full sha>` builds a recorded payload from `git archive` of that commit only, verifies the archived lockfile pins the installed esbuild, and writes `.entropy/payload/<sha>/manifest.json` (archive, lockfile, bundle, topology, and workload hashes). Set `ENTROPY_SOURCE_SHA` to the same SHA. The payload sources must be committed first.
- `npm run prepare:payload -- --development` writes `.entropy/payload/development`, labeled `development: true`, for local work before a commit exists.
- Every sandbox receives the same four bundled files plus a schema-validated `input.json` under `/tmp/entropy`. Commands are fixed templates (`node --version`, `node payload/runTrial.cjs --input input.json --output-dir out`). The backend re-checks the in-sandbox bundle hash and observed `node --version` against the report before import, and overrides provider-owned fields (`executionMode`, `sandboxId`, `cleanupStatus`, `artifacts`, `runtimeIdentity`).
- Artifacts are size-checked before download, redacted, hashed, and stored under `.entropy/artifacts/<run>/<trial>/` with an `artifacts.json` index. `GET /api/artifacts/:id` serves only indexed files.
- Trial records are written to `.entropy/recovery/` before each Neo4j write and removed after it succeeds; a failed write halts new scheduling (503) and is replayed idempotently on restart.
- On startup the backend marks unfinished runs and trials `INTERRUPTED` (never resumed), deletes their recorded sandboxes, sweeps Entropy-labeled sandboxes belonging to known runs, and keeps capacity reserved for any sandbox it fails to delete.
- `npm run doctor` writes redacted results to `.entropy/doctor.json` (read by `GET /api/integrations`) and the discovered MCP mapping to `.entropy/mcp-tools.json`. The MCP mapping is derived from `listTools` schemas (a file-read tool and its sandbox/path arguments); the diagnostic refuses to run without it.
- The optional `probe_auth` diagnostic action is not enabled in this build; the model may request it, but it is recorded as not executed.

## Script ownership, health, and cleanup checks

Lane A owns root tooling and operational scripts: `doctor`, `payload:check`, `prepare:payload`, `cleanup`, backend startup, Daytona SDK/MCP smoke, and lifecycle cleanup. Lane B owns the Neo4j migration/provider hooks and the Nosana/graph checks invoked by those scripts. Lane A remains the lockfile owner; Lane B requests dependency changes rather than rewriting manifests.

Before handoff, run the focused checks and one complete live sequence:

```sh
npm run typecheck
npm test
npm run build
npm run prepare:payload -- FULL_SHA
npm run cleanup
```

Verify a healthy baseline, overlapping control/chaos execution, witnessed Redis business delay, persisted graph evidence, an evidence-grounded Nosana response, one reproduction pair, and a real MCP evidence-read trace. Confirm all Entropy-labeled sandboxes are deleted or a visible cleanup failure is recorded. Do not repeatedly start paid provider runs without a changed concern or failed check.
