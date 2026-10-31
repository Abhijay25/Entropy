# Three-minute live demo

## Before the audience arrives

1. Complete the integration gate in [integrations.md](integrations.md): `doctor`, migrations, local payload checks, and a committed payload revision.
2. Run `npm run prepare:payload -- FULL_SHA`. Keep the source revision, payload/workload hashes, and selected model available.
3. Start the app with `npm run dev`; the API is on port 3001 and Vite is on port 5173.
4. Confirm sponsor statuses are real and that quota permits two Daytona sandboxes. Do not present development fixtures as live providers.
5. Confirm the **Run Experiment**, **Cancel**, **Reproduce**, and **Investigate** controls have their expected enabled state. Keep the **Load Labeled Dev Fixture** toggle off for a live demo.
6. Keep Neo4j Browser open with the verification queries below. Have a redacted exported run or screenshots available only as **recorded run** backup, preserving original timestamps.

Never claim a fixed number of affected nodes, a guaranteed p99 improvement, or self-healing. The controlled claim is: “We predicted a dependency path might amplify a delay; the matched experiment and traces show what happened under the same load.”

## Live path (about three minutes)

### 0:00-0:20 - orient

Open Entropy. Point out the six-node graph, source revision, and the real Neo4j, Nosana, Daytona, and MCP statuses. Explain that Redis and Postgres are explicit HTTP mocks in a controlled payload, not production infrastructure.

State the experiment boundary: the sole executable fault is a 3,000 ms Redis latency spike for 10 seconds. Authentication remains fail-closed. The dashboard predicts a path; it does not mark a predicted node as degraded.

### 0:20-0:45 - retrieve and predict

Click **Run Experiment**. The Hypothesis card shows the retrieved Redis path. Open its collapsible **Inspect fixed Cypher query** control and show the server-owned query. The expected dependency direction for the prediction is Redis -> Auth -> Payment -> Order -> Frontend.

Call out the hypothesis source/model and exact allowed fault. Explain that the server attaches the ID and fixed Cypher; the model cannot submit Cypher, commands, alternate fault parameters, or observed results. If the card says `catalogue_fallback`, say so explicitly and do not describe it as live inference.

### 0:45-1:35 - measure, do not infer

Show the healthy baseline first. Then show control and chaos provisioning/running in parallel from the same immutable payload, workload, source revision, and runtime identity. In **Trial Comparison**, point out each trial ID, actual sandbox ID, stage, and cleanup state.

When trials finish, compare:

- checkout error fraction and its completed-request denominator;
- p95 including failed request durations and sample count;
- channel-specific service status (business for services, canary for datastore mocks);
- Payment active-slot, queue, and rejection/saturation measurements;
- Redis business fault witnesses and supporting request spans.

Describe only measured facts. A bad control, generator cap limitation, missing witness, or insufficient samples is **inconclusive**, not zero impact and not a fabricated cascade.

### 1:35-2:05 - inspect the graph and explanation

Select an affected node. In the **Evidence Drawer**, show control/chaos counts, raw latency data, queue evidence, artifacts, and linked span IDs. Explain the legend: configured edges point caller -> dependency; an observed `CASCADED_TO` overlay reverses that direction (degraded dependency -> affected caller) and exists only with supporting business-span evidence.

Show the Nosana evidence analysis separately from facts. Its hypotheses cite persisted metric/span IDs; remediation is proposed advice with limitations, not an apply-patch action. If analysis is unavailable, show the preserved metrics and the unavailable state instead of substituting prose.

### 2:05-2:35 - reproduce

Click **Reproduce** on the completed run. This makes a new matched control/fault pair and preserves the original evidence. In **Trial Comparison**, switch between original and reproduction pairs, show the new trial IDs and matching manifest identity, then state the classification (`reproduced`, `partial`, `not_reproduced`, or `inconclusive`). Do not overwrite or relabel the original result.

### 2:35-3:00 - diagnose and close

Click **Investigate**. In the **Diagnostic Drawer**, show that it uses a distinct diagnostic sandbox, uploads sanitized evidence, and records the discovered Daytona MCP evidence-read tool, timing, and redacted result. The optional auth probe is not a statistical re-run.

Close with the recorded cleanup result: “The original run, reproduction, diagnostic trace, evidence IDs, and sandbox cleanup state are persisted. The graph distinguishes the predicted path from the measured result.”

## Timing and overrun plan

