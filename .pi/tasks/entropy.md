# Entropy — Lane B Task Breakdown & DAG (`spec/plan.md`)

Active spec: `/Users/jeya/Personal/Entropy/spec/plan.md`

## LB1: Shared Zod Contracts, Fixtures & Workspace Alignment
- **Depends on**: none
- **Files**:
  - `package.json`
  - `tsconfig.base.json`
  - `.env.example`
  - `shared/package.json`
  - `shared/tsconfig.json`
  - `shared/types.ts`
  - `backend/package.json`
  - `backend/tsconfig.json`
  - `frontend/package.json`
  - `frontend/tsconfig.json`
  - `frontend/vite.config.ts`
- **Description**: Align workspace packages (`shared`, `backend`, `frontend`) with `spec/plan.md` Section 2, 3, 7, and 16. Install `zod`, `@xyflow/react`, `vitest`. Implement all Zod schemas, inferred TypeScript types, internal service interfaces (`GraphRepository`, `NosanaClientContract`, `OrchestratorContract`), pure comparison/blast-radius calculation helpers (Section 16.C), and explicitly labeled development fixtures in `shared/types.ts`. Proxy `/api` to `127.0.0.1:3001` in `frontend/vite.config.ts`.
- **Status**: in review

## LB2: Neo4j Topology, Risk Retrieval & Evidence Repository
- **Depends on**: LB1
- **Files**:
  - `backend/src/graph/neo4jClient.ts`
  - `backend/src/graph/neo4jClient.test.ts`
- **Description**: Implement `Neo4jGraphRepository` (`spec/plan.md` Section 7, 9, 16.C) using `neo4j-driver`. Include `ensureSchema` (uniqueness constraints on `Service`/`Datastore` `key`, `EntropyRun`/`EntropyTrial`/`EntropyMetric`/`EntropyHypothesis`/`EntropyAnalysis`/`EntropyDiagnostic`/`EntropyOperation` `id`), `seedTopology` (6-node template with `entropy:template:<topologyHash>:<serviceId>`), `createRun` (cloning 6 run-scoped nodes `entropy:<runId>:<serviceId>`), `retrieveRiskContext` (parameterized Cypher query finding inbound paths to `redis-cache`), `saveHypothesis`, `updateRun`, `saveTrial` (atomic managed transaction with deterministic metric IDs `<trialId>:<serviceId>:<channel>`), `saveComparison` (computing `actualBlastRadiusIds` and observed `CASCADED_TO` edges strictly from valid control vs. chaos measurements and delayed Redis witnesses), `saveAnalysis`, `appendEvent` (serialized per-run bounded 250-event log), `getRun`, `listRuns`, `getEventsAfter`, `getGraph`, `saveDiagnostic`, `getDiagnostic`, `findUnfinishedResources`, and `claimOperationKey`. Convert Neo4j Integer/temporal objects to plain JSON.
- **Status**: in review

## LB3: Nosana Hypothesis, Evidence Analyst & Diagnostic Action Client
- **Depends on**: LB1
- **Files**:
  - `backend/src/agent/nosanaClient.ts`
  - `backend/src/agent/nosanaClient.test.ts`
- **Description**: Implement `NosanaClient` (`spec/plan.md` Section 7, 10, 11) using native `fetch` with Bearer auth against `NOSANA_BASE_URL` (`/chat/completions`). Include 30s timeout, bounded output tokens, at most one enclosing Markdown fence stripping, strict Zod validation, at most one repair request, and at most one transient retry. Implement `hypothesize(riskContext)` (attaching fixed server `cypherQueryUsed` and falling back to explicitly labeled `catalogue_fallback` when unavailable/invalid), `analyze(validatedEvidence)` (capping prompt input ~12 KiB, validating every referenced `metricId` and `spanId` against supplied measurements, preserving `status: 'unavailable'` on failure), and `nextDiagnosticAction(context)` (returning validated `DiagnosticAction` for the post-run Daytona MCP loop).
- **Status**: in review

## LB4: React + `@xyflow/react` Mission Control Dashboard
- **Depends on**: LB1
- **Files**:
  - `frontend/src/main.tsx`
  - `frontend/src/index.css`
  - `frontend/src/api.ts`
  - `frontend/src/App.tsx`
  - `frontend/src/components/TopologyGraph.tsx`
  - `frontend/src/components/HypothesisCard.tsx`
  - `frontend/src/components/TrialComparison.tsx`
  - `frontend/src/components/EvidenceDrawer.tsx`
  - `frontend/src/components/DiagnosticDrawer.tsx`
  - `frontend/src/components/TerminalFeed.tsx`
- **Description**: Build the dark neutral developer-tool dashboard (`spec/plan.md` Section 8, 12, 13) using React, `@xyflow/react`, and plain CSS. Include top header (source revision, sponsor connection status, Run Experiment with UUID `Idempotency-Key`, Cancel, Reproduce, Investigate, Saved Runs selector, URL `?runId=` persistence, and explicit Development Fixture mode banner when viewing labeled fixtures), `TopologyGraph.tsx` (6-node deterministic column layout with configured edges, dashed predicted path, and observed cascade overlays + node selection), `HypothesisCard.tsx` (predicted path, collapsible Cypher inspector, provenance), `TrialComparison.tsx` (Baseline/Control/Chaos/Cleanup cards, checkout error fraction, p95 with failures, sample count N, small-sample warnings, Payment queue pressure, original vs reproduction selector), `EvidenceDrawer.tsx` (selected-node metrics, queue counters, span IDs, artifact viewer, Nosana explanation & remediation advice with limitations), `DiagnosticDrawer.tsx` (Daytona MCP tool trace), and `TerminalFeed.tsx` (escaped logs + SSE reconnection with `Last-Event-ID` & snapshot resync).
- **Status**: in review

## LB5: Lane B Verification, Tests & Documentation
- **Depends on**: LB2, LB3, LB4
- **Files**:
  - `docs/integrations.md`
  - `docs/demo.md`
  - `shared/types.test.ts`
- **Description**: Add unit tests for shared contracts, comparison/blast-radius gate rules (Section 14 & 16.C), Neo4j repository, and Nosana client; verify `tsc --noEmit`, `vitest run`, and `vite build` across `shared`, `backend`, and `frontend`; write Lane B sections of `docs/integrations.md` and `docs/demo.md`.
- **Status**: not started
