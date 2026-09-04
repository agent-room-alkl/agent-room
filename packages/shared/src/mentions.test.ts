import { describe, expect, it } from 'vitest';
import { hasMentionSyntax, mentionedAgents, wakesAgent } from './mentions.js';

const ROSTER = ['Claude', 'GPT', 'DeepSeek', 'Gemini'];

describe('mentionedAgents', () => {
  it('finds a single addressed agent', () => {
    expect(mentionedAgents('@Claude 看下这个', ROSTER)).toEqual(['Claude']);
  });

  it('matches case-insensitively — people type @claude', () => {
    expect(mentionedAgents('@claude can you check this', ROSTER)).toEqual(['Claude']);
    expect(mentionedAgents('@deepseek write it', ROSTER)).toEqual(['DeepSeek']);
  });

  it('returns every mentioned agent, in roster order', () => {
    expect(mentionedAgents('@Gemini and @GPT please compare', ROSTER)).toEqual(['GPT', 'Gemini']);
  });

  // Empty means "not addressed to anyone in particular" — callers wake the whole
  // room, so a plain question still reaches everybody.
  it('is empty for a message with no mention', () => {
    expect(mentionedAgents('Hi', ROSTER)).toEqual([]);
    expect(mentionedAgents('what do you all think?', ROSTER)).toEqual([]);
  });

  // A typo must not silence the room; the caller falls back to everyone.
  it('is empty when the mention matches nobody', () => {
    expect(mentionedAgents('@Claud fix it', ROSTER)).toEqual([]);
    expect(mentionedAgents('@robin ping', ROSTER)).toEqual([]);
  });

  it('handles empty text and an empty roster', () => {
    expect(mentionedAgents('', ROSTER)).toEqual([]);
    expect(mentionedAgents('@Claude', [])).toEqual([]);
  });

  it('matches a mention mid-sentence and with punctuation after it', () => {
    expect(mentionedAgents('can @GPT, review this?', ROSTER)).toEqual(['GPT']);
  });

  it('requires the @ — a bare name is not a mention', () => {
    expect(mentionedAgents('Claude said something earlier', ROSTER)).toEqual([]);
  });
});

describe('hasMentionSyntax', () => {
  it('is true for a real mention', () => {
    expect(hasMentionSyntax('@Claude 看下这个')).toBe(true);
    expect(hasMentionSyntax('can @GPT review this?')).toBe(true);
    expect(hasMentionSyntax('(@Gemini and @GPT)')).toBe(true);
    expect(hasMentionSyntax('**@Claude** please')).toBe(true);
  });

  // The bug: quoting an email address made the room warn that the moderator
  // "mentioned an agent that isn't in this room".
  it('is false for an email address', () => {
    expect(hasMentionSyntax('send it to todd@toddshaner.com')).toBe(false);
    expect(hasMentionSyntax('todd.shaner@gmail.com')).toBe(false);
    expect(hasMentionSyntax('reply to me at a@b.co, thanks')).toBe(false);
  });

  it('is false with no @ at all, and for empty text', () => {
    expect(hasMentionSyntax('Claude said something earlier')).toBe(false);
    expect(hasMentionSyntax('')).toBe(false);
    expect(hasMentionSyntax('cost is 100@ per unit')).toBe(false);
  });

  // Still true for a mention nobody matches — that is exactly the case the
  // caller wants to warn about.
  it('is true for a mistyped mention', () => {
    expect(hasMentionSyntax('@Claud fix it')).toBe(true);
  });
});

describe('wakesAgent', () => {
  const m = (text: string, targetAgentName?: string) => ({
    text,
    ...(targetAgentName ? { metadata: { targetAgentName } } : {}),
  });

  it('wakes on a direct mention, case-insensitively', () => {
    expect(wakesAgent(m('@Claude can you take this?'), 'Claude')).toBe(true);
    expect(wakesAgent(m('@claude can you take this?'), 'Claude')).toBe(true);
  });

  it('wakes when the room says the event is about this agent', () => {
    expect(wakesAgent(m('Moderator assigned this turn.', 'Claude'), 'Claude')).toBe(true);
    expect(wakesAgent(m('Moderator assigned this turn.', 'Codex'), 'Claude')).toBe(false);
  });

  it('stays asleep for room chatter that names nobody', () => {
    expect(wakesAgent(m('I pushed the branch, tests are green.'), 'Claude')).toBe(false);
  });

  it('stays asleep when a different agent is addressed', () => {
    expect(wakesAgent(m('@Codex please review.'), 'Claude')).toBe(false);
  });

  // A reconnect mints "Claude (2)"; people still type "@Claude". Missing the
  // message meant for you costs the meeting, so the suffixed seat answers too.
  it('wakes a suffixed reconnect seat on the bare name', () => {
    expect(wakesAgent(m('@Claude ping'), 'Claude (2)')).toBe(true);
    expect(wakesAgent(m('turn is yours', 'Claude'), 'Claude (2)')).toBe(true);
  });

  it('is not fooled by an email address', () => {
    expect(wakesAgent(m('mail robin@agent-room.com about it'), 'robin')).toBe(false);
  });

  it('needs a name to match against', () => {
    expect(wakesAgent(m('@Claude hi'), '   ')).toBe(false);
  });
});
