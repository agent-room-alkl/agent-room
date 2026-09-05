import { useRef, useState, useEffect, useCallback, type ClipboardEvent, type DragEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useRoom } from '../hooks/useRoom.js';
import { useTaskBoard } from '../hooks/useTaskBoard.js';
import { Bubble } from '../components/Bubble.js';
import { TaskBoard, canRuleOn } from '../components/TaskBoard.js';
import { VoiceButton } from '../components/VoiceButton.js';
import { MeetingCodePill } from '../components/MeetingCodePill.js';
import { Avatar } from '../components/Avatar.js';
import { AgentRoomLogo } from '../components/AgentRoomLogo.js';
import { colorForName, initialsFor } from '../lib/colors.js';
import { PRESENCE_STALE_MS, PRESENCE_DISCONNECTED_MS, extractArtifacts, type Message, type MessageAttachment, type Participant, type ReplyMode, type ReplyModeConfig, type SystemEventType } from '@agent-room/shared';
import { appendSystemMessage, directInvoke, getTurnState, hostSkipCurrent, setMuted, setReplyMode, createClient, createRoomReport, endRoom as endRoomApi, reactivateRoom as reactivateRoomApi, removeParticipant, type TurnState } from '@agent-room/upstash-client';
import { ENV } from '../env.js';
import { copyText } from '../lib/copy.js';
import { templateById } from '../lib/templates.js';
import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, deleteRoomBlobs, formatBytes, uploadAttachment } from '../lib/upload.js';

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour — long enough that humans + agents discussing intermittently don't trip it
const AUTO_CLOSE_COUNTDOWN = 5;          // seconds
interface SelfIdentity { name: string; role: string }

function readStoredSelf(code: string): SelfIdentity | null {
  const stored = sessionStorage.getItem(`room:${code}:self`);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as SelfIdentity;
  } catch {
    return null;
  }
}

// Cap auto-grow at ~8 lines so the input never eats the whole feed.
const TEXTAREA_MAX_HEIGHT = 200;
const TEXTAREA_MIN_HEIGHT = 42;

