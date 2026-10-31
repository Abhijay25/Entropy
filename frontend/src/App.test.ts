// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIGURED_TOPOLOGY, DEV_FIXTURE_BANNER, DEV_FIXTURE_DIAGNOSTIC_SESSION, DEV_FIXTURE_RUN_SNAPSHOT } from '@entropy/shared';
import type { DependencyEdge, RunSnapshot, TrialKind, TrialStatus } from '@entropy/shared';
import App, { REPRODUCTION_WAIT_TIMEOUT_MS, clearDiagnosticForRunSwitch, createTrailingRefreshScheduler, hasReproduction, hasReproductionWaitExpired, isReproductionBusy, isReproductionSettled, liveStateAfterFixture } from './App';
import { api } from './api';
import { EvidenceDrawer } from './components/EvidenceDrawer';
import { TerminalFeed } from './components/TerminalFeed';
import { flowEdge, predictedEdges } from './components/TopologyGraph';
import { isSmallCheckoutSample } from './components/TrialComparison';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const edge = (evidenceKind: DependencyEdge['evidenceKind']): DependencyEdge => ({ id: `edge-${evidenceKind}`, source: 'auth-service', target: 'redis-cache', relationship: 'READS', evidenceKind, circuitBreaker: false, supportingSpanIds: [] });
const trial = (kind: TrialKind, status: TrialStatus, id = `${kind}-${status}`) => ({ ...DEV_FIXTURE_RUN_SNAPSHOT.trials[0]!, id, kind, status, executionMode: 'daytona' as const });
const snapshotWith = (trials: Array<ReturnType<typeof trial>>, reproduction?: RunSnapshot['reproduction'], status: RunSnapshot['status'] = 'COMPLETED'): RunSnapshot => ({ ...DEV_FIXTURE_RUN_SNAPSHOT, status, trials, ...(reproduction ? { reproduction } : {}) });

