# Claude handoff: sandbox isolation and blast-radius accuracy

## Copy/paste instruction

Read `AGENTS.md`, `spec/README.md`, and the active `spec/plan.md`, then address the review below. The product owner specifically requires that blast radius cannot silently become larger **or smaller** than the evidence supports. Prioritize measurement validity and isolation over new demo features.

Keep the six-service cascade MVP, real Daytona execution, Neo4j evidence, Nosana provenance, and bounded MCP investigation. Automatic patch application remains deferred. Do not tune the result to five affected nodes. Fix the trust/measurement boundary and demonstrate what the experiment actually measured.

Another coding process was editing/merging during this audit. Inspect current Git status and current implementations first, preserve unrelated work, and recheck each finding before changing it. Do not reset, overwrite, or commit someone else's in-progress edits. Implement fixes in the current agreed work lane or an isolated worktree and coordinate shared-schema changes. Ordinary correctness fixes are authorized; a change to service isolation architecture or product scope needs the owner.

## Review scope, evidence, and limits

- Initial executor revision: `c28ba31003ad2bee9038108d04d380ad1f63775b`.
- Remote graph/contracts/UI revision included in the temporary test snapshot: `41e223a37b3593c7ed734e2637ca93c511337f44`.
- Rechecked committed source through `8e3fc423c186097ce54d15ecd5ccf658111b7699`, including the merge and confirmed-deletion fix. Concurrent uncommitted UI/provenance changes were observed; this audit did not overwrite them.
- Review source and scratch reproductions are at `/tmp/entropy-audit-p7lpjduy` on the review machine. That directory is temporary and is not required on another teammate's machine: the cases and expected fixes are described below.
- The combined source snapshot passed typecheck and its existing **86 tests**. The two additional Daytona-provider regression tests from `8e3fc42` also passed separately. The first attempt at HTTP tests was blocked by the review environment's loopback restriction; the permitted rerun passed. That restriction is not a product defect.
- Six adversarial comparison checks, one admission-race check, and one foreign-mesh collision check reproduced the problems described below. These scratch checks assert the current incorrect behavior to demonstrate it; turn them into tests of the corrected behavior, not permanent expectations that bugs should remain.
- A real local healthy/fault HTTP pair ran on review-only ports **24100–24105 and 24199**, avoiding the developer's services. Only the scratch copy's port constants changed; both trials used the same changed workload. This proves local payload behavior, not live Daytona isolation or matched parallel execution.
- No paid Daytona/Nosana calls or live Neo4j queries were made by this review. Do not call this a completed live sponsor acceptance test.

### Actual local smoke result

| Observation | Healthy control | Redis-delay chaos |
| --- | --- | --- |
| Root launches started/completed | 130 / 130 | 130 / 130 |
| Root errors | 0 | 110 |
| Checkout errors / completed | 0 / 100 | 100 / 100 |
| Checkout p95, including errors | about 29.9 ms | about 1,206.6 ms |
| Measured affected nodes | — | Frontend, Order, Payment, Auth, Redis |
| Payment queue evidence | — | 40 queued, 84 rejected, peak 4 active / 4 queued |
| Postgres | healthy | healthy in business and canary samples |

The ordinary demo path worked. However, removing Auth's primary metric from that **same real chaos report** changed the result from five affected nodes to four while the comparator still returned `comparisonValidity: 'valid'`. That is a demonstrated understatement, not merely a theoretical concern.

## P0 — 1. Fail closed on missing/unknown/contradictory measurements

**Locations:** `shared/types.ts`: `ServiceMetricSchema`, `ClientSummarySchema`, `TrialTelemetrySchema`, `healthyQuality`, `evaluateChaosTrial`, `evaluateMatchedPairAndBlastRadius`.

**Confirmed:**

1. Remove the `auth-service/business` metric from a valid chaos report. The comparator silently skips it and returns a valid four-node affected set.
2. Replace it with a zero-sample `UNKNOWN` metric. The comparison remains valid and silently omits Auth.
3. Set every chaos metric's status to HEALTHY while retaining 100 errors out of 100 completed requests and 3,000 ms percentiles. `TrialTelemetrySchema` accepts it, and the comparison returns a valid empty affected set.
4. Conversely, DEGRADED statuses with zero errors and fast percentiles are accepted and can produce five affected nodes. Existing synthetic test fixtures themselves use inconsistent status/metric combinations; those fixtures must be corrected when validation is strengthened.

