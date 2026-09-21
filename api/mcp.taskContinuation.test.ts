import { describe, expect, it, vi } from 'vitest';

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe('room_task work continuation', () => {
  it('turns a successful claim into an explicit execute-now instruction', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const task = { id: 'T-01', title: 'first', state: 'in_progress', owner: 'Codex' };
    const client = { post: vi.fn(async () => ({ task, board: { tasks: [task] } })) } as never;
    const res = body(await callTool(client, 'full', 'room_task', {
      action: 'claim', code: 'AAA-BBB-CCC', name: 'Codex', id: 'T-01',
    }));

    expect(res.workNext).toMatchObject({ required: true, action: 'execute_task', id: 'T-01' });
    expect(res.workNext.instruction).toContain('Do not send a status-only');
  });

  it('confirms submit changed state and names the next owned todo', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const submitted = { id: 'T-01', title: 'first', state: 'awaiting_review', owner: 'Codex', verifier: 'Claude' };
    const queued = { id: 'T-02', title: 'second', state: 'todo', owner: 'Codex', verifier: 'Claude' };
    const client = { post: vi.fn(async () => ({ task: submitted, board: { tasks: [submitted, queued] } })) } as never;
    const res = body(await callTool(client, 'full', 'room_task', {
      action: 'submit', code: 'AAA-BBB-CCC', name: 'Codex', id: 'T-01',
      fileListing: 'a.ts', fileExcerpt: 'export {}', runOutput: 'ok', exitCode: 0,
    }));

    expect(res.taskStateUpdated).toBe(true);
    expect(res.submittedForReview).toBe(true);
    expect(res.workNext).toMatchObject({ required: true, action: 'claim_next_task', id: 'T-02' });
    expect(res.workNext.instruction).toContain('Immediately claim T-02');
    expect(res.yourTasks.toDo).toEqual(['T-02']);
  });

  it('explains the verifier gate when there is no next task', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const submitted = { id: 'T-01', title: 'first', state: 'awaiting_review', owner: 'Codex', verifier: 'Claude' };
    const client = { post: vi.fn(async () => ({ task: submitted, board: { tasks: [submitted] } })) } as never;
    const res = body(await callTool(client, 'full', 'room_task', {
      action: 'submit', code: 'AAA-BBB-CCC', name: 'Codex', id: 'T-01',
      fileListing: 'a.ts', fileExcerpt: 'export {}', checks: 'reviewed manually',
    }));

    expect(res.workNext).toMatchObject({ required: false, action: 'await_review' });
    expect(res.workNext.instruction).toContain('owner cannot mark it done');
  });
});
