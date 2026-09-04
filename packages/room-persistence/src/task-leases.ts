import { randomUUID } from 'node:crypto';
import type {
  ClientKind,
  Participant,
  Task,
  TaskBoard,
  TaskEvidence,
  TaskLease,
} from '@agent-room/shared';
import { RoomRecordServer } from './server.js';
import type { LeaseEventInput } from './types.js';

export const DEFAULT_TASK_LEASE_TTL_MS = 15 * 60 * 1000;
export const MAX_TASK_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface LeaseActor {
  memberId: string;
  name: string;
  client: ClientKind;
}

export class TaskLeaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = code;
  }
}

type EvidenceInput = Omit<TaskEvidence, 'submittedBy' | 'submittedClient' | 'at'>;

function taskAt(board: TaskBoard, taskId: string): Task {
  const task = board.tasks.find(item => item.id === taskId);
  if (!task) throw new TaskLeaseError('task_not_found', `Task ${taskId} was not found.`);
  return task;
}

function withTask(board: TaskBoard, task: Task, at: number): TaskBoard {
  return {
    ...board,
    version: board.version + 1,
    lastProgressAt: at,
    tasks: board.tasks.map(item => item.id === task.id ? task : item),
  };
}

export class TaskLeaseServer {
  constructor(
    private readonly records: RoomRecordServer,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  private authenticatedActor(room: { status: string; participants: Participant[] } | null, actor: LeaseActor): Participant {
    const participant = room?.status === 'active' ? room.participants.find(item =>
      item.authenticatedIdentity?.cardFingerprint === actor.memberId &&
      item.name === actor.name && item.client === actor.client) : undefined;
    if (!participant) {
      throw new TaskLeaseError('task_lease_authenticated_member_required',
        'Task leases require an active authenticated room member.');
    }
    return participant;
  }

  private ttl(value?: number): number {
    const ttl = value ?? DEFAULT_TASK_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TASK_LEASE_TTL_MS) {
      throw new TaskLeaseError('task_lease_ttl_invalid', 'Task lease TTL must be between 1 ms and 24 hours.');
    }
    return ttl;
  }

  private expired(task: Task, at: number, makeEventId: () => string, actor: LeaseActor): {
    task: Task;
    events: LeaseEventInput[];
  } {
    if (!task.lease || task.lease.status !== 'active' || task.lease.expiresAt > at) {
      return { task, events: [] };
    }
    const lease: TaskLease = { ...task.lease, status: 'expired', releasedAt: at, handoff: undefined };
    return {
      task: { ...task, lease, updatedAt: at },
      events: [this.event(makeEventId(), task.id, lease, 'expired', actor, at)],
    };
  }

  private event(
    id: string,
    taskId: string,
    lease: TaskLease,
    event: LeaseEventInput['event'],
    actor: LeaseActor,
    at: number,
    details: Record<string, unknown> = {},
  ): LeaseEventInput {
    return {
      id, roomCode: '', event, actor: actor.memberId, leaseId: lease.id, at,
      details: { taskId, actorName: actor.name, holderId: lease.holderId, holderName: lease.holderName, ...details },
    };
  }

  private async mutate(
    code: string,
    taskId: string,
    actor: LeaseActor,
    operation: (task: Task, at: number, makeEventId: () => string) =>
      { task: Task; events: LeaseEventInput[] } | Promise<{ task: Task; events: LeaseEventInput[] }>,
  ): Promise<{ board: TaskBoard; task: Task }> {
    const operationId = this.newId();
    const ids: string[] = [];
    let idIndex = 0;
    const makeEventId = () => {
      const index = idIndex++;
      return ids[index] ?? (ids[index] = `lease-event-${operationId}-${String(index).padStart(2, '0')}`);
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      idIndex = 0;
      const room = await this.records.getRoom(code);
      this.authenticatedActor(room, actor);
      const board = await this.records.getTaskBoard(code);
      if (!board) throw new TaskLeaseError('task_board_not_found', 'Task board was not found.');
      const at = this.now();
      const swept = this.expired(taskAt(board, taskId), at, makeEventId, actor);
      let result: { task: Task; events: LeaseEventInput[]; members?: LeaseActor[] };
      try {
        result = await operation(swept.task, at, makeEventId);
      } catch (error) {
        if (swept.events.length === 0) throw error;
        const expiredBoard = withTask(board, swept.task, at);
        const expiryEvents = swept.events.map(event => ({ ...event, roomCode: code }));
        if (await this.records.updateTaskBoardWithLeaseEvents(
          code, board.version, expiredBoard, expiryEvents,
          { roomVersion: room!.version, members: [actor] },
        )) throw error;
        continue;
      }
      const next = withTask(board, result.task, at);
      const events = [...swept.events, ...result.events]
        .map(event => ({ ...event, roomCode: code }));
      if (await this.records.updateTaskBoardWithLeaseEvents(code, board.version, next, events,
        { roomVersion: room!.version, members: [actor, ...(result.members ?? [])] })) {
        return { board: next, task: result.task };
      }
    }
    throw new TaskLeaseError('task_lease_contention', 'Task lease could not be updated after concurrent changes.');
  }