**Impact:** silent smaller radius, false zero-impact conclusions, or inflated radius from unsupported status labels.

**Required correction:**

- Exactly one primary metric per service, no duplicate `(serviceId, channel)` rows/metric IDs, and identity matching the trial.
- Unknown or missing required metrics must make the comparison inconclusive, with per-node reasons. Do not interpret absence as unaffected.
- Recompute or validate health using the same trusted classifier/thresholds as the payload. Do not trust a payload's `status` field independently of counts, latency, and gate evidence.
- Check `sampleCount == requestsCompleted`, sensible percentile ordering, empty/null consistency, counter relationships, and adequate per-channel coverage.
- Validate checkout counters against root totals and their denominators. Errors cannot exceed completions; checkout completions cannot exceed checkout starts or total completions.
- Where raw server spans are retained, reconcile counts and percentiles with them. Reject conflicting summaries. Gate metrics need an authoritative recorded source, not an unexplained status override.
- Keep `comparisonValidity=inconclusive` and a visible **not evaluated** state when evidence is insufficient; never display an empty set as confirmed zero impact in that case.

**Regression tests:** remove each of the six primary metrics in turn; set UNKNOWN; duplicate a metric; contradict status/counters; mismatch sample counts; reorder/invent percentile values; corrupt checkout totals. None may yield a valid smaller/larger radius.

## P0 — 2. Prove that the trial owns the mesh it samples

**Locations:** `backend/src/sandbox/payload/lib/trial.ts`: `startChildCluster`, `waitForReadiness`, `runTrialHarness`, final shutdown; `payload/lib/mesh.ts`: health/controller identity; `localProvider.ts`.

**Confirmed reproduction:** start an existing mesh, then start a child-mode trial on the same ports. The new child fails with `EADDRINUSE`. The harness nevertheless sees seven HTTP 200 health responses from the existing mesh, warms it, resets its counters/stores, runs the workload, and sends its shutdown controller a request. It returns a valid healthy report. The recorded mesh PID is the foreign mesh PID, not a successfully started child. Evidence: scratch `audit-results/collision-summary.json` and terminal log.

**Impact:** a “fresh sandbox/trial” may actually sample old state, another concurrent local trial, or a service already running in the snapshot. This can inflate, shrink, or invalidate the entire measured radius. Controller reset/shutdown can also affect a process the trial did not create.

**Required correction:**

- Generate an instance nonce tied to run/trial IDs and pass it to the child through a non-secret trusted input.
- Verify the matching identity on every service/controller readiness response and snapshots. Verify the expected child is alive; reject spawn errors/early exit immediately.
- Bind failure must be a harness failure. Never proceed simply because some server on the port answers 200.
- Controller reset/fault/shutdown must require the owned instance identity. Do not send cleanup commands to a server whose ownership has not been proven.
- Prefer an instance-specific dynamic port map for local tests or a process-wide/cross-process lock; choose an implementation that preserves explicit development labeling. A local working directory alone is not an isolation boundary.

**Regression test:** an owned foreign mesh occupying the ports must remain unchanged/alive while the attempted second trial fails. No report from the failed child may be accepted; reset/fault/shutdown must not reach the foreign instance.

## P0 — 3. Required artifacts and trace ancestry are not currently required

**Locations:** `shared/types.ts`: `requiredEvidenceIsComplete`, witness/edge helpers; `backend/src/evidence/collect.ts`; `backend/src/sandbox/trialRunner.ts`: `validateReport`.

**Confirmed:** `requiredEvidenceIsComplete` only rejects some `truncated` flags. An empty artifact array or required artifacts with `available:false, truncated:false` pass. The runner fails on missing metrics/runtime bytes, but missing raw spans/fault-witness files become warnings while `trial.json`'s own witness/status assertions can still be accepted. Existing fake-provider tests write an empty spans file and `{}` witness file despite a reported cascade.

The witness helpers also rely on service names and a common trace ID. They do not consistently require a Redis **server** span, parent/child continuity, matching controller witness data, or measured fault duration. A client record with `faultApplied` can currently qualify as a witness.