A real baseline plus matched Daytona trials can exceed the speaking clock because provisioning, queueing, and cleanup are external. Keep the live narration to the first minute and narrate progress from **Trial Comparison** rather than waiting silently. If the run is still active at 1:35, show the saved run ID, source/workload identity, sandbox stages, and Neo4j query; continue to a previously captured **recorded run** only after labeling it with its original timestamp. If a provider fails, show its explicit unavailable state and the preserved measured facts. Do not turn on **Load Labeled Dev Fixture** as a substitute for a live error.

## User journey reference

The dashboard supports this sequence:

1. View the six-node dependency graph, source revision, and sponsor connection statuses.
2. Use **Run Experiment** to generate the bounded hypothesis from Neo4j context.
3. Use the Hypothesis card's collapsible Cypher inspector to view the predicted Redis -> Auth -> Payment -> Order -> Frontend path and source query.
4. Follow baseline, then parallel matched control/chaos trials in **Trial Comparison**, including their trial IDs.
5. Compare checkout errors, p95, service states, and Payment queue evidence.
6. Open the **Evidence Drawer** for the observed affected graph, counts, traces, latency samples, and artifacts.
7. Read the Nosana explanation while keeping facts, hypotheses, and remediation distinct.
8. Reproduce with a fresh pair or investigate through the **Diagnostic Drawer** and Daytona MCP.
9. Inspect sandbox IDs, cleanup state, sample counts, and recorded/live provenance after refresh.
10. Use **Load Labeled Dev Fixture** only to demonstrate the explicitly labeled fixture state, never to hide a live API failure.

## Neo4j Browser verification

Substitute the real IDs shown by the run. Queries are inspection only; do not paste model output into Neo4j Browser.

### Find the selected run and its trials

```cypher
MATCH (run:EntropyRun {id: $runId})-[:HAS_TRIAL]->(trial:EntropyTrial)
RETURN run.id, run.status, trial.id, trial.kind, trial.status,
       trial.sandboxId, trial.cleanupStatus, trial.sourceSha,
       trial.payloadHash, trial.workloadHash
ORDER BY trial.kind, trial.id;
```

### Inspect the copied configured topology

```cypher
MATCH (run:EntropyRun {id: $runId})
MATCH (source)-[edge:CALLS|READS|WRITES|VERIFY_TOKEN]->(target)
WHERE source.key STARTS WITH 'entropy:' + $runId + ':'
  AND target.key STARTS WITH 'entropy:' + $runId + ':'
RETURN source, edge, target;
```

### Inspect risk paths used for a run

```cypher
MATCH p=(source:Service)-[:CALLS|READS|VERIFY_TOKEN*1..5]->(redis:Datastore)
WHERE redis.key = $redisKey
  AND all(node IN nodes(p) WHERE node.projectId = $projectId AND node.scope = $scope)
RETURN [node IN nodes(p) | node.id] AS path,
       [edge IN relationships(p) | {type: type(edge), timeoutMs: edge.timeoutMs}] AS edges
ORDER BY size(path) DESC
LIMIT 10;
```

### Compare persisted control and chaos metrics

```cypher
MATCH (run:EntropyRun {id: $runId})-[:HAS_TRIAL]->(control:EntropyTrial {id: $controlTrialId})
MATCH (run)-[:HAS_TRIAL]->(chaos:EntropyTrial {id: $chaosTrialId})
MATCH (control)-[:HAS_METRIC]->(controlMetric:EntropyMetric)-[:OF_SERVICE]->(service)
MATCH (chaos)-[:HAS_METRIC]->(chaosMetric:EntropyMetric)-[:OF_SERVICE]->(service)
RETURN service.id, controlMetric.channel, controlMetric.status,
       controlMetric.requestsCompleted, controlMetric.errorsTotal,
       controlMetric.latencyP95Ms, chaosMetric.status,
       chaosMetric.requestsCompleted, chaosMetric.errorsTotal,
       chaosMetric.latencyP95Ms
ORDER BY service.id, controlMetric.channel;
```

### Verify observed overlays and their evidence

```cypher
MATCH (dependency)-[edge:CASCADED_TO {trialId: $chaosTrialId}]->(affected)
RETURN dependency.id, affected.id, edge.trialId, edge.supportingSpanIds;
```

An absent overlay is not proof of no impact. It may reflect an inconclusive comparison or missing supporting business traces. Conversely, predicted IDs alone must not appear as observed overlays.

