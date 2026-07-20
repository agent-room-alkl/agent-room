import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createClient,
  createTask,
  claimTask,
  submitTask,
  verifyTask,
  getTaskBoard,
  allTasksDone,
  openTasks,
  summarizeBoard,
  doneTasks,
  deliveredFromBoard,
  deliverablesFromBoard,
  formatDeliveredTask,
  boardDeliveredSection,
  reassignTask,
  reassignTaskRoles,
  demotedAgents,
  isAgentDemoted,
  agentBlocks,
  EvidenceIncompleteError,
  OwnerCannotVerifyError,
  VerifierCannotClaimError,
  NotVerifierError,
  TaskStateError,
  hostSetTaskState,
  TaskDoneImmutableError,
} from '../src/index.js';

const ENV = { url: 'https://example.upstash.io', token: 't' };
const CODE = 'ABC-DEF-GHJ';

// In-memory fake of the Upstash REST endpoint: interprets the GET/SET/DEL
// command array the client sends and keeps a key→value Map, so the CAS
// read-modify-write loop in tasks.ts actually round-trips against state.
function installFakeRedis(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const cmd = JSON.parse(init.body) as string[];
    const op = cmd[0];
    const key = cmd[1];
    let result: unknown = null;
    if (op === 'GET') result = store.has(key) ? store.get(key) : null;
    else if (op === 'SET') { store.set(key, cmd[2]); result = 'OK'; }
    else if (op === 'DEL') { result = store.delete(key) ? 1 : 0; }
    else if (op === 'EVAL') {
      // Emulate the task-board CAS script:
      //   EVAL <script> 1 <key> <'absent'|'present'> <expected> <next> <ttl>
      const evalKey = cmd[3];
      const mode = cmd[4];
      const expected = cmd[5];
      const next = cmd[6];
      const cur = store.has(evalKey) ? store.get(evalKey) : undefined;
      const ok = mode === 'absent' ? cur === undefined : cur === expected;
      if (ok) { store.set(evalKey, next); result = 1; } else { result = 0; }
    }
    return new Response(JSON.stringify({ result }), { headers: { 'Content-Type': 'application/json' } });
  }));
  return store;
}

const FULL_EVIDENCE = {
  fileListing: 'models.py\nmain.py\ntest_e2e.py',
  fileExcerpt: 'class Activity(Base): ...',
  runOutput: '1 passed in 0.12s',
  exitCode: 0,
};

const OWNER = { name: 'Qwen', client: 'cc' as const };
const VERIFIER = { name: 'GPT', client: 'cc' as const };

describe('task board evidence gate', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a task in todo with an auto-assigned id', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Core data model', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    expect(task.id).toBe('T-01');
    expect(task.state).toBe('todo');
    expect(task.verifier).toBe('GPT');
  });

  it('rejects a submission missing any evidence part and leaves state unchanged', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });

    await expect(
      submitTask(client, CODE, task.id, OWNER, { ...FULL_EVIDENCE, runOutput: '' }),
    ).rejects.toBeInstanceOf(EvidenceIncompleteError);

    const board = await getTaskBoard(client, CODE);
    expect(board!.tasks[0]!.state).toBe('todo'); // not moved
  });

  it('moves to awaiting_review with full evidence — never straight to done', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: submitted } = await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    expect(submitted.state).toBe('awaiting_review');
    expect(submitted.owner).toBe('Qwen');
    expect(submitted.evidence?.exitCode).toBe(0);
  });

  it('forbids the owner from verifying their own task', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await expect(
      verifyTask(client, CODE, task.id, OWNER, 'done', undefined),
    ).rejects.toBeInstanceOf(OwnerCannotVerifyError);
  });

  it('forbids a non-designated verifier from ruling', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await expect(
      verifyTask(client, CODE, task.id, { name: 'Gemini', client: 'cc' }, 'done', undefined),
    ).rejects.toBeInstanceOf(NotVerifierError);
  });

  it('lets the designated verifier mark it done', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    const { task: verified } = await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'looks good');
    expect(verified.state).toBe('done');
    expect(verified.verdict?.by).toBe('GPT');
  });

  it('cannot verify a task that is not awaiting_review', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    // still in todo
    await expect(
      verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined),
    ).rejects.toBeInstanceOf(TaskStateError);
  });

  it('a rejected task can be resubmitted and then verified', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, { ...FULL_EVIDENCE, exitCode: 1 });
    const { task: rejected } = await verifyTask(client, CODE, task.id, VERIFIER, 'rejected', 'tests fail');
    expect(rejected.state).toBe('rejected');
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    const { task: done } = await verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined);
    expect(done.state).toBe('done');
  });

  it('stamps lastProgressAt on each meaningful change', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { board: afterCreate } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    expect(typeof afterCreate.lastProgressAt).toBe('number');
    const before = afterCreate.lastProgressAt!;
    const { board: afterSubmit } = await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    expect(afterSubmit.lastProgressAt!).toBeGreaterThanOrEqual(before);
  });
});

