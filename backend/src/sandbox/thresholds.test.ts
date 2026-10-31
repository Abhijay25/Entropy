import { describe, expect, it } from 'vitest';

import { HEALTH_THRESHOLDS as SHARED_THRESHOLDS, PRIMARY_CHANNEL_BY_SERVICE } from '../../../shared/types.js';
import { HEALTH_THRESHOLDS as PAYLOAD_THRESHOLDS, PRIMARY_CHANNEL } from './payload/lib/constants.js';

// The payload keeps its own copy (it may not import zod), so the two must never drift apart:
// the comparator recomputes health with these values and rejects any report that disagrees.
describe('payload and comparator health rules', () => {
  it('use identical thresholds and primary channels', () => {
    expect(PAYLOAD_THRESHOLDS).toEqual(SHARED_THRESHOLDS);
    expect(PRIMARY_CHANNEL).toEqual(PRIMARY_CHANNEL_BY_SERVICE);
  });
});
