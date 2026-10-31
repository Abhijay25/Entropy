# Entropy — cascade-demo MVP implementation plan

Date: 2026-10-31. Timebox: two people directing coding agents, 4–5 hours. Status: specification only; implementation is not yet present.

Sections 4–11 define the design; section 16 fixes the payload wire formats, measurement gates, and acceptance rules. Coding agents should read both before implementing shared interfaces. Provider authentication, account quotas, and installed SDK/MCP schemas are explicit startup checks rather than assumed facts.

## 0. Product decision and scope

The product owner selected the cascade demo in the pulled root `.spec` as v1, with technical claims corrected and automatic patch application deferred. This document supersedes the earlier repository-QA plan. Read `spec/README.md` for document precedence.

**Build a graph-grounded chaos agent that predicts how a dependency fault might spread, measures the actual cascade in Daytona, and explains the evidence using Nosana.**

The demonstration loop is:

> Map dependencies → retrieve a risky path from Neo4j → generate a Nosana hypothesis → run a healthy baseline → execute matched healthy/control and fault trials in parallel Daytona sandboxes → compare measured service behavior → show the actual affected subgraph → investigate evidence through Daytona MCP.

Decisions already made:

- TypeScript across shared contracts, backend, payload, and React dashboard. Language familiarity is secondary to integration speed and presentation quality.
- Nosana supplies GPU-hosted inference. The backend orchestrates Daytona; the whole product is not hosted on Nosana.
- Neo4j is the real topology, run, and evidence store. Graph retrieval supplies the model's context; embeddings/vector infrastructure are unnecessary for this small known graph.
- Daytona SDK owns deterministic measurement execution. Daytona MCP supplies a bounded post-run investigation in a separate diagnostic sandbox.
- Support one real Git revision of this repository's miniature service-mesh payload. Universal repository onboarding is outside v1.
- Use the original brief's `backend/`, `frontend/`, and `shared/` layout and Express/SSE interfaces, with the concrete contracts below.
- Automatic code generation/application and self-healing are deferred. The UI may show a proposed remediation with evidence and limitations; no invented patch-success result.
- All sponsor access is unverified until the initial smoke checks pass.

### Corrections to the original brief

| Original idea | Implementation rule |
| --- | --- |
| `@daytonaio/sdk` | Use the documented `@daytona/sdk`; verify installed stable types. |
| One sandbox mutated through baseline, fault, and fix | Fresh baseline, control, and fault sandboxes from the same immutable payload. Parallel control/fault trials demonstrate isolation and concurrency. |
| Worker pool saturates because Node waits on HTTP | Implement an explicit bounded concurrency gate and bounded queue; record active slots, queue length, and rejection counts. |
| Six real infrastructure services | Six logical HTTP services in a controlled mock mesh; Redis/Postgres are HTTP stand-ins, labeled as mocks. |
| Packet loss/process kills | v1 injects a real delay at the mock Redis request boundary. Privileged networking and per-process kill support are deferred. |
| Exactly five red nodes | Calculate affected nodes from actual measurements. Expected topology guides a hypothesis, not hardcoded health. |
| Timeout/circuit breaker guarantees zero failed checkouts | Authentication failure remains fail-closed. A timeout can bound waiting; it does not authorize an unsafe checkout or guarantee availability. |
| Automatic fallback to local/in-memory/deterministic providers | Explicit development modes and unavailable states only. All three sponsor integrations must work for the final live demo. |
| Automatic patch proves blast-radius reduction | Deferred; no success claim without a separately executed, comparable verification trial. |

### Required deliverable

- [ ] Six-node configured topology comes from Neo4j and renders in the dashboard.
- [ ] A real Nosana response proposes the bounded Redis-latency hypothesis using retrieved graph context.
- [ ] A healthy baseline and two matched trials execute in real fresh Daytona sandboxes; control and chaos overlap when account quota permits two slots.
- [ ] The same payload hash, source revision, Node runtime, traffic schedule, and inputs are used across trials.
- [ ] Measured request counts, error rates, latency samples, and concurrency-gate telemetry drive the graph.
- [ ] Evidence shows that the Redis delay was exercised and upstream requests experienced the measured impact.
- [ ] Prediction and observation remain distinct; unaffected/unsampled nodes are not painted red automatically.
- [ ] Real Nosana analysis links to actual telemetry/span IDs.
- [ ] A real Daytona MCP evidence-read tool is used by a bounded diagnostic agent and shown in a saved trace.
- [ ] UI/Neo4j retain results after browser refresh and backend restart; all sandboxes are deleted or cleanup failure is visible.
- [ ] One independent re-run can reproduce the observed fault without replacing original evidence.
- [ ] Build/type checks and the live acceptance sequence pass.

## 1. User journey and demo story

One mission-control dashboard is sufficient:

1. Open Entropy and see the six-node dependency graph, source revision, and real sponsor connection statuses.
2. Click **Generate hypothesis** or **Run cascade experiment**. The run retrieves graph context and generates its bounded hypothesis before execution.
3. Show the path Redis → Auth → Payment → Order → Frontend as a prediction, with source Cypher visible on demand.
4. Show the healthy baseline finishing, then control and chaos trials provisioning/running in parallel.
5. Display measured changes: checkout error fraction, p95 including failures, service states, and Payment queue saturation if observed.
6. Highlight the affected graph from observed data and select a node to inspect counts, traces, and latency samples.
7. Show Nosana's explanation, distinguishing measured facts from hypotheses and remediation proposals.
8. **Reproduce** creates a new matched control/fault pair. **Investigate** opens a separate diagnostic session with actual Daytona MCP tool trace.
9. Keep sandbox IDs, cleanup state, sample counts, and live/recorded provenance accessible.

The pitch is “We predicted this dependency path might amplify a delay. Here is what actually happened under the same controlled load, compared with the healthy control. These request traces and queue measurements explain the observed impact.” Do not promise exact affected-node counts or a fixed p99 improvement before measurement.

## 2. Architecture and repository layout

| Concern | Fixed choice |
| --- | --- |
| Product runtime | Node.js 22; lock/record exact deployed runtime and npm versions |
| Workspace | npm workspaces: `backend`, `frontend`, `shared`; one product lockfile |
| Backend | Express + TypeScript + `tsx`; one long-lived local process |
| Frontend | React + Vite + TypeScript; plain CSS; `@xyflow/react` with deterministic layout |
| Contracts | Zod schemas and inferred types in `shared/types.ts` |
| Persistence | Official `neo4j-driver`, Aura or local Neo4j Community |
| Inference | Native `fetch` to Nosana's inference API; validated JSON text responses |
| Sandbox | Official stable `@daytona/sdk`, isolated behind one adapter |
| MCP | Official stable `@modelcontextprotocol/client`; stdio connection to `daytona mcp start` |
| Events | Express Server-Sent Events plus ordinary snapshot GET routes |
| Payload | TypeScript compiled/bundled to dependency-free Node JavaScript; built-in HTTP/fetch primitives |
| Tests | Vitest for contract, metrics, scheduler boundaries; live provider smoke separately |
| Artifacts | Bounded local files under ignored `.entropy/`; metadata/evidence in Neo4j |

```text
Entropy/
  AGENTS.md
  .spec                           # preserved original brief
  spec/
    README.md                     # document index/precedence
    plan.md                       # this active specification
    archive/qa-plan.md             # superseded, not executable guidance
  package.json
  package-lock.json
  tsconfig.base.json
  .env.example
  .gitignore
  compose.yaml
  shared/
    package.json
    types.ts
  backend/
    package.json
    src/
      index.ts                    # Express + SSE — lane A
      config.ts                   # validated environment — lane A
      agent/
        orchestrator.ts           # state machine — lane A
        nosanaClient.ts           # inference + schemas — lane B
        diagnosticAgent.ts        # bounded action loop — lane A
      graph/
        neo4jClient.ts            # graph/results repository — lane B
      sandbox/
        daytonaRunner.ts          # SDK adapter + trial runner — lane A
        mcpClient.ts              # discovered tool mapping — lane A
        payload/
          cluster.ts              # six logical HTTP services — lane A
          faultCtl.ts             # trusted controller — lane A
          trafficGen.ts           # load + sample aggregation — lane A
          runTrial.ts             # process lifecycle/artifacts — lane A
      evidence/
        collect.ts                # bounded files/redaction — lane A
  frontend/
    package.json
    src/
      App.tsx
      components/
        TopologyGraph.tsx
        TerminalFeed.tsx
        HypothesisCard.tsx
        TrialComparison.tsx
        EvidenceDrawer.tsx
        DiagnosticDrawer.tsx
  scripts/
    doctor.ts
    preparePayload.ts
    migrate.ts
    cleanup.ts
  docs/
    integrations.md
    demo.md
  .entropy/                       # ignored payload bundles/artifacts/tool mapping
```

