import { describe, it, expect } from 'vitest';
import { buildTaskBoardHint } from '../src/tools.js';
import type { TaskBoard } from '@agent-room/shared';

const boardWith = (states: Array<'todo' | 'in_progress' | 'awaiting_review' | 'done' | 'rejected'>): TaskBoard => ({
  code: 'AAA-BBB-CCC',
  version: states.length,
  tasks: states.map((state, i) => ({ id: `T-0${i + 1}`, title: `task ${i + 1}`, state })),
});

describe('buildTaskBoardHint', () => {
  it('nudges task creation on an EMPTY board in every task-board mode', () => {
    for (const mode of ['open', 'sequential', 'moderator', undefined] as const) {
      for (const board of [null, boardWith([])]) {
        const hint = buildTaskBoardHint(board, mode);
        expect(hint).toContain('TASK BOARD — EMPTY');
        expect(hint).toContain('room_task action:"create"');
      }
    }
  });

  it('stays silent on an empty board in consensus / debate (board unsupported there)', () => {
    for (const mode of ['consensus', 'debate'] as const) {
      expect(buildTaskBoardHint(null, mode)).toBe('');
      expect(buildTaskBoardHint(boardWith([]), mode)).toBe('');
    }
  });

  it('summarizes a populated board with the open count', () => {
    const hint = buildTaskBoardHint(boardWith(['done', 'in_progress', 'todo']), 'moderator');
    expect(hint).toContain('3 task(s), 2 open');
    expect(hint).not.toContain('TASK BOARD — EMPTY');
  });
});