describe('host task state override', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('host can set a todo task straight to done, with a host verdict stamp', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: done } = await hostSetTaskState(client, CODE, task.id, 'done', 'robin');
    expect(done.state).toBe('done');
    expect(done.verdict?.by).toBe('robin');
    expect(done.verdict?.byClient).toBe('web');
  });

  it('host can move a task between open states', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: t1 } = await hostSetTaskState(client, CODE, task.id, 'in_progress', 'robin');
    expect(t1.state).toBe('in_progress');
    const { task: t2 } = await hostSetTaskState(client, CODE, task.id, 'rejected', 'robin');
    expect(t2.state).toBe('rejected');
    expect(t2.verdict?.verdict).toBe('rejected');
  });

  it('done tasks are locked — host cannot change them', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    await hostSetTaskState(client, CODE, task.id, 'done', 'robin');
    await expect(hostSetTaskState(client, CODE, task.id, 'todo', 'robin'))
      .rejects.toBeInstanceOf(TaskDoneImmutableError);
  });

  it('setting the current state is a no-op that does not throw', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', createdBy: 'Claude' });
    const { task: same } = await hostSetTaskState(client, CODE, task.id, 'todo', 'robin');
    expect(same.state).toBe('todo');
  });
});

describe('board sweep helpers', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('allTasksDone / openTasks reflect state', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'C' });
    await createTask(client, CODE, { title: 'B', createdBy: 'C' });
    let board = (await getTaskBoard(client, CODE))!;
    expect(allTasksDone(board)).toBe(false);
    expect(openTasks(board)).toHaveLength(2);

    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', undefined);
    await submitTask(client, CODE, 'T-02', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-02', VERIFIER, 'done', undefined);
    board = (await getTaskBoard(client, CODE))!;
    expect(allTasksDone(board)).toBe(true);
    expect(openTasks(board)).toHaveLength(0);
  });

  it('allTasksDone is false for an empty board', () => {
    expect(allTasksDone({ code: CODE, tasks: [], version: 0 })).toBe(false);
  });

  it('summarizeBoard lists one line per open task with a state icon', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Core model', createdBy: 'C' });
    const board = (await getTaskBoard(client, CODE))!;
    const summary = summarizeBoard(board);
    expect(summary).toContain('T-01');
    expect(summary).toContain('Core model');
    expect(summary).toContain('todo');
    expect(summary).not.toMatch(/✅ \d+ done/);
  });

  it('summarizeBoard aggregates done tasks into a single trailing line', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task: t1 } = await createTask(client, CODE, {
      title: 'Ship A',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    const { task: t2 } = await createTask(client, CODE, {
      title: 'Ship B',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    await createTask(client, CODE, { title: 'Still open', createdBy: 'C' });

    await claimTask(client, CODE, t1.id, OWNER);
    await submitTask(client, CODE, t1.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, t1.id, VERIFIER, 'done', 'ok');
    await claimTask(client, CODE, t2.id, OWNER);
    await submitTask(client, CODE, t2.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, t2.id, VERIFIER, 'done', 'ok');

    const board = (await getTaskBoard(client, CODE))!;
    const summary = summarizeBoard(board);
    expect(summary).toContain('T-03 Still open');
    expect(summary).toContain('todo');
    expect(summary).not.toContain('Ship A');
    expect(summary).not.toContain('Ship B');
    expect(summary.endsWith('✅ 2 done')).toBe(true);
    expect(summary.split('\n')).toHaveLength(2);
  });

  it('summarizeBoard is only the aggregate line when every task is done', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Only one',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'C',
    });
    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'ok');
    const board = (await getTaskBoard(client, CODE))!;
    expect(summarizeBoard(board)).toBe('✅ 1 done');
  });
});