**Impact:** a radius can be presented as causally supported even when required evidence is unavailable or the spans are unrelated records sharing a trace ID.

**Required correction:**

- Require all four evidence kinds: metrics, spans, fault_witness, runtime. They must be available, untruncated, within bounds, and parseable with the correct run/trial identity.
- Verify actual collected bytes, not only metadata. Hash/check agreement between raw spans, report summaries, witness span IDs, and fault/controller configuration/window.
- A Redis witness must be a receiving/server business span linked to an actual checkout chain and a recorded applied delay. Reject orphaned/dangling/duplicate IDs and mismatched traces.
- Construct observed edges from actual parent/child client/server relationships, not trace-ID coincidence alone. A trace's presence does not prove every sibling branch was affected by this fault.
- Treat exact cap exhaustion via an explicit overflow flag/counter. `spans.length < 3000` currently marks an exactly complete 3,000-record report incomplete even when nothing overflowed; do not conflate full capacity with lost data.

**Regression tests:** missing/unavailable artifact of each kind; empty witness JSON; raw/report disagreement; canary-only witness; client-only witness; wrong parent IDs; same trace on an unrelated branch; 3,000 complete records vs a real overflow. These must not produce false cascade edges or silent smaller radius.

## P1 — 4. Unfinished handlers can disappear from tail latency

**Locations:** `payload/lib/trial.ts`: `waitForServerSettle`, `runTrialHarness`; `payload/lib/metrics.ts`: `aggregateServiceMetric`; shared quality gates.

**Code-path finding and adversarial confirmation:** after the settle timeout, the harness only logs/warns that handlers are still running. Receiving spans are stored only after handlers finish. Aggregation ignores incomplete handlers; a metric with substantially more starts than completions is accepted and can still produce a valid comparison. Scratch validation accepted 1,000 starts with only the smaller completed set.

**Impact:** the slowest requests disappear from service p95/p99, making impact look smaller or even healthy. Root-client timeouts are handled separately and do not repair missing service latency evidence.

**Required correction:** explicit incomplete/right-censored request accounting. A still-running request must not be silently absent from the sample population. For this MVP, marking the relevant trial/comparison inconclusive is acceptable and simpler than inventing completed durations. Expose started/completed/in-flight counts and censoring reasons. A socket-disconnected but eventually completed handler should remain distinguishable from an unobserved handler.

**Regression test:** deliberately keep a handler alive past collection while other requests finish fast. It must not produce a valid healthy service metric or deceptively low complete p99.

## P1 — 5. Scheduled workload can become a burst or outlive the fault

**Locations:** `payload/lib/traffic.ts`: `runMeasuredWorkload`; `payload/lib/mesh.ts`: fault activation/expiry; `payload/lib/trial.ts`: ack/start/collection.

**Code-path finding, not a live-provider measurement:** overdue launches run immediately in the loop, so event-loop stalls can turn intended 10 rps traffic into catch-up bursts. The report drops the root samples' scheduled-vs-actual launch offsets and has no lateness validity gate. The Redis fault's 10-second clock starts before traffic starts; delayed launches or queued dependency calls can arrive after it expires, reducing actual exposure. Only one checkout witness is needed for a nominally valid chaos trial.

**Impact:** launch bursts can inflate queue saturation/radius; missed fault coverage or observer scheduling delays can understate it. Fixed workload hashes alone do not prove the same realized workload.

**Required correction:**

- Persist scheduled offsets, actual launch offsets, maximum/p95 launch lag, missed ticks, achieved arrival rate, fault activation/expiry, and per-channel delayed/undelayed exposure counts.
- Define and document a deterministic lateness policy and comparability gate. Do not silently catch up arbitrarily late requests or select new thresholds to recover the desired picture.
- Align the intended measured window and controller fault window via an acknowledged start protocol. A 10-second pulse need not delay every later queued call, but that exposure must be visible; do not label it sustained/fully exposed traffic.
- Record actual measured-window intervals/barrier release; SDK command overlap alone includes startup/warmup and is not proof that measured windows overlapped.

