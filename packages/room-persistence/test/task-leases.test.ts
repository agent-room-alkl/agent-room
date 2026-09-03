import { describe, expect, it } from 'vitest';
import type { Message, Room, RoomReport, TaskBoard } from '@agent-room/shared';
import { RoomRecordServer } from '../src/server.js';
import { TaskLeaseServer, type LeaseActor } from '../src/task-leases.js';
import type { LeaseEventInput, LeaseMembershipPrecondition, RoomPersistence, RoomReceipt } from '../src/types.js';

const alice: LeaseActor = { memberId: 'fingerprint-alice', name: 'Alice', client: 'cc' };
const bob: LeaseActor = { memberId: 'fingerprint-bob', name: 'Bob', client: 'cc' };

function room(): Room {
  const participant = (actor: LeaseActor) => ({
    name: actor.name, role: 'builder', color: '#123456', initials: actor.name.slice(0, 2).toUpperCase(),
    client: actor.client, joinedAt: 1, lastSeenAt: 1,
    authenticatedIdentity: {
      cardFingerprint: actor.memberId, fleetId: 'fleet', cardName: actor.name,
      scheme: 'oauth2' as const, keyId: 'key', verifiedAt: 1,
    },
  });
  return { code: 'LES-TST-001', topic: 'Synthetic', createdAt: 1, createdBy: 'Host',
    status: 'active', version: 1, participants: [participant(alice), participant(bob)] };
}

function board(): TaskBoard {
  return { code: room().code, version: 1, tasks: [{
    id: 'T-01', title: 'Synthetic task', state: 'in_progress', createdBy: 'Host', createdAt: 1, updatedAt: 1,
  }] };
}

class LeaseMemoryPersistence implements RoomPersistence {
  readonly kind = 'postgres' as const;
  currentRoom = room();
  currentBoard = board();
  receipts: RoomReceipt[] = [];
  boardWrites = 0;
  beforeLeaseCas?: () => void;
  async createRoom(value: Room) { this.currentRoom = structuredClone(value); }
  async getRoom(code: string) { return code === this.currentRoom.code ? structuredClone(this.currentRoom) : null; }
  async compareAndSwapRoom() { return false; }
  async appendMessage(_code: string, _message: Message) { return 0; }
  async listMessages() { return []; }
  async getTaskBoard(code: string) { return code === this.currentBoard.code ? structuredClone(this.currentBoard) : null; }
  async compareAndSwapTaskBoard(_code: string, expected: number | null, next: TaskBoard) {
    if (expected !== this.currentBoard.version) return false;
    this.currentBoard = structuredClone(next); this.boardWrites++; return true;
  }
  async compareAndSwapTaskBoardWithLeaseEvents(
    _code: string, expected: number | null, next: TaskBoard, events: readonly LeaseEventInput[],
    membership?: LeaseMembershipPrecondition,
  ) {
    await Promise.resolve();
    this.beforeLeaseCas?.();
    this.beforeLeaseCas = undefined;
    if (expected !== this.currentBoard.version) return false;
    if (membership && (membership.roomVersion !== this.currentRoom.version ||
      membership.members.some(required => !this.currentRoom.participants.some(participant =>
        participant.authenticatedIdentity?.cardFingerprint === required.memberId &&
        participant.name === required.name && participant.client === required.client)))) return false;
    this.currentBoard = structuredClone(next);
    this.receipts.push(...events.map(event => ({
      id: event.id, roomCode: event.roomCode, kind: 'lease_event' as const,
      createdAt: event.at, leaseEvent: event.event,
      payload: { actor: event.actor, leaseId: event.leaseId, ...(event.details ?? {}) },
    })));
    this.boardWrites++;
    return true;
  }
  async getTaskBoardUnused() { return null; }
  async putMinutes(_code: string, _reportId: string, _report: RoomReport) {}
  async getMinutes() { return null; }
  async appendReceipt(receipt: RoomReceipt) { this.receipts.push(receipt); return true; }
  async appendLeaseEvent() { return true; }
  async listReceipts() { return structuredClone(this.receipts); }
  async close() {}
}