describe('board-derived delivery (minutes / report source of truth)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('deliveredFromBoard is true only after room_task_submit evidence is verified done', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'Core data model',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Claude',
    });
    let board = (await getTaskBoard(client, CODE))!;
    expect(deliveredFromBoard(board)).toBe(false);
    expect(doneTasks(board)).toHaveLength(0);

    await claimTask(client, CODE, task.id, OWNER);
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    board = (await getTaskBoard(client, CODE))!;
    expect(deliveredFromBoard(board)).toBe(false);

    await verifyTask(client, CODE, task.id, VERIFIER, 'done', 'looks good');
    board = (await getTaskBoard(client, CODE))!;
    expect(deliveredFromBoard(board)).toBe(true);
    expect(doneTasks(board)).toHaveLength(1);
    expect(deliverablesFromBoard(board)).toEqual([
      'T-01: Core data model (verified by GPT) — models.py',
    ]);
    expect(formatDeliveredTask(doneTasks(board)[0]!)).toBe(
      'T-01: Core data model (verified by GPT) — models.py',
    );
    expect(boardDeliveredSection(board)).toContain('verified-done');
    expect(boardDeliveredSection(board)).toContain('T-01: Core data model');
  });

  it('deliveredFromBoard returns null when there is no task board', () => {
    expect(deliveredFromBoard(null)).toBeNull();
    expect(deliveredFromBoard({ code: CODE, tasks: [], version: 0 })).toBeNull();
  });
});

describe('moderator-mode blocked-agent reassignment', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reassigns a task to a new owner, resets it to todo, and tallies a block on the old owner', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Build it', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    await claimTask(client, CODE, 'T-01', OWNER); // Qwen → in_progress

    const r = await reassignTask(client, CODE, 'T-01', { name: 'GPT', client: 'cc' });
    expect(r.fromOwner).toBe('Qwen');
    expect(r.task.owner).toBe('GPT');
    expect(r.task.state).toBe('todo');
    expect(r.demoted).toBe(false);
    expect(r.blocks).toBe(1);

    const board = (await getTaskBoard(client, CODE))!;
    expect(agentBlocks(board, 'Qwen')).toBe(1);
    expect(isAgentDemoted(board, 'Qwen')).toBe(false);
  });

  it('auto-demotes an agent after 2 blocked tasks', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    await createTask(client, CODE, { title: 'B', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });

    const r1 = await reassignTask(client, CODE, 'T-01', { name: 'GPT', client: 'cc' });
    expect(r1.demoted).toBe(false);
    const r2 = await reassignTask(client, CODE, 'T-02', { name: 'Claude', client: 'cc' });
    expect(r2.demoted).toBe(true); // crosses the threshold on this turn
    expect(r2.blocks).toBe(2);

    const board = (await getTaskBoard(client, CODE))!;
    expect(isAgentDemoted(board, 'Qwen')).toBe(true);
    expect(demotedAgents(board)).toContain('Qwen');
  });

  it('does not tally a block when reassigning to the same owner', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    const r = await reassignTask(client, CODE, 'T-01', { name: 'Qwen', client: 'cc' });
    expect(r.blocks).toBe(0);
    const board = (await getTaskBoard(client, CODE))!;
    expect(agentBlocks(board, 'Qwen')).toBe(0);
  });
});

