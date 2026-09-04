import type { Message, Room, RoomReport, TaskBoard } from '@agent-room/shared';
import { createRoomPersistence, type PersistenceDependencies, type PersistenceEnvironment } from './factory.js';
import type { LeaseEventInput, RoomPersistence, RoomReceipt } from './types.js';

/**
 * Server-side production entry for durable room records. Business-rule layers
 * call this object; only the selected adapter knows Redis or Postgres.
 */
export class RoomRecordServer {
  constructor(readonly persistence: RoomPersistence) {}

  static async fromEnvironment(
    env: PersistenceEnvironment,
    dependencies: PersistenceDependencies = {},
  ): Promise<RoomRecordServer> {
    return new RoomRecordServer(await createRoomPersistence(env, dependencies));
  }

  createRoom(room: Room): Promise<void> { return this.persistence.createRoom(room); }
  getRoom(code: string): Promise<Room | null> { return this.persistence.getRoom(code); }
  updateRoom(code: string, expectedVersion: number, next: Room): Promise<boolean> {
    return this.persistence.compareAndSwapRoom(code, expectedVersion, next);
  }
  appendMessage(code: string, message: Message): Promise<number> {
    return this.persistence.appendMessage(code, message);
  }
  listMessages(code: string, fromSequence: number): Promise<Message[]> {
    return this.persistence.listMessages(code, fromSequence);
  }
  getTaskBoard(code: string): Promise<TaskBoard | null> {
    return this.persistence.getTaskBoard(code);
  }
  updateTaskBoard(code: string, expectedVersion: number | null, next: TaskBoard): Promise<boolean> {
    return this.persistence.compareAndSwapTaskBoard(code, expectedVersion, next);
  }
  putMinutes(code: string, reportId: string, report: RoomReport): Promise<void> {
    return this.persistence.putMinutes(code, reportId, report);
  }
  getMinutes(code: string, reportId: string): Promise<RoomReport | null> {
    return this.persistence.getMinutes(code, reportId);
  }
  appendReceipt(receipt: RoomReceipt): Promise<boolean> {
    return this.persistence.appendReceipt(receipt);
  }
  appendLeaseEvent(event: LeaseEventInput): Promise<boolean> {
    return this.persistence.appendLeaseEvent(event);
  }
  listReceipts(code: string): Promise<RoomReceipt[]> {
    return this.persistence.listReceipts(code);
  }
  close(): Promise<void> { return this.persistence.close(); }
}