function service(store: LeaseMemoryPersistence, clock: { now: number }) {
  let id = 0;
  return new TaskLeaseServer(new RoomRecordServer(store), () => clock.now, () => String(++id));
}

const evidence = { fileListing: 'file', fileExcerpt: 'excerpt', runOutput: 'green', exitCode: 0 };

describe('task lease production entry', () => {
  it('atomically grants exactly one of two concurrent claims', async () => {
    const store = new LeaseMemoryPersistence();
    const clock = { now: 100 };
    const leases = service(store, clock);
    const results = await Promise.allSettled([
      leases.claim(room().code, 'T-01', alice),
      leases.claim(room().code, 'T-01', bob),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(store.currentBoard.tasks[0]?.lease?.status).toBe('active');
    expect(store.receipts.map(item => item.leaseEvent)).toEqual(['granted']);
  });

  it('refuses a non-holder submission by name without changing the board', async () => {
    const store = new LeaseMemoryPersistence();
    const clock = { now: 100 };
    const leases = service(store, clock);
    await leases.claim(room().code, 'T-01', alice);
    const before = structuredClone(store.currentBoard);

    await expect(leases.submit(room().code, 'T-01', bob, evidence))
      .rejects.toMatchObject({ name: 'task_lease_holder_required' });
    expect(store.currentBoard).toEqual(before);
    const submitted = await leases.submit(room().code, 'T-01', alice, evidence);
    expect(submitted.task).toMatchObject({ state: 'awaiting_review', evidence: { submittedBy: 'Alice' } });
  });

  it('lets only the holder renew and release, extending from server time and freeing the task', async () => {
    const store = new LeaseMemoryPersistence();
    const clock = { now: 100 };
    const leases = service(store, clock);
    await leases.claim(room().code, 'T-01', alice, 50);
    clock.now = 120;
    const renewed = await leases.renew(room().code, 'T-01', alice, 80);
    expect(renewed.task.lease?.expiresAt).toBe(200);
    await expect(leases.release(room().code, 'T-01', bob))
      .rejects.toMatchObject({ name: 'task_lease_holder_required' });
    const released = await leases.release(room().code, 'T-01', alice);
    expect(released.task.lease?.status).toBe('released');
    expect(store.receipts.map(item => item.leaseEvent)).toEqual(['granted', 'renewed', 'released']);
  });

  it('sweeps expiry before claim and records expiry before the replacement grant', async () => {
    const store = new LeaseMemoryPersistence();
    const clock = { now: 100 };
    const leases = service(store, clock);
    await leases.claim(room().code, 'T-01', alice, 10);
    clock.now = 111;
    const claimed = await leases.claim(room().code, 'T-01', bob);

    expect(claimed.task.lease?.holderId).toBe(bob.memberId);
    expect(store.receipts.map(item => item.leaseEvent)).toEqual(['granted', 'expired', 'granted']);
  });

  it('routes a handoff to the holder and transfers its grant atomically with ordered ledger events', async () => {
    const store = new LeaseMemoryPersistence();
    const clock = { now: 100 };
    const leases = service(store, clock);
    await leases.claim(room().code, 'T-01', alice);
    clock.now = 110;
    const requested = await leases.requestHandoff(room().code, 'T-01', bob);
    expect(requested.task.lease?.handoff).toMatchObject({ requestedById: bob.memberId });
    clock.now = 120;
    const transferred = await leases.grantHandoff(room().code, 'T-01', alice);

    expect(transferred.task.lease).toMatchObject({ holderId: bob.memberId, status: 'active' });
    expect(transferred.task.lease?.handoff).toBeUndefined();
    expect(store.receipts.map(item => item.leaseEvent)).toEqual(['granted', 'handoff_requested', 'granted']);
    expect(store.receipts[1]?.payload).toMatchObject({ routedTo: alice.memberId });
  });

  it('refuses a handoff grant when its recipient is no longer an active authenticated member', async () => {
    const store = new LeaseMemoryPersistence();
    const clock = { now: 100 };
    const leases = service(store, clock);
    await leases.claim(room().code, 'T-01', alice);
    await leases.requestHandoff(room().code, 'T-01', bob);
    const before = structuredClone(store.currentBoard);
    store.currentRoom = { ...store.currentRoom,
      participants: store.currentRoom.participants.filter(item => item.name !== bob.name) };

    await expect(leases.grantHandoff(room().code, 'T-01', alice))
      .rejects.toMatchObject({ name: 'task_lease_authenticated_member_required' });
    expect(store.currentBoard).toEqual(before);
    expect(store.receipts.at(-1)).toMatchObject({
      kind: 'receipt',
      payload: {
        disposition: 'refused',
        reason: 'task_lease_authenticated_member_required',
        requestedById: bob.memberId,
      },
    });
  });

  it('refuses a claim when the actor leaves between authentication and the atomic board commit', async () => {
    const store = new LeaseMemoryPersistence();
    const leases = service(store, { now: 100 });
    store.beforeLeaseCas = () => {
      store.currentRoom = { ...store.currentRoom, version: store.currentRoom.version + 1,
        participants: store.currentRoom.participants.filter(item => item.name !== alice.name) };
    };

    await expect(leases.claim(room().code, 'T-01', alice))
      .rejects.toMatchObject({ name: 'task_lease_authenticated_member_required' });
    expect(store.currentBoard.tasks[0]?.lease).toBeUndefined();
    expect(store.receipts).toEqual([]);
  });

  it('refuses a handoff grant when the recipient leaves between revalidation and the atomic board commit', async () => {
    const store = new LeaseMemoryPersistence();
    const leases = service(store, { now: 100 });
    await leases.claim(room().code, 'T-01', alice);
    await leases.requestHandoff(room().code, 'T-01', bob);
    const before = structuredClone(store.currentBoard);
    store.beforeLeaseCas = () => {
      store.currentRoom = { ...store.currentRoom, version: store.currentRoom.version + 1,
        participants: store.currentRoom.participants.filter(item => item.name !== bob.name) };
    };

    await expect(leases.grantHandoff(room().code, 'T-01', alice))
      .rejects.toMatchObject({ name: 'task_lease_authenticated_member_required' });
    expect(store.currentBoard).toEqual(before);
    expect(store.currentBoard.tasks[0]?.lease?.holderId).toBe(alice.memberId);
  });

  it.each([
    ['renew', (leases: TaskLeaseServer) => leases.renew(room().code, 'T-01', alice),
      'task_lease_holder_required'],
    ['release', (leases: TaskLeaseServer) => leases.release(room().code, 'T-01', alice),
      'task_lease_holder_required'],
    ['requestHandoff', (leases: TaskLeaseServer) => leases.requestHandoff(room().code, 'T-01', bob),
      'task_lease_not_active'],
    ['submit', (leases: TaskLeaseServer) => leases.submit(room().code, 'T-01', alice, evidence),
      'task_lease_holder_required'],
  ] as const)('persists lazy expiry before a rejected %s operation', async (_name, operate, errorName) => {
    const store = new LeaseMemoryPersistence();
    const clock = { now: 100 };
    const leases = service(store, clock);
    await leases.claim(room().code, 'T-01', alice, 10);
    clock.now = 111;

    await expect(operate(leases)).rejects.toMatchObject({ name: errorName });
    expect(store.currentBoard.tasks[0]?.lease?.status).toBe('expired');
    expect(store.receipts.map(item => item.leaseEvent)).toEqual(['granted', 'expired']);
  });
});