  claim(code: string, taskId: string, actor: LeaseActor, ttlMs?: number) {
    const ttl = this.ttl(ttlMs);
    const leaseId = `task-lease-${this.newId()}`;
    return this.mutate(code, taskId, actor, (task, at, eventId) => {
      if (task.lease?.status === 'active') {
        throw new TaskLeaseError('task_lease_held', `Task lease is held by ${task.lease.holderName}.`);
      }
      const lease: TaskLease = {
        id: leaseId, holderId: actor.memberId, holderName: actor.name, holderClient: actor.client,
        status: 'active', grantedAt: at, expiresAt: at + ttl,
      };
      return {
        task: { ...task, lease, updatedAt: at },
        events: [this.event(eventId(), taskId, lease, 'granted', actor, at)],
      };
    });
  }

  renew(code: string, taskId: string, actor: LeaseActor, ttlMs?: number) {
    const ttl = this.ttl(ttlMs);
    return this.mutate(code, taskId, actor, (task, at, eventId) => {
      const lease = task.lease;
      if (!lease || lease.status !== 'active' || lease.holderId !== actor.memberId) {
        throw new TaskLeaseError('task_lease_holder_required', 'Only the active lease holder may renew.');
      }
      const renewed: TaskLease = { ...lease, renewedAt: at, expiresAt: at + ttl };
      return { task: { ...task, lease: renewed, updatedAt: at },
        events: [this.event(eventId(), taskId, renewed, 'renewed', actor, at)] };
    });
  }

  release(code: string, taskId: string, actor: LeaseActor) {
    return this.mutate(code, taskId, actor, (task, at, eventId) => {
      const lease = task.lease;
      if (!lease || lease.status !== 'active' || lease.holderId !== actor.memberId) {
        throw new TaskLeaseError('task_lease_holder_required', 'Only the active lease holder may release.');
      }
      const released: TaskLease = { ...lease, status: 'released', releasedAt: at, handoff: undefined };
      return { task: { ...task, lease: released, updatedAt: at },
        events: [this.event(eventId(), taskId, released, 'released', actor, at)] };
    });
  }

  requestHandoff(code: string, taskId: string, actor: LeaseActor) {
    return this.mutate(code, taskId, actor, (task, at, eventId) => {
      const lease = task.lease;
      if (!lease || lease.status !== 'active') {
        throw new TaskLeaseError('task_lease_not_active', 'Task has no active lease holder.');
      }
      if (lease.holderId === actor.memberId) {
        throw new TaskLeaseError('task_lease_handoff_self', 'The holder cannot request a handoff from itself.');
      }
      const requested: TaskLease = { ...lease, handoff: {
        requestedById: actor.memberId, requestedByName: actor.name,
        requestedByClient: actor.client, requestedAt: at,
      } };
      return { task: { ...task, lease: requested, updatedAt: at },
        events: [this.event(eventId(), taskId, requested, 'handoff_requested', actor, at,
          { routedTo: lease.holderId })] };
    });
  }

  grantHandoff(code: string, taskId: string, actor: LeaseActor, ttlMs?: number) {
    const ttl = this.ttl(ttlMs);
    return this.mutate(code, taskId, actor, async (task, at, eventId) => {
      const lease = task.lease;
      if (!lease || lease.status !== 'active' || lease.holderId !== actor.memberId) {
        throw new TaskLeaseError('task_lease_holder_required', 'Only the active holder may grant a handoff.');
      }
      if (!lease.handoff) throw new TaskLeaseError('task_lease_handoff_missing', 'No handoff is pending.');
      try {
        const recipient = {
          memberId: lease.handoff.requestedById,
          name: lease.handoff.requestedByName,
          client: lease.handoff.requestedByClient,
        };
        this.authenticatedActor(await this.records.getRoom(code), recipient);
      } catch (error) {
        await this.records.appendReceipt({
          id: `handoff-refusal-${eventId()}`,
          roomCode: code,
          kind: 'receipt',
          createdAt: at,
          payload: {
            disposition: 'refused',
            reason: 'task_lease_authenticated_member_required',
            taskId,
            requestedById: lease.handoff.requestedById,
            holderId: actor.memberId,
          },
        });
        throw error;
      }
      const transferred: TaskLease = {
        ...lease,
        holderId: lease.handoff.requestedById,
        holderName: lease.handoff.requestedByName,
        holderClient: lease.handoff.requestedByClient,
        grantedAt: at,
        expiresAt: at + ttl,
        renewedAt: undefined,
        releasedAt: undefined,
        handoff: undefined,
      };
      return { task: { ...task, lease: transferred, updatedAt: at }, members: [{
          memberId: transferred.holderId, name: transferred.holderName, client: transferred.holderClient,
        }],
        events: [this.event(eventId(), taskId, transferred, 'granted', actor, at,
          { transferredFrom: actor.memberId })] };
    });
  }

  submit(code: string, taskId: string, actor: LeaseActor, evidence: EvidenceInput) {
    if (!evidence.fileListing.trim() || !evidence.fileExcerpt.trim() ||
      !evidence.runOutput.trim() || !Number.isInteger(evidence.exitCode)) {
      throw new TaskLeaseError('task_evidence_invalid', 'Task evidence must contain all proof fields and an exit code.');
    }
    return this.mutate(code, taskId, actor, (task, at) => {
      const lease = task.lease;
      if (lease && (lease.status !== 'active' || lease.holderId !== actor.memberId)) {
        throw new TaskLeaseError('task_lease_holder_required',
          'Only the active lease holder may submit changes to this task.');
      }
      const submitted: Task = { ...task, state: 'awaiting_review', updatedAt: at,
        evidence: { ...evidence, submittedBy: actor.name, submittedClient: actor.client, at } };
      return { task: submitted, events: [] };
    });
  }
}