Do not introduce Redis/Postgres as product stores, a general agent framework, Kubernetes, public hosting, accounts, or a distributed queue. The target mocks are not extra product databases. One in-memory scheduler drives a durable Neo4j-backed run record; restart marks unfinished work interrupted and reconciles resources instead of pretending to resume safely.

Install exact stable dependency versions and commit the lockfile. Validate Node engine requirements before locking. Use one stable Daytona API family, not v2 alpha examples. Current installed types and a successful smoke check take precedence over copied examples. [Daytona SDK](https://www.daytona.io/docs/en/typescript-sdk/), [MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/)

## 3. Initial integration gate: first 20 minutes

Owner supplies keys locally while agents scaffold. No credentials in Git, browser code, payload, model prompts, or terminal output.

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
```

Load the root `.env` explicitly in backend/scripts. Vite proxies `/api` to the backend; no sponsor key uses a `VITE_*` variable.

`npm run doctor` must:

1. Create a small Daytona sandbox, execute `node --version`, upload/download a file, then delete in `finally`. Check actual quotas permit two simultaneous small sandboxes. Record SDK version, runtime, snapshot identity, and account region.
2. Discover Nosana models with `GET /models`, choose/save an available model ID, and make one short inference call. Test plain JSON output; do not assume native function calling or structured-output mode.
3. Verify Neo4j connectivity, `RETURN 1`, and idempotent schema setup.
4. Authenticate Daytona CLI separately, spawn `daytona mcp start`, enumerate all tool schemas, and successfully read the smoke file via the actual MCP tool before cleanup. Record actual names/argument shapes in ignored `.entropy/mcp-tools.json` and sanitized integration notes.
5. Report redacted per-provider state and exit nonzero if required access is missing. Record last checked times for the dashboard.

SDK credentials do not prove CLI authentication. Read the official CLI setup instructions rather than inventing tool names or installers. [Daytona MCP](https://www.daytona.io/docs/en/mcp/)

Nosana's documented hosted base URL is `https://inference.nosana.com/v1`; availability/model IDs change, so verify with the supplied account. [Nosana inference](https://learn.nosana.com/llm/)

If a sponsor is inaccessible at minute 20, notify the owner with the exact missing access. Independent UI/payload work can use explicitly labeled development fixtures. A local simulator or deterministic text does not satisfy sponsor completion, and may not silently replace a failed live call. A different hosting/inference architecture requires an owner decision.

## 4. Six-node mesh and controlled fault

### Topology and ports

One sandbox runs one Node payload process hosting six separate loopback HTTP servers. This is a miniature mock mesh, not six OS containers. Explicit gates model bounded service concurrency; do not claim Node's event loop itself blocks on asynchronous HTTP.

| Logical ID | Name/type | Port | Business behavior |
| --- | --- | --- | --- |
| `frontend` | Frontend / Service | 4100 | `POST /checkout` calls Order; `GET /session` calls Auth |
| `order-service` | OrderService / Service | 4101 | `POST /orders` calls Payment |
| `payment-service` | PaymentService / Service | 4102 | `POST /authorize` verifies through Auth, then writes to Postgres mock |
| `auth-service` | AuthService / Service | 4103 | `POST /verify` reads token from Redis mock |
| `redis-cache` | RedisCache / Datastore mock | 4104 | `POST /lookup` validates a fixed seeded demo token |
| `postgres-db` | PostgresDB / Datastore mock | 4105 | `POST /write` accepts a fixed idempotent demo record |

Every server exposes `/health` independently of business endpoints. Private control API binds loopback port 4199; only the trusted harness accesses it. Faults never target readiness endpoints.

Configured edges follow the original brief:

```text
frontend       -CALLS->        order-service
order-service  -CALLS->        payment-service
payment-service-WRITES->      postgres-db
frontend       -CALLS->        auth-service
auth-service   -READS->        redis-cache
payment-service-VERIFY_TOKEN->auth-service
```

Token verification is real within the mock contract: the seeded demo token verifies, an unknown token returns 401, and upstream auth failure returns an error. No real user credentials or payment operations exist. Authentication timeouts must never be treated as successful verification.

### Timing and queue constants

Use deterministic values with wide margins, not timing-sensitive millisecond assertions:

| Setting | Value |
| --- | --- |
| Healthy Redis lookup delay | 5 ms |
| Healthy Postgres write delay | 8 ms |
| Chaos Redis business delay | 3,000 ms |
| Auth → Redis deadline | 4,000 ms |
| Payment → Auth deadline | 4,500 ms |
| Order → Payment deadline | 1,200 ms |
| Frontend → Order deadline | 1,600 ms |
| Frontend → Auth session deadline | 800 ms |
| Traffic generator request deadline | 6,000 ms |
| Payment active request slots | 4 |
| Payment queue capacity | 4 waiting requests |
| Maximum queue wait | 1,000 ms |

The Payment gate surrounds Auth verification plus Postgres write. Requests above queue capacity receive structured 503 immediately; queued requests exceeding their queue deadline receive structured 503. Always release slots in `finally`. Use an actual FIFO queue, not a fabricated saturation counter. Record active-slot/queue high-water marks and rejected counts.

The intentionally fragile mesh does not automatically cancel Payment's outstanding Auth work when an upstream caller disconnects; record this modeled limitation. External HTTP deadlines still bound all work. This lets a Redis delay occupy scarce Payment slots and affect the upstream checkout path without any synchronous event-loop blocking claim.

Map dependency deadline errors to structured 504, other dependency failures to 502, and queue rejection to 503. Include request IDs, not secrets. Independent `/health` stays available; do not classify a process healthy solely because its readiness endpoint answers.

### Single supported fault

```json
{
  "targetServiceId": "redis-cache",
  "faultType": "LATENCY_SPIKE",
  "faultParams": { "delayMs": 3000, "durationSec": 10 }
}
```

Only this spec is executable in v1. The model generates the question, predicted path, and rationale around a supported intervention. Do not implement arbitrary commands, service kill, random packet loss, or unconstrained model-selected faults.

`faultCtl.ts` calls the private controller using a fixed command schema. The controller acknowledges mode/config hash and records when the next Redis business requests actually execute the delay. A valid chaos trial requires those witnesses during the measured window. Do not count merely writing a config flag as proof that the fault ran.

Expected but unpromised outcome: Redis is slow; Auth inherits latency; Payment slots/queue experience pressure; Order and Frontend see timeouts/errors. Actual affected IDs come from telemetry. Postgres may remain healthy under its separate canary workload while receiving few checkout writes; show those counts honestly.

## 5. Traffic, metrics, traces, and health classification

### Identical workload schedule

Each trial boots fresh processes/state, validates all six readiness endpoints, executes 10 healthy warmup checkout requests at concurrency two, waits for them to settle, then clears measurement counters. Fault/control configuration is acknowledged immediately before the measured window.

Measured phase: 10 seconds at a fixed schedule of 10 checkout requests/second plus one session request/second. Launch requests on scheduled ticks rather than waiting for the previous response, and cap generator concurrency at 32. Record scheduled, started, completed, failed, and skipped-due-to-generator-cap counts separately. A skipped launch is a generator limitation, not a service error.

Additionally send one Redis and one Postgres business canary per second to observe otherwise idle stores. Tag canary traffic separately from checkout/session traffic, exclude canary spans from inferred checkout cascades, and show sample/channel counts on node details. Readiness probes never enter measured business metrics.

Drain in-flight calls for at most 6 seconds after the scheduled window. Track launch time and completion time so a late sample is attributed to the trial that launched it. Remaining unresolved requests become explicit client timeouts, not missing successful requests. Stop servers in `finally`.

Use fixed tokens/order inputs and deterministic request IDs. Error-rate randomness is unnecessary because v1 uses a latency fault. Persist the schedule/config hash for baseline, control, chaos, and reproduction. If generator-cap skips exceed 5% of scheduled business requests, mark the trial load-limited/inconclusive instead of attributing all differences to the application.

### Metrics

For each service and channel, retain bounded request samples: trace ID, span ID, parent span ID, service ID, optional downstream ID, start/end, duration, HTTP status or timeout/error class, and applied fault marker. Collect explicit Payment gate samples/counters too.

Client-perceived checkout/session latency is measured at the generator and includes failed requests. Service-handler latency is measured at the receiving service and may outlive the caller's deadline; label the distinction. Cross-service durations use monotonic clocks inside one sandbox, with wall timestamps only for display. Never compare independent sandbox wall-clock times as latency samples.

Compute p50/p95/p99 by nearest rank: sort durations ascending and use index `max(0, ceil(p * N) - 1)`. Include success and failure durations, report sample count, and return `null` for no observations. For N < 20 label tail percentiles **small sample**; p99 from 100 requests is descriptive, not a production reliability guarantee.

Metrics include requests started/completed, non-2xx errors, client timeouts, error fraction denominator, percentiles, channel, active-slot/queue peaks, and queue rejections. An intended injected Redis delay is not an HTTP error if its response succeeds; it can still exceed the latency threshold. Service metrics use receiving-handler samples, counting a returned 504 once as an error; caller-side timeout spans and generator-perceived latency remain separately identified and are never added to the same denominator a second time.

### Health rules

Add `UNKNOWN` to the brief's health enum. Choose a fixed primary channel per node: `business` for the four services and `canary` for the two datastore mocks, consistently across control and chaos. Keep the other channel's measurements accessible in the drawer. This allows a healthy-but-unused Postgres mock to be assessed by its explicit canary rather than assumed healthy from an absence of checkout writes. Determine node state from completed requests on its primary channel, never a prewritten affected-node list:

- `UNKNOWN`: zero completed samples on the selected primary channel; do not infer healthy.
- `DOWN`: at least 10 completed samples on the selected primary channel and error fraction ≥ 0.80.
- `DEGRADED`: error fraction ≥ 0.05, or p95 > 500 ms, or measured queue rejection/saturation evidence.
- `HEALTHY`: samples exist and none of the above rules apply.

Use the same thresholds in control and chaos. Saturation evidence means sustained full occupancy for at least 500 ms or nonzero queue waiting/rejection, not a single instantaneous peak of four slots. Show raw values beside states. The **affected set** is calculated with the exact comparison rules in section 16, not every transitive dependency by definition. A bad healthy control makes causal comparison inconclusive and must be visible. A Redis canary proves delay at that mock; a checkout-cascade claim additionally needs a fault witness from the actual business trace.

Configured edges and actual request-span edges are distinct. A reverse `CASCADED_TO` display edge requires supporting request/span IDs and measured upstream degradation along a configured relationship. Label it an **observed failure path**, not a universal proof of causality. Predicted edges are dashed and cannot substitute for missing observed traces.

## 6. Payload identity, execution lifecycle, and cleanup

### Immutable payload preparation

`npm run prepare:payload -- <full-git-sha>` extracts committed payload sources with `git archive` to an ignored temporary directory. Bundle the TypeScript entry points using the root lockfile's exact build-tool version into self-contained Node JS. Payload imports only Node built-ins, so target sandboxes do not need frontend/backend dependency installation.

Create `.entropy/payload/<sha>/manifest.json` with source SHA, archive SHA-256, product lock hash, build-tool version, bundled payload SHA-256, topology/config hash, workload hash, and immutable snapshot/image identity. Do not include `.env`, provider SDK credentials, Git credentials, or untracked files. Validate hashes before upload and record actual `node --version` in every sandbox. The same bundle bytes go to all trials.

A local implementation commit is needed before the first recorded experiment. Use the team's ordinary Git workflow; do not automatically commit unrelated user work. An uncommitted working directory may be used for local development, never mislabeled as the recorded immutable source.

### Trial runner and parallelism

One initial run allocates three measurement sandboxes:

1. **Baseline:** fresh healthy trial; collect and delete. If checkout/session errors, invalid reports, or generator limitations invalidate it, stop and show the reason.
2. **Control:** fresh healthy trial under the same measured workload.
3. **Chaos:** fresh trial using the same bundle/workload with only the Redis-delay intervention changed.

Control and chaos run concurrently after the initial baseline passes. Provision both sandboxes, upload/check both payloads, and finish preparation before releasing a shared start barrier; then dispatch both trial commands concurrently. Do not let the control complete while the chaos sandbox is still provisioning. Record backend command-dispatch times and execution intervals to demonstrate overlap. Use a global maximum of two live sandbox reservations across trials, retries, reproductions, and diagnostics. Account limits must support that concurrency for the final parallel demo. One-slot development can serialize trials but is labeled as such and uses no two-sandbox preparation barrier.

Use roughly 1 vCPU, 2 GiB RAM, 5 GiB disk per sandbox after verifying actual account/snapshot requirements. Snapshot resources may be inherited; do not assume every creation path supports resource overrides. Labels include `project=entropy`, run ID, trial ID, purpose, and creation time.

Only `daytonaRunner.ts` imports `@daytona/sdk`. Its application boundary exposes `create`, `upload`, `execute`, `download`, `destroy`, and `reconcile` operations. Use stable SDK methods (`daytona.create`, sandbox process/filesystem operations, deletion), explicit timeouts, and installed type signatures. [Lifecycle API](https://www.daytona.io/docs/en/typescript-sdk/daytona/), [process API](https://www.daytona.io/docs/en/typescript-sdk/process/), [file API](https://www.daytona.io/docs/en/typescript-sdk/file-system/)

The orchestrator executes retrieve → hypothesize → baseline → matched trials → compare → persist graph/evidence → analyze → finalize. Return a run ID to HTTP immediately and execute in the long-lived scheduler. Every state transition is persisted before publishing its event. One active experiment/reproduction/diagnostic workflow at a time simplifies ownership; the two trial sandboxes inside a workflow may run in parallel.

### State and limits

`RunStatus`: `QUEUED | HYPOTHESIZING | BASELINING | RUNNING_TRIALS | ANALYZING | COMPLETED | BASELINE_FAILED | INCONCLUSIVE | FAILED | CANCELLED | INTERRUPTED`.

`TrialStatus`: `QUEUED | PROVISIONING | PREPARING | RUNNING | COLLECTING | COMPLETED | FAILED | CANCELLED | INTERRUPTED`.

`CleanupStatus`: `NOT_CREATED | PENDING | DELETED | FAILED`. Cleanup remains separate from measured outcome. An analysis failure can coexist with completed measurements; a provider/report failure cannot masquerade as a service regression.

| Budget | Limit |
| --- | --- |
| Active workflows | 1 |
| Concurrent sandbox reservations | 2 |
| Initial measurement sandboxes | 3 |
| Reproduction | At most one matched pair per original run |
| Diagnostics | One active, at most one session per run |
| Total allocations, including retries | 8 per run |
| Sandbox creation | 60 seconds |
| Measured trial command | 60 seconds |
| File collection | 30 seconds per bounded operation |
| Initial run wall deadline | 6 minutes including bounded cleanup attempts |
| Diagnostic deadline | 3 minutes including preparation/cleanup attempts |
| Delete attempt | 30 seconds, one retry |
| Artifact | 2 MiB structured report; 256 KiB per retained log; 5 MiB total per trial |

Count retries against allocation limits. Persist sandbox IDs immediately after creation. An ambiguous create timeout requires label reconciliation before retry, because a timed-out request may still have created a resource. Keep a capacity reservation until deletion is confirmed; failed cleanup must not let the pool exceed two by ignoring orphaned sandboxes.

Always collect bounded reports, traces, fault witnesses, and runtime manifest before `finally` deletion. Write normalized local recovery JSON before the Neo4j result transaction. If graph persistence fails, retain evidence, stop new scheduling, delete resources, and mark a persistence error. Retry validated recovery writes idempotently on restart.

Cancellation prevents queued starts and later phases, preserves partial evidence, and deletes active sandboxes. Browser disconnect does not cancel work. On restart, mark unfinished records interrupted, reconcile labeled resources, and do not silently resume half-measured trials. `npm run cleanup` operates only on Entropy-owned IDs/labels. Provider auto-stop/delete settings are a verified backstop, not a replacement for cleanup.

## 7. Shared contracts: establish before parallel coding

`shared/types.ts` is the single source of truth. Lane B writes Zod schemas/inferred types first; lane A reviews lifecycle and telemetry fields before implementation. The original `.spec` types are product sketches; the definitions here replace contradictory fields such as a guaranteed remediation result or automatic local fallback.

```ts
type ServiceId = 'frontend' | 'order-service' | 'payment-service'
  | 'auth-service' | 'redis-cache' | 'postgres-db';
type NodeHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
type TrialKind = 'baseline' | 'control' | 'chaos' | 'reproduction-control' | 'reproduction-chaos';

interface ServiceNode {
  id: ServiceId;
  name: string;
  type: 'Service' | 'Datastore';
  port: number;
  mock: boolean;
  status: NodeHealthStatus;
  metricId?: string;
}

interface DependencyEdge {
  id: string;
  source: ServiceId;
  target: ServiceId;
  relationship: 'CALLS' | 'READS' | 'WRITES' | 'VERIFY_TOKEN' | 'CASCADED_TO';
  evidenceKind: 'configured' | 'predicted' | 'observed';
  timeoutMs?: number;
  circuitBreaker: boolean;
  supportingSpanIds: string[];
}

interface TopologyGraph {
  runId?: string;
  trialId?: string;
  nodes: ServiceNode[];
  edges: DependencyEdge[];
}

interface ChaosHypothesis {
  id: string;
  title: string;
  question: string;
  targetServiceId: 'redis-cache';
  faultType: 'LATENCY_SPIKE';
  faultParams: { delayMs: 3000; durationSec: 10 };
  predictedBlastRadiusIds: ServiceId[];
  rationale: string;
  cypherQueryUsed: string;       // actual fixed server query, never executable model text
  source: 'nosana' | 'catalogue_fallback';
  model?: string;
}

interface ServiceMetric {
  id: string;
  serviceId: ServiceId;
  channel: 'business' | 'canary';
  status: NodeHealthStatus;
  requestsStarted: number;
  requestsCompleted: number;
  errorsTotal: number;
  timeoutsTotal: number;
  errorRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  sampleCount: number;
  smallSample: boolean;
  activeSlotsPeak?: number;
  longestSaturatedIntervalMs?: number;
  queueLengthPeak?: number;
  requestsQueued?: number;
  queueRejected?: number;
}

interface RequestSpan {
  id: string;
  kind: 'server' | 'client';
  traceId: string;
  parentSpanId?: string;
  serviceId: ServiceId;
  downstreamId?: ServiceId;
  channel: 'business' | 'canary';
  startedAt: string;
  durationMs: number;
  statusCode?: number;
  errorClass?: 'timeout' | 'queue_full' | 'queue_timeout' | 'dependency_error';
  faultApplied: boolean;
}

interface ArtifactRef {
  id: string;
  kind: 'metrics' | 'spans' | 'fault_witness' | 'runtime' | 'terminal' | 'diagnostic';
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
  available: boolean;
}

interface TrialTelemetry {
  id: string;
  runId: string;
  kind: TrialKind;
  status: TrialStatus;          // union in section 6
  executionMode: 'daytona' | 'development-local';
  sandboxId?: string;
  cleanupStatus: CleanupStatus;
  startedAt?: string;
  finishedAt?: string;
  sourceSha: string;
  payloadHash: string;
  workloadHash: string;
  runtimeIdentity: string;
  faultWitnessed: boolean;
  metrics: ServiceMetric[];
  spans: RequestSpan[];         // bounded summaries; full bounded file via artifact
  artifacts: ArtifactRef[];
  clientSummary: {
    scheduled: number;
    started: number;
    completed: number;
    skipped: number;
    errors: number;
    checkoutStarted: number;
    checkoutCompleted: number;
    checkoutErrors: number;
    checkoutErrorRate: number | null;
    checkoutP95Ms: number | null;
  };
  validity: 'valid' | 'invalid' | 'inconclusive';
  warnings: string[];
  error?: { code: string; message: string };
}

interface EvidenceAnalysis {
  id: string;
  source: 'nosana' | 'deterministic';
  model?: string;
  status: 'available' | 'unavailable';
  summary: string;
  hypotheses: Array<{ explanation: string; metricIds: string[]; spanIds: string[] }>;
  remediation: Array<{ proposal: string; limitation: string; metricIds: string[] }>;
  promptVersion: string;
  createdAt: string;
}

interface RunSnapshot {
  id: string;
  status: RunStatus;             // union in section 6
  createdAt: string;
  finishedAt?: string;
  sourceSha: string;
  payloadHash: string;
  topologyHash: string;
  hypothesis?: ChaosHypothesis;
  trials: TrialTelemetry[];
  actualBlastRadiusIds: ServiceId[];
  comparisonValidity: 'not_evaluated' | 'valid' | 'inconclusive';
  comparisonReasons: string[];
  graph: TopologyGraph;
  analysis?: EvidenceAnalysis;
  lastEventSeq: number;
  warnings: string[];
}
```

Export exact lifecycle unions and `DiagnosticSession` too. A diagnostic includes run/session/sandbox IDs, state, cleanup state, timestamps, bounded tool trace, final analysis, and optional error. Each trace entry contains action, actual MCP tool name, success/error, timestamps, redacted argument summary, and bounded result summary.

`AgentStreamEvent` contains `id` (run ID + sequence), `runId`, `seq`, `type`, UTC timestamp, message, and a typed bounded payload. Supported event types:

```text
GRAPH_LOADED, HYPOTHESIS_GENERATED, SANDBOX_PROVISIONING,
BASELINE_TRAFFIC_COMPLETE, TRIAL_STARTED, FAULT_INJECTED,
TELEMETRY_COLLECTED, CASCADE_DETECTED, NEO4J_BLAST_RADIUS_UPDATED,
ANALYSIS_GENERATED, REMEDIATION_PROPOSED, DIAGNOSTIC_TOOL_RESULT,
CLEANUP_COMPLETE, RUN_COMPLETE, TERMINAL_LOG, ERROR
```

Do not emit `PATCH_APPLIED` or `VERIFICATION_COMPLETE` for work that did not happen. `REMEDIATION_PROPOSED` is advice only. Telemetry snapshots remain authoritative if SSE messages arrive late.

All executable boundaries reject unknown fields and enforce service-ID membership, string lengths, and budgets. No model/browser-supplied shell commands, arbitrary Cypher, executable diffs, filesystem paths, provider endpoints, or sandbox IDs.

Internal interfaces agreed by minute 20:

- `GraphRepository`: `ensureSchema`, `seedTopology`, `createRun`, `retrieveRiskContext`, `saveHypothesis`, `updateRun`, `saveTrial`, `saveComparison`, `saveAnalysis`, `appendEvent`, `getRun`, `listRuns`, `getEventsAfter`, `getGraph`, `saveDiagnostic`, `findUnfinishedResources`.
- `NosanaClient`: `hypothesize(riskContext)`, `analyze(validatedEvidence)`, `nextDiagnosticAction(context)`.
- `Orchestrator`: `startRun(operationKey)`, `cancel(runId)`, `reproduce(runId, operationKey)`, `investigate(runId, operationKey)`.

Methods consume shared types; no duplicate DTO definitions in frontend/backend. Lane A does not implement a second graph repository, and lane B does not implement a second scheduler.

## 8. Express API, SSE, persistence boundaries

API is local-only on `127.0.0.1:3001`; Vite on 5173 proxies `/api`. Explicit development mode displays a banner and is excluded from live acceptance. Do not build authentication/public deployment in this timebox.

| Method/path | Input | Response |
| --- | --- | --- |
| `GET /api/health` | None | Process status, no paid checks |
| `GET /api/integrations` | None | Cached/redacted provider/MCP health + last checked |
| `GET /api/topology` | Optional `runId`, `trialId` | Neo4j-backed `TopologyGraph`; template if no run |
| `POST /api/chaos/run` | `{}` + `Idempotency-Key` header | 202 `{ runId }`; bounded Redis experiment |
| `GET /api/runs` | None | Latest 20 run summaries |
| `GET /api/runs/:id` | None | `RunSnapshot` |
| `GET /api/stream?runId=...` | Optional `Last-Event-ID` | SSE event stream for this run |
| `POST /api/runs/:id/cancel` | `{}` | 202, cleanup proceeds; terminal calls idempotent |
| `POST /api/runs/:id/reproduce` | `{}` + operation key | 202 `{ reproductionId, trialIds }` |
| `POST /api/runs/:id/investigate` | `{}` + operation key | 202 `{ diagnosticId }` |
| `GET /api/diagnostics/:id` | None | Diagnostic snapshot |
| `POST /api/diagnostics/:id/cancel` | `{}` | 202 with cancellation/cleanup state |
| `GET /api/artifacts/:id` | None | Registered bounded text/JSON file |

The old `/api/chaos/remediate` and `/api/topology/reset` actions are not v1 controls. Do not add a button that implies an unimplemented patch/verification or destroys historical evidence. A new run creates its own snapshots; resetting the dashboard is selection state only.

Return structured errors `{ error: { code, message, requestId } }`: 400 invalid input, 404 unknown ID, 409 busy/invalid lifecycle, 503 required provider unavailable. Body size limits and server-generated IDs prevent arbitrary path/command inputs. Redact exceptions; browser logs are escaped text, not HTML.

One operation key maps to one accepted action. Store unique operation keys in Neo4j; retries return the original IDs. Browser generates one UUID per user click and reuses it on network retries. A genuine new action gets a new key. Backend and UI reject overlapping workflows; reproduction/investigation require the original run terminal.

SSE emits JSON with `id`, `event`, and `data`; use 15-second heartbeats and close listeners on disconnect. Append a bounded durable event log (latest 250 entries per run) before publishing. Coalesce terminal summaries to at most one event per second; raw request spans remain in artifacts instead of generating an event each. Serialize per-run append operations to avoid overwriting concurrent events. Reconnect fetches the latest snapshot and requests events after the last sequence. If replay is truncated, send a resync event and fetch a snapshot. SSE loss never changes measurements or cancels a run.

Persist only bounded metadata/metrics/spans in DTOs. Full bounded artifacts live under `.entropy/artifacts/<run>/<trial>/`, accessed by registered artifact ID. Validate path containment, check size before download, truncate log tails explicitly, redact secrets, hash retained files, and strip terminal escape codes. Missing artifacts produce an unavailable state. Neo4j is the query source of truth; local recovery files exist only for retrying interrupted persistence.

## 9. Neo4j topology, retrieval, and measured graph

Use `Service`, `Datastore`, `EntropyRun`, `EntropyTrial`, `EntropyMetric`, `EntropyHypothesis`, `EntropyAnalysis`, `EntropyDiagnostic`, and `EntropyOperation` labels. Topology node `id` is the logical service ID; a separate unique `key` scopes it to the template or run. All mutations constrain the Entropy project namespace.

Template node key: `entropy:template:<topologyHash>:<serviceId>`. Run node key: `entropy:<runId>:<serviceId>`. Each run copies six topology nodes and configured edges so later status/config updates cannot overwrite historical runs. All graph edges use actual source/target logical IDs from the registry.

Relationships:

```text
(Run)-HAS_TRIAL->(Trial)-HAS_METRIC->(Metric)-OF_SERVICE->(run-scoped Service/Datastore)
(Run)-HAS_HYPOTHESIS->(Hypothesis)
(Run)-HAS_ANALYSIS->(Analysis)
(Run)-HAS_DIAGNOSTIC->(Diagnostic)-HAS_ANALYSIS->(Analysis)
(Service/Datastore)-CALLS|READS|WRITES|VERIFY_TOKEN->(Service/Datastore)
(Service/Datastore)-CASCADED_TO {trialId, supportingSpanIds}->(Service/Datastore)
```

Configured dependency edges point caller → dependency. Observed cascade overlays point degraded dependency → affected caller. Preserve this distinction in the legend and evidence. Prediction is a hypothesis record, not a mutation of measured health.

Use uniqueness constraints on `key` for Service/Datastore and `id` for other labels, plus `EntropyOperation.id` for idempotency. Migration uses `IF NOT EXISTS` and ordinary uniqueness syntax, compatible with Community/Aura. Store nested structured values as canonical JSON strings where needed; Neo4j properties do not hold arbitrary nested object trees. Convert driver integers/temporal values to plain JSON. [Neo4j constraints](https://neo4j.com/docs/cypher-manual/5/constraints/create-constraints/)

Risk retrieval is a fixed parameterized Cypher query, not model-generated code. Retrieve inbound paths to Redis, configured deadlines/gates, and components sharing Auth. Example logical query shape:

```cypher
MATCH p=(s:Service)-[:CALLS|READS|VERIFY_TOKEN*1..5]->(r:Datastore)
WHERE r.key = $redisKey
  AND all(n IN nodes(p) WHERE n.projectId = $projectId AND n.scope = $scope)
RETURN [n IN nodes(p) | n.id] AS path,
       [e IN relationships(p) | {type: type(e), timeoutMs: e.timeoutMs}] AS edges
ORDER BY size(path) DESC
LIMIT 10;
```

Seed `projectId`, `scope`, and timing metadata consistently. This retrieves graph context for the model (a small structured graph-retrieval workflow). It does not prove single points of failure without workload/fallback evidence. Show the actual query and parameters used in an inspector; never execute an LLM's `cypherQueryUsed` value.

`saveTrial` atomically commits trial state, metrics, artifact metadata, and source/workload hashes. Allocate IDs before transactions and use deterministic metric IDs `<trialId>:<serviceId>:<channel>`, with idempotent `MERGE`. One shared driver, short-lived closed sessions, parameterized queries, and managed transactions are required. Driver callbacks can retry: no provider calls, file writes, random ID creation, or other external effects inside a transaction callback. [Neo4j transactions](https://neo4j.com/docs/javascript-manual/current/transactions/)

Comparison queries must select a run and a trial explicitly. Return control/chaos metrics, worsening node IDs, and supporting observed-path spans. A graph refresh queries persisted metrics rather than manufacturing red nodes from the predicted IDs. Limit graph output to the six nodes and bounded configured/observed overlays. Store reproduction trial pairs alongside the parent run, but select original vs reproduction explicitly in UI; do not overwrite original observations.

## 10. Nosana hypothesis, explanation, and remediation advice

Use native `fetch` with Bearer auth against the configured Nosana endpoint. Discover/pin an available model during setup. For v1, request ordinary JSON content through `/chat/completions`; do not depend on native tool calling, streaming, or schema modes. Record model, timestamp, latency, prompt version, and usage if returned. Do not retain/display private reasoning fields. [Nosana API](https://learn.nosana.com/llm/)

### Hypothesis input/output

Input: retrieved paths, known deadlines, Payment gate configuration, fixed traffic schedule, and the single allowed fault. Output:

```json
{
  "title": "A proposed title",
  "question": "Will the Redis delay occupy Payment capacity and affect checkout?",
  "targetServiceId": "redis-cache",
  "faultType": "LATENCY_SPIKE",
  "faultParams": { "delayMs": 3000, "durationSec": 10 },
  "predictedBlastRadiusIds": ["redis-cache", "auth-service", "payment-service", "order-service", "frontend"],
  "rationale": "A prediction grounded in the supplied topology and configured limits."
}
```

This is a schema example, not a stored inference result. Validate service IDs, exact executable fault values, rationale length, and graph membership. Backend attaches the actual fixed Cypher and generated hypothesis ID. The hypothesis may predict fewer affected nodes; the model must not claim the result already happened.

### Analyst input/output

Input: valid control/chaos metric summaries, actual affected IDs computed in code, queue counters, fault witnesses, and a small set of supporting request spans. Output:

```json
{
  "summary": "A concise interpretation of the supplied measurements.",
  "hypotheses": [
    { "explanation": "A qualified mechanism supported by these observations.", "metricIds": ["actual-metric-id"], "spanIds": ["actual-span-id"] }
  ],
  "remediation": [
    { "proposal": "Bound waits and isolate dependency capacity; validate under the same workload.", "limitation": "An authentication timeout must fail closed and may still reject checkouts.", "metricIds": ["actual-metric-id"] }
  ]
}
```

Validate every evidence ID against supplied measurements, require at least one real metric reference per hypothesis, and cap prompt input around 12 KiB with priority for changed metrics/witnesses. Backend-calculated counts/percentiles/statuses cannot be overwritten by prose. Distinguish fact, hypothesis, and proposed remediation in the UI.

Parse the full content as JSON, allowing at most one enclosing Markdown fence. Validate with Zod; one repair request is allowed. Use a 30-second request timeout, bounded output tokens, and at most one transient retry within workflow deadlines. Invalid content is not executable. A failed hypothesis request can use the fixed catalogue hypothesis explicitly labeled fallback; analysis unavailability displays measured facts and an unavailable message. At least one real hypothesis and explanation must succeed for live acceptance.

Automatic patching is deferred. Do not generate/apply free-form TypeScript inside the measurement loop. A future verification feature must preserve original evidence and use fresh matched trials; claims of better availability must measure errors and tail latency, without bypassing authentication. No v1 UI label should promise self-healing.

## 11. Daytona MCP diagnostic agent

Preserve the accepted MCP integration as a small, real post-run feature, separate from deterministic load measurement. It is not satisfied by developers using MCP while coding.

Use the official client/stdio transport to spawn `daytona mcp start`. Discover actual tool names and input schemas with `listTools`; handle pagination appropriate to the installed SDK. Record and validate mappings for file-read and process-execution tools. `callTool` can throw transport/protocol errors or return `isError`; handle both. [MCP client calls](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling)

Lifecycle:

1. Validate the original run has terminal measured evidence; reserve one diagnostic slot/budget.
2. Create a separate SDK-managed diagnostic sandbox with the same immutable payload/runtime. Upload `.entropy-diagnostic/evidence.json` containing sanitized original metrics, selected spans, graph paths, artifact IDs, and allowed service IDs.
3. Ask Nosana for one JSON action. The model usually selects `read_evidence`; backend maps it to the discovered Daytona MCP file-read tool and fixed path in this sandbox.
4. Optionally permit `probe_auth`, which runs a fixed trusted diagnostic payload command through MCP, starts/restores the controlled Redis delay, sends one known demo request, and returns its bounded JSON result. This is a diagnostic probe, not a new statistical trial.
5. Obtain the final evidence-grounded explanation, save the actual tool trace, and delete the sandbox in `finally`.

Action schema:

```ts
type DiagnosticAction =
  | { action: 'read_evidence' }
  | { action: 'probe_auth' }
  | { action: 'finish'; summary: string; metricIds: string[]; spanIds: string[] };
```

Map the small action set to fixed local templates. No arbitrary model-selected tool names, commands, paths, service IDs, URLs, sandbox IDs, or credentials. Tool outputs/logs are untrusted data, not instructions. Child MCP process receives only required CLI authentication/environment, not Nosana/Neo4j keys.

Limit to two MCP calls, three model turns including final explanation, and three minutes total within remaining resource budgets. Close the transport on shutdown and cancel pending work on cancellation. Store actual MCP name, action, timing, success/error, bounded redacted output, sandbox ID, and cleanup status. If the model finishes without any MCP call, label the session as no-tool evidence and do not count it toward live acceptance. Real evidence-read + explanation is required; the optional probe is cut first if time is short.

## 12. Two-person coding lanes, ownership, and schedule

Use two coding agents with clear ownership. The humans handle credentials, product review, and integration decisions. Worktrees/branches are useful if sharing a checkout would cause overlapping edits. One lockfile owner avoids concurrent dependency rewrites.

### Shared first 20 minutes

Lane A owns root tooling/config, Express bootstrap, lifecycle/payload, source packaging, SDK/MCP, and cleanup. Lane B owns `shared/types.ts`, Neo4j, Nosana, and all frontend code. Agree on the internal interfaces in section 7 immediately. Lane B requests dependency additions from lane A; both avoid rewriting root manifests/lockfile independently. Lane A reviews the shared schema before the first integration checkpoint; later schema changes require notifying the other lane.

### Lane A — executor and API

1. [ ] Scaffold root/backend/shared/frontend package setup with lane B's requested dependencies; environment schema and scripts.
2. [ ] Prove Daytona SDK/MCP access, record tool mappings; expose `doctor` hooks.
3. [ ] Implement six-port payload, explicit Payment gate, trusted fault controller, spans, load generator, percentile calculation, and local trial harness.
4. [ ] Demonstrate healthy vs fault behavior locally with real requests and queue/witness evidence.
5. [ ] Implement frozen payload preparation and one real fresh Daytona baseline with cleanup.
6. [ ] Add matched parallel control/chaos trials, source/runtime checks, limits, persistence calls, cancellation/restart reconciliation.
7. [ ] Implement Express/SSE routes against shared types, idempotency, and snapshot/event replay.
8. [ ] Add independent matched reproduction and real MCP evidence-read investigation; probe is optional.
9. [ ] Run the live acceptance path with lane B; fix lifecycle/reporting/resource defects before visual polish.

Do not write another Nosana provider or graph repository. Use lane B's interfaces and actual persisted observations.

### Lane B — graph, AI, and dashboard

1. [ ] Define shared schemas/types/fixture snapshots and agree on them with lane A.
2. [ ] Verify Neo4j/Nosana access; seed the six-node template, migrations, risk-path query, and repository methods.
3. [ ] Implement bounded Nosana hypothesis/analysis with validated evidence references and explicit unavailable states.
4. [ ] Build the dashboard shell, topology graph, trial table, hypothesis card, terminal feed, and evidence drawer against clearly labeled fixtures.
5. [ ] Wire API/SSE snapshots to the actual graph/results; no silent fixture fallback.
6. [ ] Show predicted vs observed paths, sample counts, queue metrics, recorded source, cleanup state, and reproducibility hashes.
7. [ ] Add reproduction and diagnostic presentation; display proposed remediation without an apply-patch claim.
8. [ ] Verify persisted queries and saved-run refresh/restart; write demo/runbook and rehearse with lane A.

Do not build an alternative scheduler or infer observed node states from model prediction.

### Timeboxes

| Time | Lane A | Lane B | Acceptance checkpoint |
| --- | --- | --- | --- |
| 0–20 min | Tooling, Daytona/MCP smoke, interface review | Contracts, Neo4j/Nosana smoke | Access known; contracts frozen |
| 20–65 min | Mesh, gate, traces, local load/fault | Graph/query/provider; UI shell | Local healthy/fault trials produce measured JSON |
| 65–105 min | Real baseline/chaos SDK slice; API/SSE | Wire real metrics/graph UI | One live end-to-end result with cleanup |
| 105–150 min | Parallel matched pair, comparison, cancellation | Prediction/observation views and evidence links | Full cascade pipeline persisted |
| 150–195 min | Reproduction + MCP evidence read | Analysis, diagnostic/reproduction UI | All required sponsor paths demonstrated |
| 195–225 min | Fix execution/lifecycle defects | Fix UI/data errors, restart checks | Acceptance sequence complete |
| 225–240 min | Freeze, final run | Build checks, demo rehearsal | Four-hour deliverable |
| 240–300 min if available | Diagnostic probe/performance refinement | Readability/documentation | Buffer, no new architecture |

At minute 105 prioritize a real vertical slice over graph polish. At minute 195 freeze feature scope. Cut decorative animations, extra faults, optional diagnostic probe, then additional historical summaries. Automatic patching, extra targets, and arbitrary repository discovery are already excluded. Never cut cleanup or silently substitute sponsor services to make a demonstration appear complete.

### Copy/paste coding-agent prompts

**Lane A**

> Read AGENTS.md, spec/README.md, and spec/plan.md. Implement lane A in section 12, following the fixed cascade-demo architecture. Coordinate contracts and dependency requests with lane B. First prove the payload locally, then one real Daytona trial with cleanup, then the matched parallel pair. Derive every result from actual requests, queue measurements, and validated reports. Use installed SDK types and discovered MCP schemas. Respect file ownership, persist before publishing events, and report checkpoint evidence. Ask the owner before changing sponsor roles, architecture, or product scope; automatic patching is deferred.

**Lane B**

> Read AGENTS.md, spec/README.md, and spec/plan.md. Implement lane B in section 12. Establish shared contracts with lane A first, then Neo4j risk retrieval/persistence, real Nosana hypothesis/analysis, and the React dashboard. Separate configured, predicted, and observed graph data. Fixtures must be visibly labeled and never replace live errors. Do not implement another scheduler, generate fake red nodes, or promise an unexecuted remediation. Respect file ownership and report checkpoint evidence. Ask the owner before changing sponsor roles, architecture, or product scope.

**Integration/review**

> Review against spec/plan.md completion criteria. Prioritize fabricated blast-radius states, missing fault witnesses, omitted error latency, invalid percentile denominators, absent queue enforcement, source/control mismatch, duplicate operations, stale graph state, unsafe auth fallback, and leaked sandboxes. Verify actual Daytona sandbox IDs, Nosana provenance, Neo4j queries, and MCP tool trace. Fix defects within scope and identify any unmet criterion honestly.

## 13. Dashboard behavior

Use a dark neutral developer-tool interface with readable text, one accent, and green/amber/red/gray states with text/icons. Plain CSS is enough. Target 1280×800 desktop; stack panels on smaller screens.

```text
Entropy    Cascade experiment    Source revision    Sponsor status
Run experiment     Current stage     Cancel

[Hypothesis and predicted path]     [Baseline | Control | Chaos | Cleanup]

[Six-node graph: configured + observed overlays] [Selected-node evidence]

[Comparison: checkout errors, p95 with failures, N, Payment queue pressure]
[Nosana explanation / proposed remediation with limitations]
[Terminal events | Reproduce | Investigate | Saved runs]
```

Required behaviors:

- Graph comes from Neo4j-backed API data. Fixed columns/group positions are sufficient; fit-to-view, zoom, readable names, click selection, and a legend matter more than animation.
- Dashed prediction never becomes a measured red state without telemetry. Show UNKNOWN for no samples and small-sample warnings on tail latency.
- Node drawer shows control/chaos counts, error denominators, latency channel, queue counters, supporting span IDs, and bounded logs/witness artifacts.
- Trial cards show actual stage/times/sandbox ID/runtime hash, validity, live/development provenance, and cleanup separately.
- Comparison includes failed request latency and generator skipped counts. Do not show percent improvement without a meaningful denominator; missing values render “not measured.”
- Show original vs reproduction trial pairs explicitly; never replace original results.
- SSE reconnection fetches a snapshot; browser refresh restores selected run via URL. Browser disconnect never cancels backend work.
- Analysis shows model/source, evidence links, uncertainty, and unavailable states. Proposed remediation has no apply button in v1.
- Diagnostic drawer shows actual tool names, actions, elapsed times, redacted observations, final explanation, and cleanup. Private model reasoning is not displayed.
- Empty/loading/error/baseline-invalid/inconclusive/cancelled states are implemented. Buttons reflect busy state; backend remains authoritative.
- Logs render escaped text. Artifact errors are clear. Fixture data has a persistent development banner, and live API errors never silently load fixture results.

## 14. Verification, commands, and handoff

### Focused automated checks

- Percentiles include failure durations; nearest-rank boundaries and empty samples are correct.
- Payment gate never exceeds four active/four queued; queue timeout/rejection and slot release work under exceptions.
- Delay fault changes real Redis business requests while health endpoints remain independent; witness IDs match measured spans.
- No-sample nodes are UNKNOWN; prediction alone does not change observed status; bad controls/generator limitations yield inconclusive comparisons.
- Source/workload/runtime mismatch invalidates comparison. Malformed/missing reports are infrastructure errors, not service failures.
- Global sandbox cap, cancellation, ambiguous-create reconciliation, and cleanup run even when a phase throws. A fake provider is appropriate for these lifecycle checks.
- Duplicate operation keys create one logical run/reproduction/diagnostic.
- Model outputs reject unknown service/evidence IDs, unapproved fault parameters, arbitrary commands/Cypher, and unsafe finish claims.
- Neo4j result re-import is idempotent and a second run does not overwrite the first run's topology/metrics.

### Live acceptance sequence

1. `doctor` passes for real Daytona, Nosana, Neo4j, and MCP, with smoke cleanup confirmed.
2. Local payload healthy/load/fault checks pass; unknown token still fails authentication under all modes.
3. Prepare a committed payload revision and verify archive/runtime/workload identities.
4. Trigger a live run and confirm healthy baseline, overlapping control/chaos sandboxes, and real request traces.
5. Verify the intended Redis business delay is witnessed; inspect Payment slot/queue measurements before claiming saturation.
6. Verify every graph state and affected-node ID matches persisted metrics, not the prediction list. Inspect one path directly in Neo4j.
7. Confirm all errors enter latency/count calculations and sample sizes/traffic channels are displayed.
8. Confirm actual Nosana hypothesis and explanation with validated evidence links, and a truthful unavailable state when deliberately testing a provider error in development.
9. Reproduce with a new matched pair and identical manifest; compare measured results without requiring an invented exact five-node outcome.
10. Investigate via an actual discovered Daytona MCP read tool in a separate sandbox; save trace and cleanup.
11. Cancel a development run and restart the backend; queued work stops, interrupted records are visible, completed runs survive, and cleanup reconciles resources.
12. Confirm no orphaned Entropy sandboxes remain after the successful live sequence.

### Required root scripts

```text
npm ci
npm run doctor
npm run db:migrate
npm run payload:check                # local healthy/fault/load correctness
npm run prepare:payload -- FULL_SHA
npm run dev                          # API 3001 + Vite 5173; graceful Ctrl-C
npm run typecheck
npm test                             # paid provider checks excluded
npm run build
npm run cleanup
```

Lane A owns script implementation and root lockfile updates; lane B supplies migration/Neo4j/provider hooks. Record actual tested dependency/CLI versions in `docs/integrations.md`. Local `compose.yaml` supplies only Neo4j Community with explicit tested image version, loopback ports, named volume, and environment-loaded credentials; Aura users skip it.

Run type/build/focused tests plus one complete live acceptance path. Do not repeatedly launch paid suites without a changed execution concern or a failed check. This specification has not itself verified account access or execution behavior.

Handoff includes exact setup/run commands, source revision, saved run ID, reproduction IDs, diagnostic ID, redacted environment template, passed/failed checks, cleanup result, and remaining limitations. Save a redacted exported real run or screenshots as a presentation backup; label any later playback **recorded run** with original timestamps rather than claiming live execution.

## 15. Primary integration references

The root `.spec` preserves the original product intent. Its SDK package name, automatic fallbacks, and guaranteed healing claims are superseded by the technical rules here.

- [Daytona stable SDK](https://www.daytona.io/docs/en/typescript-sdk/)
- [Daytona lifecycle/creation](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
- [Daytona process execution](https://www.daytona.io/docs/en/typescript-sdk/process/)
- [Daytona files](https://www.daytona.io/docs/en/typescript-sdk/file-system/)
- [Daytona MCP CLI](https://www.daytona.io/docs/en/mcp/)
- [Daytona limits](https://www.daytona.io/docs/en/limits/)
- [Nosana inference and model discovery](https://learn.nosana.com/llm/)
- [Neo4j JavaScript driver](https://neo4j.com/docs/javascript-manual/current/)
- [Neo4j transactions/retry behavior](https://neo4j.com/docs/javascript-manual/current/transactions/)
- [Neo4j constraint syntax](https://neo4j.com/docs/cypher-manual/5/constraints/create-constraints/)
- [Current MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP tool calls/error handling](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling)

## 16. Execution details: remove cross-agent assumptions

These are ordinary implementation decisions within the selected architecture. They close gaps left by the original product sketch; they do not expand v1.

### A. Target HTTP wire formats

All business requests/responses use JSON, with a 16 KiB body limit. Use the literal non-secret demo token `entropy-demo-token`. A valid order is `{ "orderId": "order-0001", "token": "entropy-demo-token", "amountCents": 2500 }`; generate order IDs from the scheduled request index. Validate types, positive integer amount, and known fields before calling downstream services.

| Endpoint | Body/query | Healthy result |
| --- | --- | --- |
| Every `/health` | None | 200 `{ "ok": true, "serviceId": "<logical-id>" }` |
| Frontend `POST /checkout` | Valid order above | 201 `{ "orderId": "order-0001", "authorizationId": "auth-order-0001" }` |
| Frontend `GET /session` | `Authorization: Bearer entropy-demo-token` | 200 `{ "valid": true, "subject": "demo-user" }` |
| Order `POST /orders` | Same order | 201, same order/authorization result as checkout |
| Payment `POST /authorize` | Same order | 201, same order/authorization result; successful auth must precede mock write |
| Auth `POST /verify` | `{ "token": "entropy-demo-token" }` | 200 `{ "valid": true, "subject": "demo-user" }` |
| Redis `POST /lookup` | Same token body | 200 `{ "valid": true, "subject": "demo-user" }` after configured delay |
| Postgres `POST /write` | `{ "orderId": "order-0001", "authorizationId": "auth-order-0001" }` | 200 `{ "stored": true }`; repeated order ID is idempotent |

Unknown token returns 401 `{ "error": { "code": "AUTH_DENIED", "requestId": "..." } }` throughout the chain; preserve 401 rather than turning it into a successful fallback. Malformed input returns 400 `INVALID_INPUT`, queue full returns 503 `QUEUE_FULL`, queue timeout returns 503 `QUEUE_TIMEOUT`, dependency deadline returns 504 `DEPENDENCY_TIMEOUT`, and other failed dependency calls return 502 `DEPENDENCY_ERROR`. Other errors use the same envelope and request ID. Never write a mock payment record after failed verification.

At each outbound call, propagate `x-entropy-trace-id`, `x-entropy-parent-span-id`, and `x-entropy-channel` (`business` or `canary`). Generate a unique span ID for each client call and each receiving handler. A client-call span's parent is the caller's server span; the callee server span's parent is that client-call span. Root generator calls start a new deterministic trace ID. No token/body is retained in spans. Only `kind=server` enters service-handler aggregates; `kind=client` supports edges/timeouts and separate caller latency.

### B. Controller, files, and payload entry points

Bundle the four entry points as `cluster.cjs`, `faultCtl.cjs`, `trafficGen.cjs`, and `runTrial.cjs`. Remote working directory is `/tmp/entropy`; it contains `payload/`, `input.json`, and `out/`. SDK command strings are fixed trusted templates. Values come from schema-validated files, not interpolated model/browser text.

```text
node payload/cluster.cjs --output-dir out
node payload/faultCtl.cjs --input input.json
node payload/trafficGen.cjs --input input.json --output-dir out
node payload/runTrial.cjs --input input.json --output-dir out
```

`runTrial` owns the other processes/controller requests and ensures shutdown. Its SDK execution is one blocking command with the explicit 60-second limit. The separate commands exist for local debugging and the bounded diagnostic probe, not for another independent orchestrator.

Input file schema:

```json
{
  "schemaVersion": 1,
  "runId": "backend-generated-run-id",
  "trialId": "backend-generated-trial-id",
  "kind": "chaos",
  "sourceSha": "full-resolved-git-sha",
  "payloadHash": "sha256-hex",
  "workloadHash": "sha256-hex",
  "fault": { "targetServiceId": "redis-cache", "faultType": "LATENCY_SPIKE", "delayMs": 3000, "durationMs": 10000 }
}
```

Baseline/control use `fault: null`; reproduction kinds select the corresponding healthy/fault setting. Validate that kind and fault agree, and that only the fixed Redis intervention is allowed. Node runtime/snapshot identity is observed/checked separately, never trusted solely because input.json says so.

Private controller routes:

- `POST /control/reset` with `{}`: clear counters/traces only when all warmup work and queues are settled; otherwise return 409. Seeded store state is also cleared before measured traffic.
- `POST /control/fault` with `{ "mode": "healthy" }` or `{ "mode": "redis_latency", "delayMs": 3000, "durationMs": 10000 }`: acknowledge effective mode and monotonic activation time. Requests entering during the active fault retain their assigned 3,000 ms delay even if the fault window expires before they finish.
- `GET /control/snapshot`: bounded raw server/client spans, gate counters, fault witnesses, and runtime/controller metadata. Exclude control/health requests from business metrics.
- `POST /control/shutdown`: graceful process exit after the harness has collected output. Harness still enforces process termination in `finally`.

Health readiness deadline is 10 seconds with 100 ms polling. After warmup, allow up to 3 seconds for zero active/queued work before reset; an unexpected failure is a harness error. Reset is followed by fault/healthy acknowledgement, then the first measured traffic tick. Warmup/readiness/control data never enter measured percentiles.

Output files:

```text
out/trial.json           # normalized report, schemaVersion=1, identity + metrics + client counts + validity
out/spans.jsonl          # bounded raw RequestSpan records
out/fault-witness.json  # applied mode/window + actual delayed business/canary request span IDs
out/runtime.json        # actual node version, bundle/workload hashes, trial timestamps
out/terminal.log        # capped human-readable phase/error log
```

`trial.json` contains payload-observable `TrialTelemetry` fields. Backend adds/overrides provider-owned `sandboxId`, `cleanupStatus`, artifact IDs, and canonical execution mode; payload cannot assert those. Hash/report identity mismatch rejects the report before graph import. `runTrial` exit 0 means it produced a complete valid-format measurement, even if service requests failed; nonzero means a harness/process/report failure. The backend validates both exit status and report content.

Cap raw spans at 3,000 records per trial, which exceeds this workload's expected trace volume. If the cap is exceeded, report overflow and mark validity inconclusive; do not silently drop the evidence needed to infer a cascade. Keep the existing report/log byte limits. Runtime files/spans are separate from SSE messages.

### C. Exact workload and acceptance gates

Measure checkout launches at offsets `0, 100, ..., 9900` ms: 100 scheduled requests. Measure session, Redis canary, and Postgres canary launches at offsets `0, 1000, ..., 9000` ms: 10 each. Total scheduled launches = 130, of which 110 are user business requests. Canary Postgres writes use a separate `canary-<index>` order-ID prefix. Use one generator concurrency cap across all launches.

Client counters are computed from completed/explicitly timed-out root generator calls. A generator timeout has no fake HTTP status, counts as one error, and has its actual elapsed duration recorded. Do not add nested service calls to root client totals. Errors are counted once; `errorRate = errors / completed` and `null` when completed is zero. With a successful drain, completed equals started; unfinished starts become explicit timeout completions.

Use `checkoutStarted`, `checkoutCompleted`, and `checkoutErrors` in shared `clientSummary`, alongside aggregate counts, to make the checkout-specific error fraction auditable: `checkoutErrorRate = checkoutErrors / checkoutCompleted`, or null for zero completions. Export these fields before frontend integration rather than calculating a denominator from a guessed fraction of total traffic.

**Valid healthy baseline/control:** all 130 scheduled launches started and completed; zero root request errors; all six primary-channel metrics present; all six primary states HEALTHY; complete/well-formed report and matching manifest/runtime; no overflow/truncation of required evidence. A failed baseline stops scheduling. A failed matched control preserves both trials but makes the comparison inconclusive.

**Valid chaos measurement:** matching report/runtime/manifest, at least 95 started/completed checkouts, at least nine sessions and nine of each canary, no more than 5% skipped user business launches, no required-evidence overflow, and a recorded Redis delay on at least one actual checkout business trace. Healthy baseline/control requirements do not apply to chaos request success. Missing witnesses or insufficient samples make comparison inconclusive, not a service regression.

**Affected nodes:** for a valid pair, rank `HEALTHY=0`, `DEGRADED=1`, `DOWN=2`; UNKNOWN is incomparable. Include a service exactly when chaos rank is greater than control rank, and there is (a) a configured path to the injected Redis dependency and (b) a business trace linking that node's calls to an actual delayed Redis witness. For Redis itself, its primary canary degradation plus the recorded business fault witness is sufficient. No additional subjective “material degradation” rule is used.

An observed `CASCADED_TO` edge is the reverse of a configured dependency edge only if both ends are in the affected set and at least one shared business trace contains the caller/callee spans and fault witness. Keep supporting span IDs. Omit unsupported edges even if a predicted path would make the picture more dramatic.

Set `comparisonValidity=valid` only when all quality gates pass. Otherwise use `inconclusive` plus explicit `comparisonReasons`, preserve raw metrics, and leave `actualBlastRadiusIds=[]` with the UI label **not evaluated**, never **zero impact**. The run is COMPLETED for a valid pair, INCONCLUSIVE for a measured-but-invalid comparison, FAILED for infrastructure/report/persistence failure, BASELINE_FAILED for an invalid measured baseline, CANCELLED for requested cancellation, and INTERRUPTED after process loss. Analysis unavailability does not change a valid measurement's completion status.

**Local payload acceptance:** healthy gates pass, the fault is witnessed, checkout error fraction rises by at least 0.20 absolute versus control, and Payment either queues/rejects requests or has a full-slot interval of at least 500 ms. These are harness acceptance checks; if absent, fix/investigate the actual implementation rather than fabricate the expected result or relax thresholds silently. Exact five-node impact is still not a required result.

**Reproduction classification:** compare the new valid pair with the original valid pair. Use `reproduced` when affected service-ID sets are identical and both pairs have checkout error-rate increase ≥ 0.20; `partial` when the new pair has measured impact but a different affected set; `not_reproduced` when the new valid pair lacks the original impact; and `inconclusive` for failed quality gates. These are descriptive observations, not statistical confidence estimates. Add a `reproduction` summary to `RunSnapshot` with IDs of the new trial pair, this classification, and reasons; keep original metrics unchanged.

### D. Coding autonomy and escalation

Agents may choose helper functions, local variable names, CSS details, and equivalent implementations within these interfaces. They must run checks, fix compile/runtime errors, and reconcile integration mismatches autonomously. The plan is not permission to skip provider validation or report success from a fixture.

Ask the owner only when missing account access requires human action, a verified provider limitation requires a different architecture, the chosen product behavior cannot be achieved within the remaining timebox, or a substantive scope/sponsor decision would change. SDK signature corrections within the selected stable SDK family and ordinary implementation fixes do not need approval. Record exact working versions/tool schemas in integration notes and continue.