describe('role reassignment (owner/verifier escape hatch)', () => {
  beforeEach(() => vi.restoreAllMocks());

  const MOD = { name: 'Claude', client: 'cc' as const };

  it('reassigns the owner without changing state and records an audit entry', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'Build it', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });
    await claimTask(client, CODE, 'T-01', OWNER); // Qwen → in_progress

    const { task } = await reassignTaskRoles(client, CODE, 'T-01', { owner: 'Gemini', ownerClient: 'cc' }, MOD, 1234);
    expect(task.owner).toBe('Gemini');
    expect(task.ownerClient).toBe('cc');
    expect(task.state).toBe('in_progress'); // state untouched — unlike reassignTask
    expect(task.verifier).toBe('GPT');
    expect(task.roleHistory).toEqual([
      { by: 'Claude', byClient: 'cc', at: 1234, field: 'owner', from: 'Qwen', to: 'Gemini' },
    ]);
  });

  it('reassigns the verifier and appends to the existing audit trail', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });

    await reassignTaskRoles(client, CODE, 'T-01', { owner: 'Gemini', ownerClient: 'cc' }, MOD, 1000);
    const { task } = await reassignTaskRoles(client, CODE, 'T-01', { verifier: 'Qwen', verifierClient: 'cc' }, MOD, 2000);
    expect(task.verifier).toBe('Qwen');
    expect(task.owner).toBe('Gemini');
    expect(task.roleHistory).toEqual([
      { by: 'Claude', byClient: 'cc', at: 1000, field: 'owner', from: 'Qwen', to: 'Gemini' },
      { by: 'Claude', byClient: 'cc', at: 2000, field: 'verifier', from: 'GPT', to: 'Qwen' },
    ]);
  });

  it('can swap both roles at once, one audit entry per changed field', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });
    const { task } = await reassignTaskRoles(
      client, CODE, 'T-01',
      { owner: 'GPT', ownerClient: 'cc', verifier: 'Qwen', verifierClient: 'cc' },
      MOD, 3000,
    );
    expect(task.owner).toBe('GPT');
    expect(task.verifier).toBe('Qwen');
    expect(task.roleHistory).toHaveLength(2);
  });

  it('rejects a reassignment whose RESULT is owner == verifier (case-insensitive)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'GPT', verifierClient: 'cc', createdBy: 'Mod' });
    // New owner collides with the EXISTING verifier.
    await expect(
      reassignTaskRoles(client, CODE, 'T-01', { owner: ' gpt ', ownerClient: 'cc' }, MOD),
    ).rejects.toBeInstanceOf(TaskStateError);
    // New verifier collides with the EXISTING owner.
    await expect(
      reassignTaskRoles(client, CODE, 'T-01', { verifier: 'QWEN', verifierClient: 'cc' }, MOD),
    ).rejects.toBeInstanceOf(TaskStateError);
    // Nothing moved.
    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks[0]!.owner).toBe('Qwen');
    expect(board.tasks[0]!.verifier).toBe('GPT');
    expect(board.tasks[0]!.roleHistory).toBeUndefined();
  });

  it('rejects reassignment of a done task — completed work is locked', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Mod' });
    await submitTask(client, CODE, 'T-01', OWNER, FULL_EVIDENCE);
    await verifyTask(client, CODE, 'T-01', VERIFIER, 'done', undefined);
    await expect(
      reassignTaskRoles(client, CODE, 'T-01', { owner: 'Gemini', ownerClient: 'cc' }, MOD),
    ).rejects.toBeInstanceOf(TaskDoneImmutableError);
  });

  it('rejects an empty patch and empty names', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', createdBy: 'Mod' });
    await expect(reassignTaskRoles(client, CODE, 'T-01', {}, MOD)).rejects.toBeInstanceOf(TaskStateError);
    await expect(reassignTaskRoles(client, CODE, 'T-01', { owner: '  ' }, MOD)).rejects.toBeInstanceOf(TaskStateError);
  });

  it('a reassignment to the same holder changes nothing and records no audit entry', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'X', owner: 'Qwen', ownerClient: 'cc', createdBy: 'Mod' });
    const { task } = await reassignTaskRoles(client, CODE, 'T-01', { owner: 'Qwen', ownerClient: 'cc' }, MOD);
    expect(task.owner).toBe('Qwen');
    expect(task.roleHistory).toBeUndefined();
  });
});

describe('verifyTask with unset client kinds (name-only records)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lets the named verifier rule when verifierClient was never recorded', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    // createTask accepts a verifier name alone — no verifierClient.
    const { task } = await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    const { task: done } = await verifyTask(client, CODE, task.id, VERIFIER, 'done', undefined);
    expect(done.state).toBe('done');
    expect(done.verdict?.by).toBe('GPT');
  });

  it('still rejects the wrong name when verifierClient is unset', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, { title: 'X', verifier: VERIFIER.name, createdBy: 'Claude' });
    await submitTask(client, CODE, task.id, OWNER, FULL_EVIDENCE);
    await expect(
      verifyTask(client, CODE, task.id, { name: 'Gemini', client: 'cc' }, 'done', undefined),
    ).rejects.toBeInstanceOf(NotVerifierError);
  });

  it('still blocks self-verify when ownerClient was never recorded', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    // Owner recorded by name only, moved to awaiting_review by the host —
    // ownerClient stays undefined, and a bare name match must still block.
    const { task } = await createTask(client, CODE, { title: 'X', owner: OWNER.name, createdBy: 'Claude' });
    await hostSetTaskState(client, CODE, task.id, 'awaiting_review', 'robin');
    await expect(
      verifyTask(client, CODE, task.id, OWNER, 'done', undefined),
    ).rejects.toBeInstanceOf(OwnerCannotVerifyError);
  });
});