**Regression tests:** introduce a controlled generator scheduling stall and a delayed controller acknowledgement. Report changed realized traffic/coverage and reject invalid comparisons rather than confidently showing a larger/smaller radius.

## P1 — 6. Claimed runtime/image identity is partly configuration text

**Locations:** `scripts/preparePayload.ts`; `sandbox/payloadManifest.ts`; `sandbox/daytonaRunner.ts`: `create`; `sandbox/trialRunner.ts`: `prepare`, `validateReport`.

**Code-path finding:** manifests may use the literal `daytona-default-snapshot` or a mutable snapshot name. The runner creates with current provider configuration and constructs `runtimeIdentity` using `manifest.sandboxImage`, not verified metadata from the created sandbox. A prepared payload claiming image A can run under provider configuration B while being labeled A. Runtime preparation accepts any Node major ≥22, and CPU/RAM/image identity are not observed/pinned as a matched environment.

`preparePayload` also computes topology/workload hashes using current working-tree helper imports while bundling the archived source. Rebuilding an older revision after local constant changes can create a manifest that does not describe the archived bundle correctly; the payload may fail its own workload check.

**Impact:** environment differences can change bottlenecks and queue behavior, and reproductions can appear comparable when they are not. Wrong historical hash generation can prevent a valid reproduction entirely.

**Required correction:**

- Resolve/pin the actual immutable snapshot/image identity and resource configuration, and record observed provider metadata, Node version, platform/architecture, and requested-vs-observed values separately.
- Reject mismatches before comparing/reproducing. Do not substitute the manifest's claimed identity for observation.
- Compute manifest constants/topology/workload from the same frozen source tree that produced the payload.
- Reject a `development:true` bundle in live acceptance mode; a warning alone must not allow uncommitted payloads to be represented as a recorded source revision. Keep development provenance in explicit DTO fields and a persistent UI banner.

**Regression tests:** prepare under A/run under B; change provider snapshot or resources; rebuild an old source after editing current constants; request a development bundle in live mode. No false identity match is acceptable.

## P1 — 7. Concurrent admission is not atomic

**Locations:** `agent/orchestrator.ts`: `startRun`, `begin`, `active`; similar async admission paths for other actions.

**Confirmed:** delay `repository.createRun` with a barrier until two requests with different keys reach it. Both pass `assertSchedulable` while `active` is empty, then both return accepted run IDs and call `begin`. The second overwrites the one active-workflow handle. Scratch test accepted both requests although the product contract permits one workflow.

**Impact:** overlapping campaigns, lost cancellation/shutdown ownership, unexpected resource contention, and misleading BUSY/active state. The sandbox cap helps but does not fix admission correctness.

**Required correction:** atomic admission/mutex or a reservation set before the first await, with release on every failure. Preserve idempotency replay without creating orphan run/operation records. Ensure one owner covers admission through completion, cancellation, and shutdown.

**Regression test:** simultaneous different-key starts accept one and reject the other with 409. Same-key concurrent requests return one run. Include run vs reproduction/diagnostic races; all active jobs remain cancellable.

## P1 — 8. Close ambiguous-create and host-process isolation gaps

**Locations:** `sandbox/trialRunner.ts`: `createWithReconciliation`; `agent/diagnosticAgent.ts`: create/finally; `scripts/doctor.ts`; `agent/orchestrator.ts`: `recover`; `sandbox/localProvider.ts`.

**Code-path findings to reproduce before patching:**

- A create timeout is followed by one immediate list; if no resource is visible yet, retry can leave a later-created first sandbox orphaned. Extra adopted sandboxes' cleanup failures are not consistently reserved/recorded.
- Diagnostic create has no corresponding ambiguous-create reconciliation and does not use the orchestrator's allocation counter. If creation succeeds remotely but the response times out, the local `sandboxId` stays undefined and its reservation can be released.
- Doctor only cleans successfully returned handles; restart cleanup skips label-only resources whose doctor run has no repository run record.
- Local development execution inherits the backend environment, including configured provider keys, and has host filesystem/network access. It is a subprocess, not a security sandbox. The payload is currently a fixed trusted fixture; do not broaden this path to arbitrary repositories/generated code.
- Local process-group IDs are written to disk when spawned, but are removed only from the in-memory set on exit. Later recovery blindly kills stored negative PIDs without checking process start identity. A reused process-group ID could target an unrelated host process. No destructive PID-reuse experiment was performed during review.

