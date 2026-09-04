import { describe, expect, it } from 'vitest';
import {
  RECONNECT_SUFFIX_SQL,
  baseParticipantName,
  countDistinctParticipants,
  rosterCounts,
} from './participantNames.js';

describe('baseParticipantName', () => {
  it('strips the suffix uniqueNameForRoom mints', () => {
    expect(baseParticipantName('Copilot (2)')).toBe('Copilot');
    expect(baseParticipantName('Indiana Jones (7)')).toBe('Indiana Jones');
  });

  it('leaves names that merely contain parentheses alone', () => {
    // Only a trailing " (n)" is ours. An agent legitimately named "Ledger (EU)"
    // or "GPT-4 (preview)" must survive intact, or folding would merge two
    // genuinely different agents into one row.
    expect(baseParticipantName('Ledger (EU)')).toBe('Ledger (EU)');
    expect(baseParticipantName('GPT-4 (preview)')).toBe('GPT-4 (preview)');
    expect(baseParticipantName('Kronos')).toBe('Kronos');
  });

  it('never returns empty for a name that was only a suffix', () => {
    expect(baseParticipantName('(2)')).toBe('(2)');
  });
});

describe('countDistinctParticipants', () => {
  it('counts one agent behind a reconnect storm', () => {
    // The shape that produced "19 agents" in the admin Rooms tab.
    const names = [
      'Indiana Jones',
      'Indiana Jones (2)',
      'Indiana Jones (3)',
      'Indiana Jones (4)',
      'Indiana Jones (5)',
      'Indiana Jones (6)',
      'Indiana Jones (7)',
    ];
    expect(countDistinctParticipants(names)).toBe(1);
  });

  it('keeps distinct agents distinct, and ignores case and blanks', () => {
    expect(countDistinctParticipants(['Ledger', 'ledger (2)', 'Cael', '', '  '])).toBe(2);
  });
});

describe('rosterCounts', () => {
  const roster = [
    { client: 'web', name: 'Matt' },
    { client: 'cc', name: 'Ledger' },
    { client: 'cc', name: 'Ledger (2)' },
    { client: 'cc', name: 'Cael' },
  ];

  it('separates agents from the seats they hold', () => {
    expect(rosterCounts(roster)).toEqual({
      participantCount: 4,
      humanCount: 1,
      agentCount: 2,
      agentSeatCount: 3,
    });
  });
});

describe('RECONNECT_SUFFIX_SQL', () => {
  it('matches exactly what the JS helper strips', () => {
    // The analytics queries fold names in Postgres, the runtime folds them in
    // JS. Same inputs, same answer — or the admin tables and the room disagree.
    const jsFold = (name: string) => baseParticipantName(name);
    // The pattern Postgres gets, read back as a JS regex — Postgres ARE and
    // JS RegExp agree on this subset (escaped paren, \d, anchor).
    const asJs = new RegExp(RECONNECT_SUFFIX_SQL);
    const sqlFold = (name: string) => name.trim().replace(asJs, '');
    for (const name of ['Copilot (2)', 'Kronos (12)', 'Ledger (EU)', 'Cael', 'GPT-4 (preview)']) {
      expect(sqlFold(name)).toBe(jsFold(name));
    }
  });
});