class FakeEventSource {
  static readonly CLOSED = 2; static instances: FakeEventSource[] = [];
  readyState = 1; onopen?: () => void; onmessage?: (event: Event) => void; onerror?: () => void;
  listeners = new Map<string, EventListener[]>();
  constructor(public readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, data: unknown) { const event = new MessageEvent(type, { data: JSON.stringify(data) }); (this.listeners.get(type) ?? []).forEach((listener) => listener(event)); }
  close() { this.readyState = FakeEventSource.CLOSED; }
}
let containers: HTMLDivElement[] = []; let roots: Root[] = []; let root: Root | undefined;
function mount(element: ReturnType<typeof createElement>) { const container = document.createElement('div'); document.body.appendChild(container); const created = createRoot(container); root = created; containers.push(container); roots.push(created); act(() => created.render(element)); return container; }
beforeEach(() => { FakeEventSource.instances = []; containers = []; roots = []; vi.stubGlobal('EventSource', FakeEventSource); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); window.history.replaceState({}, '', '/'); });
afterEach(() => { act(() => roots.forEach((item) => item.unmount())); containers.forEach((item) => item.remove()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dashboard controllers and mounted components', () => {
  it('styles flow edges and only creates predicted overlays for configured links', () => {
    expect(flowEdge(edge('observed')).className).toContain('observed');
    expect(predictedEdges(DEFAULT_CONFIGURED_TOPOLOGY, ['redis-cache', 'auth-service'])).toHaveLength(1);
    expect(predictedEdges(DEFAULT_CONFIGURED_TOPOLOGY, ['redis-cache', 'postgres-db'])).toHaveLength(0);
  });
  it('clears fixture state and diagnostics when switching runs and checks small-sample threshold', () => {
    expect(liveStateAfterFixture()).toEqual({ snapshot: undefined, graph: undefined, diagnostic: undefined });
    expect(clearDiagnosticForRunSwitch('run-a', 'run-b')).toBeUndefined();
    expect(isSmallCheckoutSample(19)).toBe(true); expect(isSmallCheckoutSample(20)).toBe(false);
  });
  it('keeps a trailing refresh and settles mixed reproduction states', async () => {
    vi.useFakeTimers(); const refresh = vi.fn(async () => {}); const scheduler = createTrailingRefreshScheduler(refresh, 700);
    scheduler.schedule(); scheduler.schedule(); await vi.runAllTimersAsync(); expect(refresh).toHaveBeenCalledTimes(2);
    const mixedFailed = snapshotWith([trial('reproduction-control', 'COMPLETED'), trial('reproduction-chaos', 'FAILED')]);
    expect(isReproductionSettled(mixedFailed)).toBe(true); expect(isReproductionBusy(true, mixedFailed)).toBe(false); expect(hasReproduction(mixedFailed)).toBe(true);
    expect(hasReproductionWaitExpired(1_000, 1_000 + REPRODUCTION_WAIT_TIMEOUT_MS, ['rep-1'], DEV_FIXTURE_RUN_SNAPSHOT)).toBe(true);
  });
  it('expires reproduction wait deadline after 90s even while 2s snapshot polling updates snapshot', async () => {
    vi.useFakeTimers(); window.history.replaceState({}, '', '/?runId=fixture-run');
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('/reproduce')) return new Response(JSON.stringify({ reproductionId: 'rep', trialIds: ['rep-1'] }), { status: 202 });
      if (input.includes('/api/runs/fixture-run')) return new Response(JSON.stringify(snapshotWith([trial('baseline', 'COMPLETED')])));
      if (input.includes('/api/runs')) return new Response(JSON.stringify([{ id: 'fixture-run', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'a'.repeat(40) }]));
      if (input.includes('/api/topology')) return new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY));
      return new Response(JSON.stringify([]));
    }));
    const host = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    const reproduceButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Reproduce')!;
    await act(async () => { reproduceButton.click(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPRODUCTION_WAIT_TIMEOUT_MS + 2_000); });
    expect(host.textContent).toContain('reproduction wait deadline expired (rep-1)');
  });
  it('polls terminal run across ticks until snapshot.reproduction arrives, then stops polling, and clears fixture/empty-run state', async () => {
    vi.useFakeTimers(); window.history.replaceState({}, '', '/?runId=fixture-run');
    let reproduced = false; let runRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('/reproduce')) return new Response(JSON.stringify({ reproductionId: 'rep', trialIds: ['c1', 'c2'] }), { status: 202 });
      if (input.includes('/api/runs/fixture-run')) { runRequests += 1; return new Response(JSON.stringify(reproduced ? snapshotWith([trial('reproduction-control', 'COMPLETED', 'c1'), trial('reproduction-chaos', 'COMPLETED', 'c2')], { controlTrialId: 'c1', chaosTrialId: 'c2', classification: 'reproduced', reasons: [] }) : snapshotWith([trial('baseline', 'COMPLETED')]))); }
      if (input.includes('/api/runs')) return new Response(JSON.stringify([{ id: 'fixture-run', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'a'.repeat(40) }]));
      if (input.includes('/api/topology')) return new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY));
      return new Response(JSON.stringify([]));
    }));
    const host = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    const reproduceButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Reproduce')!;
    await act(async () => { reproduceButton.click(); await Promise.resolve(); });
    const afterClick = runRequests;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(runRequests).toBeGreaterThanOrEqual(afterClick + 2);
    reproduced = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const settledRequests = runRequests;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(runRequests).toBe(settledRequests); expect(reproduceButton.disabled).toBe(true);
    const select = host.querySelector('select')!;
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
    expect(window.location.search).toBe('');
    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); }); expect(host.textContent).toContain(DEV_FIXTURE_BANNER); expect(host.textContent).toContain('fixture-baseline');
    await act(async () => { checkbox.click(); await Promise.resolve(); }); expect(host.textContent).not.toContain(DEV_FIXTURE_BANNER); expect(host.textContent).not.toContain('fixture-baseline'); expect(host.textContent).toContain('Select a saved run to compare measurements.');
  });
  it('restores or rejects URL diagnostics, polls active diagnostics, and polls non-terminal runs', async () => {
    vi.useFakeTimers(); window.history.replaceState({}, '', '/?runId=fixture-run&diagnosticId=wrong-diag');
    let runStatus: RunSnapshot['status'] = 'RUNNING_TRIALS'; let diagDone = false; let diagPolls = 0; let runPolls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('/investigate')) return new Response(JSON.stringify({ diagnosticId: 'diag-1' }), { status: 202 });
      if (input.includes('/api/diagnostics/wrong-diag')) return new Response(JSON.stringify({ ...DEV_FIXTURE_DIAGNOSTIC_SESSION, id: 'wrong-diag', runId: 'other-run' }));
      if (input.includes('/api/diagnostics/diag-1')) { diagPolls += 1; return new Response(JSON.stringify({ ...DEV_FIXTURE_DIAGNOSTIC_SESSION, id: 'diag-1', runId: 'fixture-run', status: diagDone ? 'COMPLETED' : 'RUNNING' })); }
      if (input.includes('/api/runs/fixture-run')) { runPolls += 1; return new Response(JSON.stringify(snapshotWith([trial('baseline', 'COMPLETED')], undefined, runStatus))); }
      if (input.includes('/api/runs')) return new Response(JSON.stringify([]));
      if (input.includes('/api/topology')) return new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY));
      return new Response(JSON.stringify([]));
    }));
    const host = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    expect(window.location.search).not.toContain('wrong-diag');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); expect(runPolls).toBeGreaterThanOrEqual(2);
    runStatus = 'COMPLETED'; await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const investigateButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Investigate')!;
    await act(async () => { investigateButton.click(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); }); expect(diagPolls).toBeGreaterThanOrEqual(2);
    diagDone = true; await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const settledDiagPolls = diagPolls; await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); expect(diagPolls).toBe(settledDiagPolls);
  });
  it('restores a matching URL diagnostic session and clears it when switching runs', async () => {
    window.history.replaceState({}, '', '/?runId=fixture-run&diagnosticId=diag-1');
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('/api/diagnostics/diag-1')) return new Response(JSON.stringify({ ...DEV_FIXTURE_DIAGNOSTIC_SESSION, id: 'diag-1', runId: 'fixture-run', sandboxId: 'sbx-diag-1', finalExplanation: 'Restored diagnostic explanation.' }));
      if (input.includes('/api/runs/run-2')) return new Response(JSON.stringify({ ...snapshotWith([trial('baseline', 'COMPLETED')]), id: 'run-2' }));
      if (input.includes('/api/runs/fixture-run')) return new Response(JSON.stringify(snapshotWith([trial('baseline', 'COMPLETED')])));
      if (input.includes('/api/runs')) return new Response(JSON.stringify([{ id: 'fixture-run', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'a'.repeat(40) }, { id: 'run-2', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'a'.repeat(40) }]));
      if (input.includes('/api/topology')) return new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY));
      return new Response(JSON.stringify([]));
    }));
    const host = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('Restored diagnostic explanation.');
    expect(host.textContent).toContain('sbx-diag-1');
    expect(window.location.search).toContain('diagnosticId=diag-1');
    const select = host.querySelector('select')!;
    await act(async () => { select.value = 'run-2'; select.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
    expect(host.textContent).not.toContain('Restored diagnostic explanation.');
    expect(window.location.search).not.toContain('diagnosticId=diag-1');
  });
  it('fires onResync on state-changing SSE events, reconnects closed EventSource, and accepts empty 202 POST responses', async () => {
    vi.useFakeTimers(); const resync = vi.fn();
    mount(createElement(TerminalFeed, { runId: 'run-1', terminal: false, onResync: resync }));
    await act(async () => { FakeEventSource.instances[0]!.emit('RUN_COMPLETE', { id: 'run-1:1', runId: 'run-1', seq: 1, type: 'RUN_COMPLETE', timestamp: '2026-01-01T00:00:00.000Z', message: 'done' }); });
    expect(resync).toHaveBeenCalledTimes(1);
    FakeEventSource.instances[0]!.readyState = FakeEventSource.CLOSED;
    await act(async () => { FakeEventSource.instances[0]!.onerror?.(); await vi.advanceTimersByTimeAsync(1_500); });
    expect(FakeEventSource.instances).toHaveLength(2); expect(resync).toHaveBeenCalledTimes(2);
    const fetcher = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetcher);
    await expect(api.cancel('run-1')).resolves.toBeUndefined();
  });
  it('keeps run B selected when a background poll for active run A fires while B is still loading', async () => {
    vi.useFakeTimers(); window.history.replaceState({}, '', '/?runId=run-a');
    let resolveRunB: ((res: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input.includes('/api/runs/run-a')) return Promise.resolve(new Response(JSON.stringify({ ...snapshotWith([trial('baseline', 'RUNNING', 'b1')], undefined, 'RUNNING_TRIALS'), id: 'run-a', sourceSha: 'a'.repeat(40) })));
      if (input.includes('/api/runs/run-b')) return new Promise<Response>((resolve) => { resolveRunB = resolve; });
      if (input.includes('/api/runs')) return Promise.resolve(new Response(JSON.stringify([{ id: 'run-a', status: 'RUNNING_TRIALS', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'a'.repeat(40) }, { id: 'run-b', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'b'.repeat(40) }])));
      if (input.includes('/api/topology')) return Promise.resolve(new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY)));
      return Promise.resolve(new Response(JSON.stringify([])));
    }));
    const host = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    const select = host.querySelector('select')!;
    await act(async () => { select.value = 'run-b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { resolveRunB?.(new Response(JSON.stringify({ ...snapshotWith([trial('baseline', 'COMPLETED', 'b2')]), id: 'run-b', sourceSha: 'b'.repeat(40) }))); await Promise.resolve(); });
    expect(host.textContent).toContain('b'.repeat(40)); expect(window.location.search).toContain('runId=run-b');
  });
  it('clears loaded EvidenceDrawer artifacts on node, run, and pair changes and ignores late artifact responses', async () => {
    let resolveArtifact: ((res: Response) => void) | undefined;
    const withArtifact = snapshotWith([{ ...trial('control', 'COMPLETED'), artifacts: [{ id: 'art-1', kind: 'terminal', sizeBytes: 10, sha256: 'a'.repeat(64), truncated: false, available: true }] }]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('loaded-artifact'))));
    const drawerHost = mount(createElement(EvidenceDrawer, { snapshot: withArtifact, serviceId: 'frontend', pair: 'original' }));
    await act(async () => { drawerHost.querySelector('button')!.click(); await Promise.resolve(); });
    expect(drawerHost.textContent).toContain('loaded-artifact');
    act(() => root?.render(createElement(EvidenceDrawer, { snapshot: withArtifact, serviceId: 'order-service', pair: 'original' })));
    expect(drawerHost.textContent).not.toContain('loaded-artifact');
    act(() => root?.render(createElement(EvidenceDrawer, { snapshot: withArtifact, serviceId: 'frontend', pair: 'original' })));
    await act(async () => { drawerHost.querySelector('button')!.click(); await Promise.resolve(); });
    act(() => root?.render(createElement(EvidenceDrawer, { snapshot: { ...withArtifact, id: 'other-run' }, serviceId: 'frontend', pair: 'original' })));
    expect(drawerHost.textContent).not.toContain('loaded-artifact');
    act(() => root?.render(createElement(EvidenceDrawer, { snapshot: withArtifact, serviceId: 'frontend', pair: 'original' })));
    await act(async () => { drawerHost.querySelector('button')!.click(); await Promise.resolve(); });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveArtifact = resolve; })));
    await act(async () => { drawerHost.querySelector('button')!.click(); });
    act(() => root?.render(createElement(EvidenceDrawer, { snapshot: withArtifact, serviceId: 'frontend', pair: 'reproduction' })));
    expect(drawerHost.textContent).not.toContain('loaded-artifact');
    await act(async () => { resolveArtifact?.(new Response('late-artifact')); await Promise.resolve(); });
    expect(drawerHost.textContent).not.toContain('late-artifact');
  });
  it('ignores out-of-order refreshRun responses across runs and across overlapping same-run polls', async () => {
    vi.useFakeTimers();
    let resolveRun1: ((res: Response) => void) | undefined; let resolveRun2: ((res: Response) => void) | undefined; let resolveStalePoll: ((res: Response) => void) | undefined; let run2Polls = 0;
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input.includes('/api/runs/run-1')) return new Promise<Response>((resolve) => { resolveRun1 = resolve; });
      if (input.includes('/api/runs/run-2')) {
        run2Polls += 1;
        if (run2Polls === 1) return new Promise<Response>((resolve) => { resolveRun2 = resolve; });
        if (run2Polls === 2) return new Promise<Response>((resolve) => { resolveStalePoll = resolve; });
        return Promise.resolve(new Response(JSON.stringify({ ...snapshotWith([trial('baseline', 'COMPLETED', 'b2-new')]), id: 'run-2', sourceSha: 'd'.repeat(40) })));
      }
      if (input.includes('/api/runs')) return Promise.resolve(new Response(JSON.stringify([{ id: 'run-1', status: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'a'.repeat(40) }, { id: 'run-2', status: 'RUNNING_TRIALS', createdAt: '2026-01-01T00:00:00.000Z', sourceSha: 'b'.repeat(40) }])));
      if (input.includes('/api/topology')) return Promise.resolve(new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY)));
      return Promise.resolve(new Response(JSON.stringify([])));
    }));
    const host = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    const select = host.querySelector('select')!;
    await act(async () => { select.value = 'run-1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { select.value = 'run-2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { resolveRun1?.(new Response(JSON.stringify({ ...snapshotWith([trial('baseline', 'COMPLETED', 'b1')]), id: 'run-1', sourceSha: 'c'.repeat(40) }))); await Promise.resolve(); });
    expect(host.textContent).not.toContain('c'.repeat(40)); expect(window.location.search).not.toContain('runId=run-1');
    await act(async () => { resolveRun2?.(new Response(JSON.stringify({ ...snapshotWith([trial('baseline', 'RUNNING', 'b2')], undefined, 'RUNNING_TRIALS'), id: 'run-2', sourceSha: 'b'.repeat(40) }))); await Promise.resolve(); });
    expect(host.textContent).toContain('b'.repeat(40)); expect(window.location.search).toContain('runId=run-2');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { resolveStalePoll?.(new Response(JSON.stringify({ ...snapshotWith([trial('baseline', 'RUNNING', 'b2-old')], undefined, 'RUNNING_TRIALS'), id: 'run-2', sourceSha: 'e'.repeat(40) }))); await Promise.resolve(); });
    expect(host.textContent).toContain('d'.repeat(40)); expect(host.textContent).not.toContain('e'.repeat(40));
  });
  it('keeps TerminalFeed open while only diagnosticBusy is true and closes after diagnostic settles', async () => {
    vi.useFakeTimers(); window.history.replaceState({}, '', '/?runId=fixture-run&diagnosticId=diag-live');
    let diagSettled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('/api/diagnostics/diag-live')) return new Response(JSON.stringify({ ...DEV_FIXTURE_DIAGNOSTIC_SESSION, id: 'diag-live', runId: 'fixture-run', status: diagSettled ? 'COMPLETED' : 'RUNNING' }));
      if (input.includes('/api/runs/fixture-run')) return new Response(JSON.stringify(snapshotWith([trial('baseline', 'COMPLETED')])));
      if (input.includes('/api/runs')) return new Response(JSON.stringify([]));
      if (input.includes('/api/topology')) return new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY));
      return new Response(JSON.stringify([]));
    }));
    const busyHost = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    await act(async () => { FakeEventSource.instances.at(-1)?.onopen?.(); await vi.advanceTimersByTimeAsync(1_600); });
    expect(busyHost.textContent).not.toContain('● closed');
    diagSettled = true; await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    expect(busyHost.textContent).toContain('● closed');
  });
  it('keeps TerminalFeed open while only reproductionBusy is true and closes after reproduction settles', async () => {
    vi.useFakeTimers(); window.history.replaceState({}, '', '/?runId=fixture-run');
    let repSettled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('/api/runs/fixture-run')) return new Response(JSON.stringify(snapshotWith([trial('reproduction-control', 'COMPLETED', 'c1'), trial('reproduction-chaos', 'COMPLETED', 'c2')], repSettled ? { controlTrialId: 'c1', chaosTrialId: 'c2', classification: 'reproduced', reasons: [] } : undefined)));
      if (input.includes('/api/runs')) return new Response(JSON.stringify([]));
      if (input.includes('/api/topology')) return new Response(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY));
      return new Response(JSON.stringify([]));
    }));
    const busyHost = mount(createElement(App)); await act(async () => { await Promise.resolve(); });
    await act(async () => { FakeEventSource.instances.at(-1)?.onopen?.(); await vi.advanceTimersByTimeAsync(1_600); });
    expect(busyHost.textContent).not.toContain('● closed');
    repSettled = true; await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    expect(busyHost.textContent).toContain('● closed');
  });
});