describe('createTask owner/verifier separation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects a task whose verifier equals the owner', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await expect(
      createTask(client, CODE, {
        title: 'X', owner: 'Qwen', ownerClient: 'cc', verifier: 'Qwen', verifierClient: 'cc', createdBy: 'Claude',
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
    // Nothing was written — the board stays absent.
    expect(await getTaskBoard(client, CODE)).toBeNull();
  });

  it('rejects a same-agent verifier that differs only by case/whitespace', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await expect(
      createTask(client, CODE, {
        title: 'X', owner: '  qwen ', ownerClient: 'cc', verifier: 'QWEN', verifierClient: 'cc', createdBy: 'Claude',
      }),
    ).rejects.toBeInstanceOf(TaskStateError);
    expect(await getTaskBoard(client, CODE)).toBeNull();
  });

  it('still accepts a distinct verifier', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', owner: OWNER.name, ownerClient: OWNER.client, verifier: VERIFIER.name, verifierClient: VERIFIER.client, createdBy: 'Claude',
    });
    expect(task.state).toBe('todo');
    expect(task.owner).toBe('Qwen');
    expect(task.verifier).toBe('GPT');
  });

  it('still accepts a task with an owner and no verifier', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X', owner: OWNER.name, ownerClient: OWNER.client, createdBy: 'Claude',
    });
    expect(task.state).toBe('todo');
    expect(task.verifier).toBeUndefined();
  });
});

describe('claimTask verifier-conflict guard (T-13 deadlock)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects when the designated verifier claims the task', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    // Create with no owner — verifier set to GPT; GPT claiming would deadlock.
    const { task } = await createTask(client, CODE, {
      title: 'Flash banner',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Claude',
    });
    expect(task.state).toBe('todo');
    expect(task.owner).toBeUndefined();

    await expect(
      claimTask(client, CODE, task.id, VERIFIER),
    ).rejects.toBeInstanceOf(VerifierCannotClaimError);

    const board = (await getTaskBoard(client, CODE))!;
    const still = board.tasks.find(t => t.id === task.id)!;
    expect(still.state).toBe('todo');
    expect(still.owner).toBeUndefined();
  });

  it('rejects case/whitespace variants of the verifier name', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X',
      verifier: 'GPT',
      verifierClient: 'cc',
      createdBy: 'Claude',
    });
    await expect(
      claimTask(client, CODE, task.id, { name: '  gpt ', client: 'cc' }),
    ).rejects.toBeInstanceOf(VerifierCannotClaimError);
  });

  it('rejects on name match when verifierClient is unset (client-tolerant)', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X',
      verifier: 'Auto',
      createdBy: 'Claude',
    });
    await expect(
      claimTask(client, CODE, task.id, { name: 'Auto', client: 'cc' }),
    ).rejects.toBeInstanceOf(VerifierCannotClaimError);
  });

  it('allows a non-verifier to claim', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    const { task } = await createTask(client, CODE, {
      title: 'X',
      verifier: VERIFIER.name,
      verifierClient: VERIFIER.client,
      createdBy: 'Claude',
    });
    const { task: claimed } = await claimTask(client, CODE, task.id, OWNER);
    expect(claimed.state).toBe('in_progress');
    expect(claimed.owner).toBe(OWNER.name);
    expect(claimed.verifier).toBe(VERIFIER.name);
  });
});

describe('task board CAS (no lost updates / no blanking)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('concurrent writes to different tasks both survive', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'C' }); // T-01
    await createTask(client, CODE, { title: 'B', createdBy: 'C' }); // T-02
    // Without a real CAS one of these claims would clobber the other (both read
    // the same board, both wrote vN+1, last-write-wins).
    await Promise.all([
      claimTask(client, CODE, 'T-01', { name: 'Qwen', client: 'cc' }),
      claimTask(client, CODE, 'T-02', { name: 'GPT', client: 'cc' }),
    ]);
    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks.find(t => t.id === 'T-01')!.owner).toBe('Qwen');
    expect(board.tasks.find(t => t.id === 'T-02')!.owner).toBe('GPT');
    expect(board.tasks.every(t => t.state === 'in_progress')).toBe(true);
  });

  it('a stale-snapshot write does not blank the board', async () => {
    installFakeRedis();
    const client = createClient(ENV);
    await createTask(client, CODE, { title: 'A', createdBy: 'C' });
    await createTask(client, CODE, { title: 'B', createdBy: 'C' });
    // Two concurrent claims + a create racing — the board must keep all 3 tasks,
    // never collapse to an empty/0 board.
    await Promise.all([
      claimTask(client, CODE, 'T-01', { name: 'Qwen', client: 'cc' }),
      createTask(client, CODE, { title: 'C', createdBy: 'C' }),
      claimTask(client, CODE, 'T-02', { name: 'GPT', client: 'cc' }),
    ]);
    const board = (await getTaskBoard(client, CODE))!;
    expect(board.tasks).toHaveLength(3);
  });
});
