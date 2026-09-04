import type { Message, Room, RoomReport, TaskBoard } from '@agent-room/shared';

export type PersistenceKind = 'redis' | 'postgres';

export type LeaseEventName =
  | 'granted'
  | 'renewed'
  | 'released'
  | 'expired'
  | 'handoff_requested';

export interface RoomReceipt {
  id: string;
  roomCode: string;
  kind: 'receipt' | 'lease_event';
  createdAt: number;
  payload: Readonly<Record<string, unknown>>;
  leaseEvent?: LeaseEventName;
}

export interface LeaseEventInput {
  id: string;
  roomCode: string;
  event: LeaseEventName;
  actor: string;
  leaseId: string;
  at: number;
  details?: Readonly<Record<string, unknown>>;
}

export interface RoomPersistence {
  readonly kind: PersistenceKind;

  createRoom(room: Room): Promise<void>;
  getRoom(code: string): Promise<Room | null>;
  compareAndSwapRoom(code: string, expectedVersion: number, next: Room): Promise<boolean>;

  appendMessage(code: string, message: Message): Promise<number>;
  listMessages(code: string, fromSequence: number): Promise<Message[]>;

  getTaskBoard(code: string): Promise<TaskBoard | null>;
  compareAndSwapTaskBoard(
    code: string,
    expectedVersion: number | null,
    next: TaskBoard,
  ): Promise<boolean>;

  putMinutes(code: string, reportId: string, report: RoomReport): Promise<void>;
  getMinutes(code: string, reportId: string): Promise<RoomReport | null>;

  appendReceipt(receipt: RoomReceipt): Promise<boolean>;
  appendLeaseEvent(event: LeaseEventInput): Promise<boolean>;
  listReceipts(code: string): Promise<RoomReceipt[]>;

  close(): Promise<void>;
}

export class PersistenceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceConfigurationError';
  }
}

export class PersistenceSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceSchemaError';
  }
}
