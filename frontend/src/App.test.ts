import { describe, expect, it } from 'vitest';
import type { DependencyEdge } from '@entropy/shared';
import { isSmallCheckoutSample, liveStateAfterFixture } from './App';
import { edgeStyle } from './components/TopologyGraph';

const edge = (evidenceKind: DependencyEdge['evidenceKind']): DependencyEdge => ({
  id: `edge-${evidenceKind}`, source: 'auth-service', target: 'redis-cache', relationship: 'READS', evidenceKind, circuitBreaker: false, supportingSpanIds: []
});

describe('dashboard helpers', () => {
  it('classifies configured, predicted, and observed edges from evidence kind', () => {
    expect(edgeStyle(edge('configured'))).toBe('configured');
    expect(edgeStyle(edge('predicted'))).toBe('predicted');
    expect(edgeStyle(edge('observed'))).toBe('observed');
  });
  it('clears all fixture-backed state before returning to live mode', () => {
    expect(liveStateAfterFixture()).toEqual({ snapshot: undefined, graph: undefined, diagnostic: undefined });
  });
  it('marks fewer than twenty checkout samples as a small sample', () => {
    expect(isSmallCheckoutSample(19)).toBe(true);
    expect(isSmallCheckoutSample(20)).toBe(false);
  });
});