**Required correction:** bounded eventual reconciliation with unique attempt labels, conservative capacity while creation is ambiguous, persistence of every owned allocation/orphan, diagnostic/doctor coverage, and all create paths counted against the run limit. For local mode, scrub environment, explicitly label lack of security isolation, verify child/process-group ownership and start identity before signaling, and remove stale disk records on exit. Never “fix” cleanup by killing every Node process or every sandbox in the account.

**Regression tests:** create resolves remotely after a timeout/list delay; diagnostic and smoke create ambiguity; failed orphan deletion; restart with stale PID metadata; harmless sentinel environment variable absent from the payload. Use fakes for remote eventual-consistency cases and safe subprocesses for local ownership checks.

## P2 — 9. Make the boundary of the reported radius explicit

**Locations:** shared comparator; graph projection; UI/evidence; `spec/plan.md` measurement definitions.

- Six logical services share one process/event loop, memory space, and per-trial CPU allocation. This is the accepted mock-mesh design, not independent service/container resource isolation. It cannot validate process-kill or independent service CPU/memory blast radius.
- The affected-set algorithm requires a configured path to Redis and a shared delayed business trace. Degradation outside the declared graph, common-resource collateral effects, or queue-rejected requests that never reached the dependency can otherwise disappear from the attributed set.
- The datastore primary channel is a low-rate canary; a healthy Postgres canary does not mean checkout writes were available/attempted. Show canary health separately from business throughput/availability and suppressed calls.
- Binary health thresholds are an explicit demo definition, not a universally correct blast-radius oracle. Preserve raw deltas and no-sample states, and distinguish observed degradation from attribution to a particular fault.

**Required handling:** retain an all-service raw degradation table, an attributed fault-path set, and visible unknown/unattributed cases. Do not add unrelated degradations to “proven cascade,” and do not hide them as healthy/unaffected either. Document that accuracy is limited to this workload/observation window/mock model. If changing the plan's attribution schema, update contracts/tests/UI consistently; independent process-level isolation is a separate owner-approved scope change, not an implicit expansion of this fix.

## Already corrected during review — do not reopen blindly

- `8e3fc42` changed Daytona deletion to `client.delete(sandbox, timeoutSec, true)` and added a test. The earlier non-waiting delete could release capacity before actual destruction. Preserve the fix and verify pending/error behavior rather than filing it as still unimplemented. The documented default of `wait=false` and waiting behavior also match the installed SDK source. [Daytona lifecycle reference](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
- The remote graph/UI hardening was merged as `49455de` during review. Earlier branch divergence is no longer itself an open finding.
- UI changes were in progress to fix service/datastore labels, colors, provenance banners, and selected-pair display. Recheck current files before duplicating that work.

## Delivery and verification order

1. Reproduce/fix P0 completeness, owned-mesh identity, and required-evidence validation first. Correct synthetic test fixtures instead of weakening validation to keep existing tests green.
2. Fix P1 handler censoring, admission, runtime identity, and realized-load reporting. Address actual sandbox/host resource ownership paths.
3. Add focused regression tests for both overstatement and understatement. Include an entirely healthy no-fault negative control, legitimate partial recovery, absent telemetry, and unexpected off-path degradation.
4. Run typecheck, focused tests, build, and payload checks. Test parallelism in actual isolated Daytona sandboxes, not two fixed-port local children. Use the smallest necessary provider smoke; preserve credentials and clean resources.
5. Finish with one real matched pair: confirm source/runtime identity, realized comparable workload, independent sandbox IDs, complete evidence, graph/metric agreement, and confirmed cleanup. Do not declare live isolation verified from mock-provider tests alone.
6. Report changed files, commands/results, actual measured metrics/affected IDs, remaining limitations, and unresolved findings. Keep the active plan aligned with revised measurement contracts.

Do not replace provider errors with demo data, turn unknown into healthy, disable failing accuracy tests, lower thresholds to recover five red nodes, or apply arbitrary model-generated patches. The objective is an honest measured result even when it is inconclusive or differs from the intended demonstration.
