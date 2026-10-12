import { describe, expect, it } from 'vitest';
import { roomPolicySummary, roundFloorBrief } from './agentContext.js';

describe('open-source room policy', () => {
  it('describes the actual round-robin machine and protects the opening peer pass', () => {
    const policy = roomPolicySummary('sequential');
    expect(policy).toContain('maximum of ten rounds');
    expect(policy).toContain('first peer pass');
    expect(policy).not.toContain('Five phases');
    expect(roundFloorBrief('sequential', 1, false)).toContain('__no_addition__');
  });
  it.each(['consensus', 'debate'])('preserves the %s contract', mode => {
    expect(roomPolicySummary(mode)).toContain('Round 1');
    expect(roomPolicySummary(mode)).toContain('Round 2');
  });
  it('separates initial open discussion from agreed execution', () => {
    expect(roomPolicySummary('open')).toContain('before claiming or implementing');
    expect(roomPolicySummary('open')).toContain('once agreed, execute');
  });
  it('keeps unresolved objections in the user language on later lead turns', () => {
    expect(roundFloorBrief('sequential', 2, true)).toContain('unresolved objections');
    expect(roundFloorBrief('sequential', 2, true)).toContain('user\'s language');
  });
});
