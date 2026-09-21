import { wakesAgent, soleAgentOf, type Message, type Participant, type Room } from '@agent-room/shared';
import { isConfiguredModerator, isDeliverLead } from '@agent-room/upstash-client';

export type WakeFacts = {
  sole: boolean;
  humanBroadcastsToMe: boolean;
  /** Deliver mode lead: woken by agents' [RESULT] / [BLOCKER] / [DECISION] / [PLAN]. */
  deliverLead?: boolean;
};

/** Deliver-mode tags that count as a message rather than a status note. */
export const DELIVER_SIGNAL_RE = /\[(RESULT|BLOCKER|DECISION|PLAN)\]/i;

/**
 * Room facts for deciding which messages wake a seat in room_listen.
 * Human speech broadcasts in every mode except moderator and deliver, where
 * only the seat that routes the work (moderator / lead) receives it. Everyone
 * else is woken by their own assignments, reviews, and @-mentions.
 */
export function humanBroadcastsToMe(
  room: Pick<Room, 'replyMode' | 'modeConfig' | 'participants' | 'createdBy'>,
  selfName: string,
): boolean {
  if (room.replyMode === 'moderator') return !!selfName && isConfiguredModerator(room as Room, selfName, 'cc');
  if (room.replyMode === 'deliver') return !!selfName && isDeliverLead(room as Room, selfName, 'cc');
  return true;
}

/** Sole-agent + human-broadcast facts for one seat. */
export function wakeFactsForAgent(
  room: Pick<Room, 'participants' | 'replyMode' | 'modeConfig' | 'createdBy'>,
  selfName: string,
): WakeFacts {
  return {
    sole: !!selfName && soleAgentOf(room.participants as Participant[], selfName),
    humanBroadcastsToMe: humanBroadcastsToMe(room, selfName),
    ...(room.replyMode === 'deliver' && !!selfName && isDeliverLead(room as Room, selfName, 'cc')
      ? { deliverLead: true }
      : {}),
  };
}

/** The wake predicate room_listen applies to each new message. */
export function messageAddressesAgent(
  message: Pick<Message, 'type' | 'client' | 'name' | 'text' | 'metadata'>,
  selfName: string,
  facts: WakeFacts,
): boolean {
  return wakesAgent(message, selfName)
    || (facts.humanBroadcastsToMe && message.type === 'msg' && message.client === 'web' && message.name !== selfName)
    || (facts.sole && message.type === 'msg' && message.name !== selfName)
    || (!!facts.deliverLead && message.type === 'msg' && message.client === 'cc' && message.name !== selfName
      && DELIVER_SIGNAL_RE.test(message.text ?? ''));
}