### Verify saved analysis and diagnostic trace

```cypher
MATCH (run:EntropyRun {id: $runId})-[:HAS_ANALYSIS]->(analysis:EntropyAnalysis)
OPTIONAL MATCH (run)-[:HAS_DIAGNOSTIC]->(diagnostic:EntropyDiagnostic)-[:HAS_ANALYSIS]->(diagnosticAnalysis:EntropyAnalysis)
RETURN analysis, diagnostic, diagnosticAnalysis;
```

## Reproduction and MCP walkthrough

**Reproduction** is available only after an original terminal measured run. It reserves the bounded workflow, creates a fresh matched control/fault pair from the same immutable payload, and saves the new pair alongside - not over - the original. Compare affected service-ID sets and checkout error-rate increase only when both pairs satisfy their quality gates.

**Investigation** is available only after terminal evidence exists. It uses one separate sandbox and uploads sanitized `.entropy-diagnostic/evidence.json` with original metrics, selected spans, graph paths, artifact IDs, and allowed service IDs. The diagnostic can perform at most two discovered MCP calls and three model turns in three minutes. It maps `read_evidence` and optional `probe_auth` to fixed templates. A final `finish` must cite real metric/span IDs. Tool output is untrusted and displayed redacted.

A valid live diagnostic includes an actual MCP evidence-read call, final evidence-grounded explanation, stored trace, and cleanup. A no-tool explanation is labeled as such and does not satisfy the live acceptance gate.

## Troubleshooting

| Symptom | Check and safe response |
| --- | --- |
| Provider status unavailable | Run `npm run doctor`; identify the exact missing key, account access, model, quota, or CLI login. Do not silently switch providers. |
| Nosana has no usable model | Re-run model discovery, select an account-available model, save `NOSANA_MODEL`, then repeat the short JSON smoke call. |
| Nosana returns malformed/fenced output | The backend permits one fence and one repair request. Confirm the fallback/unavailable state after failure; do not execute or hand-edit model output. |
| Neo4j migration/connection fails | Verify URI, credentials, database, network access, then run `RETURN 1` and `npm run db:migrate`. Do not delete historical graph data to “reset” a run. |
| Baseline fails | Stop the experiment. Inspect bounded reports, health/readiness, auth behavior, source/runtime/workload identity, and generator limits before retrying. |
| Control and chaos did not overlap | Check Daytona quota, `ENTROPY_MAX_SANDBOXES`, snapshot availability, and run timestamps. A serialized development run must be labeled; do not claim parallel isolation. |
| No measured Redis witness | Treat the comparison as inconclusive. Check the chaos controller acknowledgement and business (not only canary) spans. |
| Payment saturation not observed | Show the actual counters and do not claim it. Inspect the gate, queue capacity, request deadlines, and load schedule. |
| Analysis has invented IDs | Validation must reject it. Preserve measured facts and show the deterministic unavailable state after the bounded repair attempt. |
| MCP starts but tool calls fail | Re-authenticate Daytona CLI, re-discover `listTools` schemas, verify the recorded mapping/path, and handle both thrown errors and `isError`. Never guess a tool name or command. |
| Sandbox cleanup failed | Keep the failure visible, reconcile Entropy labels/IDs, then run `npm run cleanup`. Do not release capacity or claim cleanup until deletion is confirmed. |
| Browser refresh/disconnect | Reload the persisted run snapshot and SSE events. Browser disconnect must not cancel backend work. |
| Unknown token behavior | Run the local auth check with an unknown token. It must remain a 401 `AUTH_DENIED` under healthy and fault modes; do not demonstrate an unsafe auth fallback. |
| Provider-error state | Deliberately use a development-only provider error check. The UI must show Nosana unavailable with preserved facts, never fixture prose presented as live evidence. |
| Cancel and restart | Cancel a development run, restart the backend, then verify queued work stopped, interrupted records remain visible, completed runs reload, and resource reconciliation/cleanup is recorded. |

## Final acceptance checklist

Before calling the presentation live, confirm all Section 14 checks: real provider `doctor` checks; local healthy/load/fault behavior; unknown-token 401 auth failure; immutable payload identity; baseline followed by overlapping control/chaos; Redis business witness; graph states backed by persisted metrics; failure durations included in latency; validated Nosana evidence links and a truthful provider-error unavailable state; a new reproduction pair; a real MCP evidence-read trace; cancel and restart recovery; and no orphaned Entropy sandboxes.