export function Room() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  // Identity is whatever Join wrote into sessionStorage. If it's missing
  // (visiting /r/CODE without going through Join — e.g. an invite link
  // someone forwarded after pruning the path), we redirect to /j/CODE
  // below. We previously "recovered" by becoming room.createdBy, which
  // silently impersonated the host for any unknown visitor.
  const [self, _setSelf] = useState<SelfIdentity | null>(() => readStoredSelf(code));
  useEffect(() => {
    if (!self) navigate(`/j/${code}`, { replace: true });
  }, [self, code, navigate]);
  const { room, messages, error, sendMessage, refreshRoom, forceRefresh } = useRoom(code, self?.name ?? '');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [turnState, setTurnState] = useState<TurnState | null>(null);
  const [now, setNow] = useState(Date.now());
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  // Auto-grow the textarea: shrink to min, then expand to scrollHeight up to max.
  // Runs after every value change (typed, pasted, Draft injected, voice transcript).
  function autoGrow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT), TEXTAREA_MAX_HEIGHT);
    el.style.height = `${next}px`;
  }
  useEffect(() => {
    autoGrow(textareaRef.current);
  }, [text]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  // --- Share ---
  const joinUrl = `${window.location.origin}/j/${code}`;

  // --- End meeting ---
  const [ended, setEnded] = useState(false);
  const [showIdlePrompt, setShowIdlePrompt] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_CLOSE_COUNTDOWN);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMsgTimeRef = useRef(Date.now());

  // Sync ended state from room — both directions, so a server-side reactivation
  // (or another client reactivating) flips us back to active too.
  useEffect(() => {
    if (room?.status === 'ended') setEnded(true);
    else if (room?.status === 'active') setEnded(false);
  }, [room?.status]);

  useEffect(() => {
    if (!room || (room.replyMode ?? 'open') === 'open') {
      setTurnState(null);
      return;
    }
    let cancelled = false;
    async function pullTurnState() {
      try {
        const client = createClient(ENV.upstash);
        const next = await getTurnState(client, code);
        if (!cancelled) setTurnState(next);
      } catch {
        if (!cancelled) setTurnState(null);
      }
    }
    void pullTurnState();
    const id = window.setInterval(() => void pullTurnState(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [code, room?.replyMode, messages.length, room?.version]);

  // Template opener: if CreateMeeting stashed a template id for this room and
  // the host is opening an empty room, post the template's opening message
  // once and clear the marker. Guarded by `messages.length === 0` so a host
  // re-entering an active room doesn't re-post the opener.
  const openerSentRef = useRef(false);
  useEffect(() => {
    if (!room || !self || ended || openerSentRef.current) return;
    if (room.createdBy !== self.name) return;
    if (messages.length !== 0) return;
    const key = `room:pending-template:${code}`;
    const tplId = sessionStorage.getItem(key);
    const tpl = templateById(tplId);
    if (!tpl || !tpl.openingMessage) return;
    openerSentRef.current = true;
    sessionStorage.removeItem(key);
    const msg: Message = {
      id: Date.now(),
      type: 'msg',
      name: self.name,
      role: self.role || 'host',
      initials: initialsFor(self.name),
      color: colorForName(self.name),
      client: 'web',
      text: tpl.openingMessage,
      time: Date.now(),
    };
    sendMessage(msg).catch(() => {
      // If sending fails, give the user another shot on next mount by
      // clearing our local guard. The sessionStorage key is already gone,
      // so they'd need to re-create the room — acceptable miss for v1.
      openerSentRef.current = false;
    });
  }, [room, self, ended, messages.length, code, sendMessage]);

  // Detect being kicked: once we've seen ourselves in the participants list
  // (so we know the room poll is working), if we then disappear from it we
  // were removed. Redirect to /j/CODE so the user can rejoin if they want,
  // and show a toast to make it not feel like a network glitch.
  const sawSelfRef = useRef(false);
  useEffect(() => {
    if (!room || !self || ended) return;
    const presentNow = room.participants.some(p => p.name === self.name && p.client === 'web');
    if (presentNow) {
      sawSelfRef.current = true;
      return;
    }
    if (sawSelfRef.current) {
      // We were here, now we're not — host kicked us.
      sessionStorage.removeItem(`room:${code}:self`);
      (async () => {
        const { showToast } = await import('../components/Toast.js');
        showToast('You were removed from the meeting by the host');
      })();
      navigate(`/j/${code}`, { replace: true });
    }
  }, [room, self, ended, code, navigate]);

  // Track last message time for idle detection
  useEffect(() => {
    if (messages.length > 0) {
      lastMsgTimeRef.current = Date.now();
      // Reset idle prompt if new message arrives
      if (showIdlePrompt) {
        setShowIdlePrompt(false);
        setCountdown(AUTO_CLOSE_COUNTDOWN);
        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      }
    }
  }, [messages.length]);

  // Idle timer: show prompt after 5 min of no messages
  useEffect(() => {
    if (ended) return;

    function resetIdle() {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        setShowIdlePrompt(true);
      }, IDLE_TIMEOUT_MS);
    }

    resetIdle();
    // Reset on new messages
    const interval = setInterval(() => {
      if (Date.now() - lastMsgTimeRef.current < IDLE_TIMEOUT_MS) return;
      if (!showIdlePrompt) setShowIdlePrompt(true);
    }, 10_000);

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      clearInterval(interval);
    };
  }, [ended, messages.length]);

  // Auto-close countdown
  useEffect(() => {
    if (!showIdlePrompt || ended) return;

    setCountdown(AUTO_CLOSE_COUNTDOWN);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          handleEndMeeting();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    };
  }, [showIdlePrompt, ended]);

  const dismissIdlePrompt = useCallback(() => {
    setShowIdlePrompt(false);
    setCountdown(AUTO_CLOSE_COUNTDOWN);
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    lastMsgTimeRef.current = Date.now(); // reset idle clock
  }, []);

  // Host-only. Toggle mute on a participant. Muted participants stay in
  // the room (presence + read access intact) but room_send is rejected
  // server-side until they're unmuted.
  async function handleToggleMute(p: { name: string; client: 'web' | 'cc'; canSpeak?: boolean }) {
    if (!room || !self || room.createdBy !== self.name) return;
    const wantMuted = p.canSpeak !== false; // currently can speak → going to mute
    try {
      const client = createClient(ENV.upstash);
      await setMuted(client, code, self.name, p.name, p.client, wantMuted);
      await refreshRoom();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Mute toggle failed: ${e.message}` : 'Mute toggle failed');
    }
  }

  // Host-only. Removes (name, client) from the room. The kicked client will
  // notice it's gone on its next room poll / room_listen and can be told to
  // leave by their UI. Reconnection is not blocked — they'd need to be re-joined.
  async function handleKick(p: { name: string; client: 'web' | 'cc' }) {
    if (!room || !self || room.createdBy !== self.name) return;
    if (p.name === self.name && p.client === 'web') return; // host can't kick themselves
    if (!confirm(`Remove ${p.name} (${p.client}) from the room?`)) return;
    try {
      const client = createClient(ENV.upstash);
      await removeParticipant(client, code, self.name, p.name, p.client);
      await refreshRoom();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Kick failed: ${e.message}` : 'Kick failed');
    }
  }

  async function handleEndMeeting() {
    try {
      const client = createClient(ENV.upstash);
      await endRoomApi(client, code);
      setEnded(true);
      setShowIdlePrompt(false);
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
      // Per Robin: attachments shouldn't outlive the meeting. Fire-and-
      // forget so a Blob hiccup doesn't keep the user staring at a spinner.
      // Best-effort only — TTL expiry is handled by a cron sweep later.
      void deleteRoomBlobs(code);
    } catch {
      // ignore — room may already be ended
      setEnded(true);
    }
  }

  const [mobilePanel, setMobilePanel] = useState<'chat' | 'tasks' | 'people'>('chat');
  const [reportBusy, setReportBusy] = useState(false);
  const artifacts = extractArtifacts(messages);
  // Board lives here, not inside TaskBoard, so the tab strip can badge how
  // many deliveries are waiting on a ruling while the user is on Chat.
  const taskBoard = useTaskBoard(code);
  const openTaskCount = taskBoard.board?.tasks.filter(
    t => t.state !== 'done' && t.state !== 'rejected' && t.state !== 'cancelled',
  ).length ?? 0;
  const reviewTaskCount = taskBoard.board?.tasks.filter(
    t => canRuleOn(t, { name: self?.name ?? '', client: 'web' }, ended),
  ).length ?? 0;

  async function handleExportReport() {
    if (!room) return;
    setReportBusy(true);
    try {
      const client = createClient(ENV.upstash);
      await createRoomReport(client, room, messages);
      // A1: copy the permanent share link to clipboard alongside navigating.
      // The report key is stored without TTL (see packages/upstash-client/src/reports.ts),
      // so the link survives past the 24h room TTL — that's exactly the "Save"
      // half of "Save & Share". Copy first so the toast lives across the
      // route change (ToastHost is mounted at router level).
      const reportUrl = `${window.location.origin}/r/${code}/report`;
      await copyText(reportUrl, 'Saved — share link copied to clipboard');
      navigate(`/r/${code}/report`);
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Export failed: ${e.message}` : 'Export failed');
    } finally {
      setReportBusy(false);
    }
  }

  useEffect(() => {
    feedRef.current?.scrollTo(0, feedRef.current.scrollHeight);
  }, [messages.length]);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const resetOnDesktop = () => {
      if (mq.matches) setMobilePanel('chat');
    };
    resetOnDesktop();
    mq.addEventListener('change', resetOnDesktop);
    return () => mq.removeEventListener('change', resetOnDesktop);
  }, []);

  if (error) return <div className="p-10 text-red-600">{error}</div>;
  if (!self) return <div className="p-10 text-ink-soft">Redirecting to join…</div>;
  if (!room) return <div className="p-10 text-ink-soft">Loading…</div>;

  // From here down `self` is non-null (early-returned above). Capture it in a
  // narrowed const so closures inside JSX don't have to re-check.
  const me = self;
  const activeRoom = room;

  // Speaking gate: the host is always allowed; other participants need the
  // Speaking gate: everyone joins able to speak. The host can mute via
  // setMuted() to suspend a specific participant. canSpeak === undefined
  // (legacy rooms before this field existed) is treated as approved so
  // already-running meetings don't break.
  const isHost = room.createdBy === me.name;
  const myParticipant = room.participants.find(p => p.name === me.name && p.client === 'web');
  const myCanSpeak = isHost || myParticipant?.canSpeak !== false;
  const mutedCount = room.participants.filter(p => p.canSpeak === false).length;
  const replyMode = activeRoom.replyMode ?? 'open';
  const replyModeConfig = activeRoom.modeConfig;
  const canConfigureReplyMode = isHost && !ended;
  const roomAgents = activeRoom.participants.filter(p => p.client === 'cc');
  const activeRoomAgents = roomAgents.filter(p => p.canSpeak !== false);
  const fallbackAgent = activeRoomAgents[0] ?? roomAgents[0];
  const selectedLeadAgentName = replyModeConfig?.leadAgentName ?? fallbackAgent?.name ?? '';
  const selectedModeratorAgentName = replyModeConfig?.moderatorAgentName ?? fallbackAgent?.name ?? '';
  const currentSpeaker = turnState?.currentName && turnState.currentClient
    ? activeRoom.participants.find(p => p.name === turnState.currentName && p.client === turnState.currentClient)
    : undefined;
  const currentDeadlineMs = turnState?.deadline ? Math.max(0, turnState.deadline - now) : null;

  function modeLabel(mode: ReplyMode): string {
    if (mode === 'sequential') return 'Sequential';
    if (mode === 'moderator') return 'Moderator';
    return 'Open';
  }

  function buildModeConfig(mode: ReplyMode, overrides: Partial<ReplyModeConfig> = {}): ReplyModeConfig | undefined {
    const timeoutMs = replyModeConfig?.timeoutMs;
    if (mode === 'open') return timeoutMs ? { timeoutMs } : undefined;

    const base: ReplyModeConfig = { ...(replyModeConfig ?? {}), ...overrides };
    if (mode === 'sequential') {
      const leadName = overrides.leadAgentName ?? base.leadAgentName ?? fallbackAgent?.name;
      return {
        ...base,
        ...(timeoutMs ? { timeoutMs } : {}),
        leadAgentName: leadName,
        leadAgentClient: leadName ? 'cc' : undefined,
      };
    }

    const moderatorName = overrides.moderatorAgentName ?? base.moderatorAgentName ?? fallbackAgent?.name;
    return {
      ...base,
      ...(timeoutMs ? { timeoutMs } : {}),
      moderatorAgentName: moderatorName,
      moderatorAgentClient: moderatorName ? 'cc' : undefined,
    };
  }

  async function updateReplyMode(mode: ReplyMode, overrides: Partial<ReplyModeConfig> = {}) {
    if (!canConfigureReplyMode) return;
    const nextConfig = buildModeConfig(mode, overrides);
    if (mode !== 'open' && !fallbackAgent) {
      const { showToast } = await import('../components/Toast.js');
      showToast('Add an agent before enabling Sequential or Moderator mode.');
      return;
    }
    setModeBusy(true);
    try {
      const client = createClient(ENV.upstash);
      await setReplyMode(client, code, me.name, mode, nextConfig);
      await refreshRoom();
      const { showToast } = await import('../components/Toast.js');
      showToast(`Reply mode set to ${modeLabel(mode)}.`);
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Mode change failed: ${e.message}` : 'Mode change failed');
    } finally {
      setModeBusy(false);
    }
  }

  async function refreshTurnAndMessages() {
    try {
      const client = createClient(ENV.upstash);
      setTurnState(await getTurnState(client, code));
    } catch {
      setTurnState(null);
    }
    await forceRefresh();
  }

  async function emitTurnSystemMessage(
    textValue: string,
    eventType: SystemEventType,
    target: { name: string; client: 'web' | 'cc' },
    extra: Partial<NonNullable<Message['metadata']>> = {},
  ) {
    const client = createClient(ENV.upstash);
    const nowMs = Date.now();
    const msg: Message = {
      id: nowMs,
      type: 'sys',
      name: 'system',
      role: '',
      initials: 'AR',
      color: '#5B6AFF',
      client: 'cc',
      text: textValue,
      time: nowMs,
      metadata: {
        eventType,
        modeAtSend: replyMode,
        targetAgentName: target.name,
        targetAgentClient: target.client,
        ...extra,
      },
    };
    await appendSystemMessage(client, code, msg);
  }

  async function handleAskAgent(p: Participant) {
    if (!canConfigureReplyMode || p.client !== 'cc') return;
    if (replyMode === 'open') {
      appendText(`@${p.name} `);
      return;
    }
    if (!turnState) {
      const { showToast } = await import('../components/Toast.js');
      showToast('Send a message first, then ask an agent inside that turn.');
      return;
    }
    setModeBusy(true);
    try {
      const client = createClient(ENV.upstash);
      const added = await directInvoke(client, code, { name: p.name, client: p.client }, 'host');
      if (!added) {
        const { showToast } = await import('../components/Toast.js');
        showToast(`${p.name} is already queued for a direct reply.`);
        return;
      }
      await emitTurnSystemMessage(
        `Host directly invoked @${p.name}.`,
        'host_invoked',
        { name: p.name, client: p.client },
        { invocationType: 'host_directed' },
      );
      await refreshTurnAndMessages();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Ask failed: ${e.message}` : 'Ask failed');
    } finally {
      setModeBusy(false);
    }
  }

  async function handleSkipCurrent() {
    if (!canConfigureReplyMode || !currentSpeaker) return;
    setModeBusy(true);
    try {
      const client = createClient(ENV.upstash);
      const skipped = await hostSkipCurrent(client, code, activeRoom);
      if (!skipped) {
        const { showToast } = await import('../components/Toast.js');
        showToast('No active agent to skip.');
        return;
      }
      await emitTurnSystemMessage(
        `Host skipped @${skipped.name}'s ${skipped.role} slot.`,
        'skipped_by_host',
        { name: skipped.name, client: skipped.client },
        { roleAtSend: skipped.role, skippedBy: 'host' },
      );
      await refreshTurnAndMessages();
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Skip failed: ${e.message}` : 'Skip failed');
    } finally {
      setModeBusy(false);
    }
  }

  function fillPrompt(kind: 'minutes' | 'reply') {
    const agent = activeRoom.participants.find(p => p.client !== 'web' && p.canSpeak !== false)?.name ?? 'Claude';
    const target = `@${agent}`;
    const prompt = kind === 'minutes'
      ? `${target} Please generate concise meeting minutes for this room. Include topic, participants, key decisions, open questions, and action items. Use markdown.`
      : `${target} Please draft a concise reply to the latest message in this room. Keep it practical and mention any assumptions.`;
    setText(prompt);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      autoGrow(textareaRef.current);
    });
  }

  async function send() {
    const body = text.trim();
    if ((!body && attachments.length === 0) || ended) return;
    const msg: Message = {
      id: Date.now(),
      type: 'msg',
      name: me.name,
      role: me.role,
      initials: initialsFor(me.name),
      color: colorForName(me.name),
      client: 'web',
      text: body,
      time: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    setText('');
    setAttachments([]);
    try {
      await sendMessage(msg);
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? `Send failed: ${e.message}` : 'Send failed');
      setText(body); // restore draft
      setAttachments(attachments);
    }
  }

  async function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    setAttachBusy(true);
    try {
      const slots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length);
      const selected = incoming.slice(0, slots);
      if (incoming.length > slots) {
        const { showToast } = await import('../components/Toast.js');
        showToast(`Only ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
      }
      const prepared: MessageAttachment[] = [];
      for (const file of selected) {
        prepared.push(await uploadAttachment(file, code));
      }
      setAttachments(prev => [...prev, ...prepared].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
    } catch (e) {
      const { showToast } = await import('../components/Toast.js');
      showToast(e instanceof Error ? e.message : 'Attachment failed');
    } finally {
      setAttachBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function appendText(value: string) {
    setText(prev => {
      if (!prev.trim()) return value;
      return `${prev}\n${value}`;
    });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      autoGrow(textareaRef.current);
    });
  }

  async function fileFromUrl(url: string): Promise<File | null> {
    try {
      const parsed = new URL(url);
      const resp = await fetch(parsed.toString());
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!ALLOWED_ATTACHMENT_TYPES.has(blob.type)) return null;
      const pathName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'attachment');
      const fallbackName = blob.type.startsWith('image/') ? 'image' : 'attachment';
      const name = pathName.includes('.') ? pathName : `${fallbackName}.${blob.type.split('/')[1] ?? 'bin'}`;
      return new File([blob], name, { type: blob.type });
    } catch {
      return null;
    }
  }

  async function filesFromDrop(dataTransfer: DataTransfer, uri: string): Promise<File[]> {
    const droppedFiles = Array.from(dataTransfer.files);
    if (droppedFiles.length > 0) return droppedFiles;
    if (!uri) return [];
    const file = await fileFromUrl(uri);
    return file ? [file] : [];
  }

  function handleDragEnter(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  async function handleDrop(e: DragEvent<HTMLElement>) {
    if (ended) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);

    const uri = e.dataTransfer.getData('text/uri-list').split('\n').find(line => line && !line.startsWith('#')) ?? '';
    const plainText = e.dataTransfer.getData('text/plain');
    const files = await filesFromDrop(e.dataTransfer, uri);
    if (files.length > 0) {
      await addFiles(files);
      return;
    }

    const textValue = plainText || uri;
    if (textValue.trim()) appendText(textValue.trim());
  }

  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    await addFiles(files);
  }

  return (
    <div className="h-full flex items-center justify-center p-0 sm:px-3 sm:py-4">
      <div className="w-full max-w-7xl h-full sm:h-[88vh] grid grid-rows-[auto_auto_1fr] bg-surface border-0 sm:border border-border rounded-none sm:rounded-xl shadow-none sm:shadow-card overflow-hidden">
        <header className="px-3.5 py-2.5 sm:px-4 sm:py-3 border-b border-border-faint flex justify-between items-center bg-surface shrink-0">
          <div className="min-w-0 flex items-center gap-2.5 sm:gap-3">
            <AgentRoomLogo showWordmark={false} markClassName="h-7 w-7 sm:h-8 sm:w-8" />
            <div className="min-w-0">
              <div className="text-xs sm:text-sm font-semibold truncate text-ink">{room.topic}</div>
              <div className="text-[10px] text-ink-soft flex items-center gap-1.5">
                {ended ? (
                  <span className="text-red-500 font-semibold">Meeting ended</span>
                ) : (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>{room.participants.length} participants</span>
                    <span className="hidden lg:inline">· {messages.length} messages</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div className="hidden sm:flex">
              {room.participants.slice(0, 5).map((p, i) => (
                <div key={p.name} style={{ marginLeft: i === 0 ? 0 : -6 }} className="ring-2 ring-white rounded-full">
                  <Avatar initials={p.initials} color={p.color} size="sm" />
                </div>
              ))}
            </div>
            <button
              onClick={() => copyText(joinUrl, 'Invite link copied')}
              className="text-[11px] sm:text-[10px] font-semibold text-accent bg-accent-tint px-2.5 py-1.5 sm:px-2 sm:py-1 rounded-md hover:bg-accent/20 active:scale-95 transition"
            >
              Share
            </button>
            <MeetingCodePill code={code} />
          </div>
        </header>

        {/*
          Mobile tab strip. Tasks sits second because handing work to an agent
          and ruling on what came back is the reason a host opens this on a
          phone; People is the occasional admin trip. 44px targets (the old
          38px row was hard to hit one-handed), and the Tasks tab carries an
          amber count when deliveries are waiting on a ruling so the signal
          reaches the user while they are still reading Chat.
        */}
        <div className="lg:hidden grid grid-cols-3 gap-1.5 border-b border-border-faint bg-surface-softer p-1.5 shrink-0" role="tablist">
          {([
            ['chat', 'Chat', messages.length, false],
            ['tasks', 'Tasks', openTaskCount, reviewTaskCount > 0],
            ['people', 'People', room.participants.length, false],
          ] as const).map(([key, label, count, alert]) => {
            const active = mobilePanel === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                onClick={() => setMobilePanel(key)}
                className={`min-h-11 rounded-lg px-2 text-[13px] font-semibold flex items-center justify-center gap-1.5 transition active:scale-[0.98] ${
                  active
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-ink-muted hover:text-ink bg-surface border border-border-faint'
                }`}
              >
                <span>{label}</span>
                <span
                  className={`text-[11px] px-1.5 py-0.5 rounded-full font-bold ${
                    active
                      ? 'bg-white/25 text-white'
                      : alert
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-surface-sunken text-ink-faint'
                  }`}
                >
                  {alert ? `${reviewTaskCount} review` : count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-h-0 min-w-0 overflow-x-hidden grid lg:grid-cols-[260px_minmax(0,1fr)_340px] bg-surface-soft">
          <aside className={`${mobilePanel === 'people' ? 'flex' : 'hidden'} lg:flex min-h-0 min-w-0 flex-col border-r border-border-faint bg-surface`}>
            <div className="p-4 border-b border-border-faint">
              <h2 className="hidden lg:block text-sm font-semibold leading-snug">{room.topic}</h2>
              <div className="hidden lg:block mt-3">
                <MeetingCodePill code={code} />
              </div>
              <button
                onClick={() => copyText(joinUrl, 'Invite link copied')}
                className="mt-3 w-full min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-accent bg-accent-tint px-3 rounded-lg transition active:scale-[0.98] hover:bg-accent/20"
              >
                Copy invite link
              </button>
              <div className="mt-3 lg:mt-3 rounded-lg border border-border-faint bg-surface-softer p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold text-ink-muted">Who replies</span>
                </div>
                {canConfigureReplyMode ? (
                  <div className="space-y-2">
                    <select
                      value={replyMode}
                      onChange={e => { void updateReplyMode(e.target.value as ReplyMode); }}
                      disabled={modeBusy}
                      className="h-11 sm:h-9 w-full rounded-lg border border-border bg-white px-2.5 text-[15px] sm:text-xs font-semibold text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-60"
                    >
                      <option value="open">Open</option>
                      <option value="sequential">Sequential</option>
                      <option value="moderator">Moderator</option>
                    </select>
                    {replyMode === 'sequential' && (
                      <select
                        value={selectedLeadAgentName}
                        onChange={e => { void updateReplyMode('sequential', { leadAgentName: e.target.value, leadAgentClient: 'cc' }); }}
                        disabled={modeBusy || activeRoomAgents.length === 0}
                        className="h-11 sm:h-9 w-full rounded-lg border border-border bg-white px-2.5 text-[15px] sm:text-xs font-semibold text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-60"
                        aria-label="Lead agent"
                      >
                        {activeRoomAgents.length === 0 ? (
                          <option value="">No agents</option>
                        ) : activeRoomAgents.map(agent => (
                          <option key={`${agent.name}-${agent.client}`} value={agent.name}>Lead: {agent.name}</option>
                        ))}
                      </select>
                    )}
                    {replyMode === 'moderator' && (
                      <select
                        value={selectedModeratorAgentName}
                        onChange={e => { void updateReplyMode('moderator', { moderatorAgentName: e.target.value, moderatorAgentClient: 'cc' }); }}
                        disabled={modeBusy || activeRoomAgents.length === 0}
                        className="h-11 sm:h-9 w-full rounded-lg border border-border bg-white px-2.5 text-[15px] sm:text-xs font-semibold text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint disabled:opacity-60"
                        aria-label="Moderator agent"
                      >
                        {activeRoomAgents.length === 0 ? (
                          <option value="">No agents</option>
                        ) : activeRoomAgents.map(agent => (
                          <option key={`${agent.name}-${agent.client}`} value={agent.name}>Moderator: {agent.name}</option>
                        ))}
                      </select>
                    )}
                    {replyMode !== 'open' && (
                      <div className="rounded-md border border-border-faint bg-white px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-semibold text-ink">
                              {currentSpeaker ? `Now: ${currentSpeaker.name}` : 'No active turn'}
                            </div>
                            <div className="text-[11px] text-ink-soft">
                              {currentSpeaker && currentDeadlineMs !== null
                                ? `${Math.ceil(currentDeadlineMs / 1000)}s left`
                                : 'Waiting'}
                            </div>
                          </div>
                          {currentSpeaker && (
                            <button
                              type="button"
                              onClick={() => { void handleSkipCurrent(); }}
                              disabled={modeBusy}
                              className="h-10 sm:h-8 rounded-lg border border-amber-200 bg-amber-50 px-3 text-[12px] sm:text-[11px] font-semibold text-amber-700 transition active:scale-[0.98] hover:bg-amber-100 disabled:opacity-60"
                            >
                              Skip
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs font-semibold text-ink-muted">{modeLabel(replyMode)}</div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-2.5 text-[13px] font-semibold text-ink">In the room</div>
              <div className="space-y-2">
                {room.participants.map(p => {
                  const isMeHost = room.createdBy === self.name;
                  const isSelf = p.name === self.name && p.client === 'web';
                  const canKick = isMeHost && !isSelf && !ended;
                  const isMuted = p.canSpeak === false;
                  const canMuteToggle = isMeHost && !isSelf && !ended;
                  const canAsk = canConfigureReplyMode && p.client === 'cc' && !isMuted;
                  const presence = participantPresence(p, now);
                  // Whole-row visual fade for participants who haven't been
                  // seen in a while — keeps the row legible but signals
                  // "probably gone" without screaming about it.
                  const rowFade = presence.kind === 'idle'
                    ? 'opacity-65'
                    : presence.kind === 'disconnected'
                      ? 'opacity-50'
                      : '';
                  return (
                    <div
                      key={`${p.name}-${p.client}`}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition ${rowFade} ${isMuted ? 'border-amber-300 bg-amber-50/60' : 'border-border-faint bg-surface-softer'}`}
                    >
                      <Avatar initials={p.initials} color={p.color} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] sm:text-xs font-semibold truncate flex items-center gap-1 flex-wrap">
                          {p.name}
                          {p.name === room.createdBy && <span className="text-[10px] font-semibold text-accent bg-accent-tint px-1.5 py-0.5 rounded">host</span>}
                          {isMuted && <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">muted</span>}
                        </div>
                        <div className="text-[11px] text-ink-soft truncate">
                          {[p.role, p.client === 'cc' ? 'CLI' : 'browser'].filter(Boolean).join(' · ')}
                        </div>
                        <div className={`mt-1 flex items-center gap-1 text-[11px] font-medium ${presence.className}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${presence.dotClassName}`} />
                          <span>{presence.label}</span>
                          {presence.detail && <span className="text-ink-faint">· {presence.detail}</span>}
                        </div>
                      </div>
                      {/*
                        Host controls — always visible (no hover-to-reveal).
                        Hover-only buttons hid the kick action so badly that
                        a user reported "the delete agent button isn't
                        obvious" and "the mute button feels cramped". Keep
                        them quiet visually (low contrast, neutral border)
                        but always discoverable, and only render at all when
                        the viewer is actually the host.
                      */}
                      {(canAsk || canMuteToggle || canKick) && (
                        <div className="flex items-center gap-1">
                          {canAsk && (
                            <button
                              onClick={() => { void handleAskAgent(p); }}
                              title={`Ask ${p.name}`}
                              aria-label={`Ask ${p.name}`}
                              disabled={modeBusy}
                              className="flex h-10 min-w-10 sm:h-8 sm:min-w-8 items-center justify-center rounded-lg border border-accent-tint-border bg-accent-tint px-2.5 text-[12px] sm:text-[11px] font-semibold text-accent transition hover:bg-accent-tint-border active:scale-[0.98] disabled:opacity-60"
                            >
                              Ask
                            </button>
                          )}
                          {canMuteToggle && (
                            <button
                              onClick={() => handleToggleMute({ name: p.name, client: p.client, canSpeak: p.canSpeak })}
                              title={isMuted ? `Unmute ${p.name}` : `Mute ${p.name}`}
                              aria-label={isMuted ? `Unmute ${p.name}` : `Mute ${p.name}`}
                              className={`flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg border text-[11px] transition active:scale-[0.98] ${isMuted
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'border-border-faint bg-surface text-ink-soft hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700'}`}
                            >
                              {/* Speaker glyph: solid when can speak, slashed when muted. */}
                              {isMuted ? (
                                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
                                  <path d="m11 6 3 4M14 6l-3 4" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
                                  <path d="M11 5.75c.75.6 1.25 1.4 1.25 2.25s-.5 1.65-1.25 2.25" />
                                </svg>
                              )}
                            </button>
                          )}
                          {canKick && (
                            <button
                              onClick={() => handleKick({ name: p.name, client: p.client })}
                              title={`Remove ${p.name}`}
                              aria-label={`Remove ${p.name}`}
                              className="flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg border border-border-faint bg-surface text-ink-soft transition active:scale-[0.98] hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                            >
                              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                                <path d="m4 4 8 8M12 4l-8 8" />
                              </svg>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="p-4 border-t border-border-faint flex gap-2">
              {!ended && room.createdBy === self.name && (
                <button
                  onClick={handleEndMeeting}
                  className="flex-1 min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-red-600 bg-red-50 px-3 rounded-lg transition active:scale-[0.98] hover:bg-red-100"
                >
                  End
                </button>
              )}
              <button onClick={() => navigate('/')} className="flex-1 min-h-10 sm:min-h-8 text-[13px] sm:text-xs font-semibold text-ink-muted bg-surface-softer px-3 rounded-lg transition active:scale-[0.98]">
                Home
              </button>
            </div>
          </aside>

          <section className={`${mobilePanel === 'chat' ? 'flex' : 'hidden'} lg:flex min-h-0 min-w-0 flex-col`}>
            <div className="hidden lg:flex px-5 py-3 border-b border-border-faint bg-surface items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Discussion</div>
                <div className="text-[10px] text-ink-soft">Live room chat</div>
              </div>
              {ended && <span className="text-[10px] font-semibold text-red-500">Ended</span>}
            </div>

            <div ref={feedRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3 sm:p-5 flex flex-col gap-3 bg-surface-soft relative">
              {(() => {
                // Names that appear with more than one client in the room get
                // disambiguated as "Name · web" / "Name · cc" in each bubble.
                const byName = new Map<string, Set<string>>();
                for (const p of room?.participants ?? []) {
                  if (!byName.has(p.name)) byName.set(p.name, new Set());
                  byName.get(p.name)!.add(p.client);
                }
                const ambiguousNames = new Set<string>();
                for (const [n, cs] of byName) if (cs.size > 1) ambiguousNames.add(n);
                return messages.map(m => (
                  <Bubble
                    key={m.id}
                    message={m}
                    self={m.name === self.name}
                    ambiguousNames={ambiguousNames}
                  />
                ));
              })()}

              {messages.length === 0 && (
                <div className="m-auto max-w-xs px-2 text-center">
                  <h2 className="text-[15px] font-semibold text-ink">Nothing said yet</h2>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                    {roomAgents.length === 0
                      ? 'Share the room code and tell your agent to join it. Once it is here, tap its name above the message box to hand it work.'
                      : 'Tap an agent name above the message box to address it, or open Tasks to hand it something with a definition of done.'}
                  </p>
                  {roomAgents.length === 0 && (
                    <button
                      type="button"
                      onClick={() => copyText(joinUrl, 'Invite link copied')}
                      className="mt-4 min-h-10 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white shadow-sm transition active:scale-[0.98] hover:opacity-90"
                    >
                      Copy invite link
                    </button>
                  )}
                </div>
              )}

              {showIdlePrompt && !ended && (
                <div className="sticky bottom-0 mx-auto bg-white border border-border rounded-xl shadow-lg p-4 text-center max-w-sm">
                  <p className="text-sm font-semibold text-ink mb-1">No activity for 1 hour</p>
                  <p className="text-xs text-ink-soft mb-3">Meeting will close in <span className="font-bold text-red-600">{countdown}s</span></p>
                  <div className="flex gap-2 justify-center">
                    <button onClick={dismissIdlePrompt} className="px-4 py-1.5 bg-accent text-white text-xs font-semibold rounded-lg">
                      Keep open
                    </button>
                    <button onClick={handleEndMeeting} className="px-4 py-1.5 bg-red-50 text-red-600 text-xs font-semibold rounded-lg border border-red-200">
                      End now
                    </button>
                  </div>
                </div>
              )}
            </div>

            {ended ? (
              // A1: ended-room CTA pivots from "Reactivate-only" to a primary
              // "Save & Share" call-to-action. Once the meeting wraps, the most
              // valuable next step is to freeze it into a permanent shareable
              // report (creates the asset + copies the link to clipboard);
              // Reactivate stays available as a secondary option, Back-to-home
              // tertiary. This makes share-link generation a one-click move
              // and feeds the viral loop: every shared link is also a demo of
              // the product.
              <div className="border-t border-border-faint p-4 bg-surface-softer">
                <p className="text-xs text-ink-soft mb-3 text-center">
                  This meeting has ended. Save it as a permanent report you can share with your team or client.
                </p>
                <div className="flex flex-wrap gap-3 justify-center items-center">
                  <button
                    onClick={handleExportReport}
                    disabled={reportBusy || messages.length === 0}
                    className="text-xs font-semibold text-white bg-accent px-4 py-1.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {reportBusy ? 'Saving…' : 'Save & Share'}
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const client = createClient(ENV.upstash);
                        await reactivateRoomApi(client, code);
                        // Reset the full idle pipeline. Without these the idle timer
                        // would immediately re-fire (lastMsgTimeRef is still hours
                        // old, showIdlePrompt may still be true) and the room would
                        // close again 5 seconds later — the "reactivate → close →
                        // reactivate → close" loop users hit.
                        lastMsgTimeRef.current = Date.now();
                        setShowIdlePrompt(false);
                        setCountdown(AUTO_CLOSE_COUNTDOWN);
                        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
                        if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
                        setEnded(false);
                        await refreshRoom();
                      } catch {}
                    }}
                    className="text-xs font-semibold text-ink-muted bg-surface border border-border px-4 py-1.5 rounded-lg hover:border-accent/40 hover:text-accent transition"
                  >
                    Reactivate
                  </button>
                  <button onClick={() => navigate('/')} className="text-xs font-semibold text-ink-faint hover:text-ink-muted">Back to home</button>
                </div>
              </div>
            ) : !myCanSpeak ? (
              <div className="border-t border-border-faint p-5 bg-amber-50 text-center">
                <div className="mb-2 flex justify-center text-amber-700">
                  <svg viewBox="0 0 16 16" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
                    <path d="m11 6 3 4M14 6l-3 4" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-amber-900 mb-1">You've been muted by the host</p>
                <p className="text-xs text-amber-800/80 max-w-xs mx-auto">
                  The host ({room.createdBy}) has muted your messages. You can still read the conversation. Ask them to unmute you when you are ready to speak again.
                </p>
              </div>
            ) : (
              <div
                className={`relative min-w-0 border-t border-border-faint p-2.5 sm:p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-surface flex flex-col gap-2 transition ${dragActive ? 'ring-2 ring-inset ring-accent bg-accent-tint/40' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={e => { void handleDrop(e); }}
              >
                {dragActive && (
                  <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-surface/90 text-sm font-semibold text-accent shadow-sm">
                    Release to attach
                  </div>
                )}
                {isHost && mutedCount > 0 && (
                  <div className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 flex items-center gap-2">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                      <path d="M8 3.5 4.5 6.25H2.5v3.5h2L8 12.5z" />
                      <path d="m11 6 3 4M14 6l-3 4" />
                    </svg>
                    <span>{mutedCount} {mutedCount === 1 ? 'participant is' : 'participants are'} muted. Open People to unmute.</span>
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {attachments.map(attachment => (
                      <PendingAttachment
                        key={attachment.id}
                        attachment={attachment}
                        onRemove={() => setAttachments(prev => prev.filter(item => item.id !== attachment.id))}
                      />
                    ))}
                  </div>
                )}
                {/*
                  Command deck. Targeting an agent used to live only as an
                  "Ask" button inside each People row, so on a phone giving one
                  agent a job meant leaving Chat, finding the row, tapping Ask,
                  then coming back. The agents are now chips on the composer
                  itself: tap to address one (or to hand it the turn directly
                  in sequential / moderator mode) without losing the thread.
                */}
                <div className="flex w-full min-w-0 flex-wrap items-center gap-2 py-0.5 shrink-0">
                  {roomAgents.length === 0 ? (
                    messages.length > 0 && (
                      <span className="w-full text-[12px] text-ink-soft">
                        No agents here yet. Share the room code to bring one in.
                      </span>
                    )
                  ) : (
                    roomAgents.map(agent => {
                      const muted = agent.canSpeak === false;
                      return (
                        <button
                          key={`${agent.name}-${agent.client}`}
                          type="button"
                          disabled={modeBusy || muted}
                          onClick={() => { void handleAskAgent(agent); }}
                          title={muted ? `${agent.name} is muted` : `Ask ${agent.name}`}
                          className="shrink-0 min-h-10 rounded-full border border-accent-tint-border bg-accent-tint px-3.5 text-[13px] font-semibold text-accent transition hover:bg-accent-tint-border active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed"
                        >
                          @{agent.name}
                        </button>
                      );
                    })
                  )}
                  {roomAgents.length > 0 && (<>
                  <button
                    type="button"
                    onClick={() => fillPrompt('minutes')}
                    className="shrink-0 min-h-10 rounded-full border border-border bg-surface-softer px-3.5 text-[13px] font-semibold text-ink-muted transition hover:border-accent/40 hover:text-accent active:scale-[0.98]"
                  >
                    Minutes
                  </button>
                  <button
                    type="button"
                    onClick={() => fillPrompt('reply')}
                    className="shrink-0 min-h-10 rounded-full border border-border bg-surface-softer px-3.5 text-[13px] font-semibold text-ink-muted transition hover:border-accent/40 hover:text-accent active:scale-[0.98]"
                  >
                    Reply draft
                  </button>
                  </>)}
                </div>
                <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                  <div className="relative flex-1 min-w-0">
                    <textarea
                      ref={textareaRef}
                      value={text}
                      onChange={e => setText(e.target.value)}
                      onPaste={e => { void handlePaste(e); }}
                      onKeyDown={e => {
                        // Desktop: Enter sends; Shift+Enter for new line.
                        // Mobile touch: let Enter insert a newline so user can type freely without accidental send.
                        const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
                        if (!isTouch && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      placeholder="Message the room…"
                      rows={1}
                      style={{ height: TEXTAREA_MIN_HEIGHT, maxHeight: TEXTAREA_MAX_HEIGHT }}
                      className="w-full resize-none overflow-y-auto px-3.5 py-2.5 bg-surface-softer border border-border rounded-xl text-base sm:text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent-tint"
                    />
                  </div>
                  <div className="flex items-center justify-between sm:justify-start gap-2 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <VoiceButton
                        onTranscript={(t) => setText(prev => prev.trim() ? `${prev.trim()} ${t}` : t)}
                        disabled={ended}
                      />
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        accept={Array.from(ALLOWED_ATTACHMENT_TYPES).join(',')}
                        onChange={e => { if (e.target.files) void addFiles(e.target.files); }}
                      />
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={attachBusy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                        title="Attach files"
                        className="h-10 w-10 sm:h-9 sm:w-auto justify-center rounded-lg bg-surface-softer border border-border sm:px-2 text-xs font-semibold text-ink-muted disabled:opacity-50 flex items-center gap-1.5 active:scale-95 transition"
                      >
                        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M13 7.5v3a4 4 0 0 1-8 0v-5a2.5 2.5 0 0 1 5 0v5a1 1 0 0 1-2 0v-4.5" />
                        </svg>
                        <span className="hidden sm:inline sm:text-xs">{attachBusy ? '...' : 'Attach'}</span>
                      </button>
                    </div>
                    <button
                      onClick={send}
                      disabled={!text.trim() && attachments.length === 0}
                      className="min-h-[40px] sm:min-h-[36px] min-w-[78px] sm:min-w-[64px] bg-accent text-white px-5 sm:px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transition shadow-sm flex items-center justify-center gap-1.5"
                    >
                      <span>Send</span>
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                        <path d="M1.5 1.5l13 6.5-13 6.5 2-6.5-2-6.5zm3.2 6.5h5.8-5.8z" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className={`${mobilePanel === 'tasks' ? 'flex' : 'hidden'} lg:flex min-h-0 min-w-0 flex-col border-l border-border-faint bg-surface`}>
            {/*
              The task board the MCP server has always had (room_task: owner,
              a different verifier, evidence, verdicts) but the web client
              never rendered. Before this, a host on a phone could only infer
              agent progress from chat prose and regex-scraped [TODO] markers.
            */}
            <TaskBoard
              code={code}
              me={me}
              isHost={isHost}
              ended={ended}
              agents={roomAgents}
              artifacts={artifacts}
              canExport={messages.length > 0}
              reportBusy={reportBusy}
              onExportReport={handleExportReport}
              onMention={appendText}
              taskBoard={taskBoard}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function PendingAttachment({ attachment, onRemove }: { attachment: MessageAttachment; onRemove: () => void }) {
  return (
    <div className="flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-surface-softer px-2 py-1.5">
      {attachment.type === 'image' && (
        <img src={attachment.url} alt="" className="h-8 w-8 rounded object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-ink">{attachment.name}</div>
        <div className="text-[10px] text-ink-soft">{formatBytes(attachment.size)}</div>
      </div>
      <button
        onClick={onRemove}
        className="h-6 w-6 rounded text-xs font-bold text-ink-soft hover:bg-surface"
        title={`Remove ${attachment.name}`}
      >
        x
      </button>
    </div>
  );
}

function participantPresence(p: Participant, now: number) {
  if (p.listenUntil && p.listenUntil > now) {
    return {
      kind: 'listening' as const,
      label: 'Listening now',
      detail: '',
      className: 'text-emerald-700',
      dotClassName: 'bg-emerald-500',
    };
  }

  if (now - p.lastSeenAt <= PRESENCE_STALE_MS) {
    return {
      kind: 'online' as const,
      label: 'Online',
      detail: '',
      className: 'text-blue-700',
      dotClassName: 'bg-blue-500',
    };
  }

  // Past 5 minutes silent → almost certainly disconnected. Most common cause:
  // a CLI agent (Cursor / Claude Code / Codex) was terminated by the user
  // without calling room_leave, so the participant row stays in the room
  // forever. The "Disconnected" label is a hint to the host that this
  // participant is unlikely to come back, paired with the always-visible
  // kick button so they can clean up in one click.
  if (now - p.lastSeenAt > PRESENCE_DISCONNECTED_MS) {
    return {
      kind: 'disconnected' as const,
      label: 'Disconnected',
      detail: p.client === 'cc' ? 'host can remove' : '',
      className: 'text-ink-faint',
      dotClassName: 'bg-slate-400',
    };
  }

  return {
    kind: 'idle' as const,
    label: 'Idle',
    detail: p.client === 'cc' ? 'not listening' : '',
    className: 'text-ink-faint',
    dotClassName: 'bg-slate-300',
  };
}
