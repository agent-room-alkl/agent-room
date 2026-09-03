import { redactUrl } from './redact.js';
// Server-side companion to apps/web/src/lib/upload.ts. Lets MCP agents
// (Claude Code, Cursor, Codex, etc.) ship binary content into a room
// via room_send's `attachments` arg without needing to touch R2 / Vercel
// Blob credentials themselves — we re-use the public /api/upload endpoint,
// which already enforces "anyone with the room code can upload" (the
// matching room read-model). The upload host is overridable via
// AGENT_ROOM_BASE_URL so self-hosters can point at their own deploy.

import { Buffer } from 'node:buffer';
import type { MessageAttachment } from '@agent-room/shared';

// Mirror the limits in apps/web/src/lib/upload.ts so we fail fast at the
// MCP boundary instead of round-tripping a doomed multipart upload. The
// server re-validates anyway; these constants exist so an agent gets a
// clear error before any bytes leave the local machine.
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const ALLOWED_ATTACHMENT_MIMES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/zip',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface AgentAttachmentInput {
  /** File name with extension, e.g. "report.pdf". */
  name: string;
  /** MIME type. Must be in ALLOWED_ATTACHMENT_MIMES. */
  mime: string;
  /** Base64-encoded file body (no `data:` prefix). */
  content_base64: string;
}

export class AttachmentUploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentUploadError';
    this.code = code;
  }
}

function uploadEndpoint(): string {
  const base = (process.env.AGENT_ROOM_BASE_URL ?? 'https://www.agent-room.com').replace(/\/$/, '');
  return `${base}/api/upload`;
}

/** Validate one attachment input and return its decoded byte length, or throw. */
function validateInput(input: AgentAttachmentInput): { bytes: Buffer } {
  if (!input || typeof input !== 'object') {
    throw new AttachmentUploadError('bad_attachment', 'Attachment must be an object with name, mime, content_base64.');
  }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new AttachmentUploadError('missing_name', 'Attachment name is required.');
  }
  if (typeof input.mime !== 'string' || input.mime.length === 0) {
    throw new AttachmentUploadError('missing_mime', `Attachment mime is required (got ${typeof input.mime}).`);
  }
  if (!ALLOWED_ATTACHMENT_MIMES.has(input.mime)) {
    throw new AttachmentUploadError(
      'mime_not_allowed',
      `Unsupported attachment MIME: ${input.mime}. Allowed: ${[...ALLOWED_ATTACHMENT_MIMES].join(', ')}.`,
    );
  }
  if (typeof input.content_base64 !== 'string' || input.content_base64.length === 0) {
    throw new AttachmentUploadError('empty_content', `Attachment ${input.name} has no content_base64.`);
  }

  // Strip optional `data:<mime>;base64,` prefix in case the agent passed a
  // dataURL by mistake — surprisingly common when models cargo-cult web
  // examples.
  const cleaned = input.content_base64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!isStrictBase64(cleaned)) {
    throw new AttachmentUploadError('bad_base64', `Attachment ${input.name} has malformed base64 content.`);
  }
  if (estimatedBase64Bytes(cleaned) > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentUploadError(
      'file_too_large',
      `Attachment ${input.name} exceeds ${MAX_ATTACHMENT_BYTES} bytes (10 MB).`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(cleaned, 'base64');
  } catch {
    throw new AttachmentUploadError('bad_base64', `Attachment ${input.name} has malformed base64 content.`);
  }
  if (bytes.length === 0) {
    throw new AttachmentUploadError('empty_file', `Attachment ${input.name} decoded to 0 bytes.`);
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentUploadError(
      'file_too_large',
      `Attachment ${input.name} is ${bytes.length} bytes; limit is ${MAX_ATTACHMENT_BYTES} (10 MB).`,
    );
  }
  return { bytes };
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const firstPad = value.indexOf('=');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isBase64Char =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (isBase64Char) {
      if (firstPad !== -1 && i > firstPad) return false;
      continue;
    }
    if (code !== 61) return false;
    if (i < value.length - 2) return false;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding === 1 && value[value.length - 2] === '=') return false;
  return true;
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/**
 * Upload one base64-encoded attachment to the agent-room upload endpoint
 * and return its MessageAttachment. Fails fast with AttachmentUploadError
 * before the round-trip when the input is obviously bad.
 *
 * `fetchImpl` is overridable for testing; in production the global Node
 * fetch is used. Same for `formDataImpl` / `blobImpl` — modern Node 18+
 * has all three as globals.
 */
export async function uploadAgentAttachment(
  input: AgentAttachmentInput,
  roomCode: string,
  deps: {
    fetch?: typeof fetch;
    FormData?: typeof FormData;
    Blob?: typeof Blob;
    accessToken?: string;
    participantToken?: string;
  } = {},
): Promise<MessageAttachment> {
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomCode)) {
    throw new AttachmentUploadError('bad_room_code', `Malformed room code: ${roomCode}.`);
  }
  const { bytes } = validateInput(input);

  const fetchFn = deps.fetch ?? fetch;
  const FormDataCtor = deps.FormData ?? FormData;
  const BlobCtor = deps.Blob ?? Blob;

  const fd = new FormDataCtor();
  fd.append('roomCode', roomCode);
  // Copy into a fresh Uint8Array so TS sees it as backed by a plain
  // ArrayBuffer (Buffer.from(base64) is typed as ArrayBufferLike, which
  // includes SharedArrayBuffer and trips Blob's BlobPart constraint).
  const blobPart = new Uint8Array(bytes);
  fd.append('file', new BlobCtor([blobPart], { type: input.mime }), input.name);

  let resp: Response;
  try {
    resp = await fetchFn(uploadEndpoint(), {
      method: 'POST',
      headers: {
        ...(deps.accessToken ? { 'x-agent-room-access': deps.accessToken } : {}),
        ...(deps.participantToken ? { authorization: `Bearer ${deps.participantToken}` } : {}),
      },
      body: fd as unknown as BodyInit,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network failure';
    throw new AttachmentUploadError('network_error', `POST ${redactUrl(uploadEndpoint())} failed: ${msg}`);
  }

  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 500); } catch { /* non-essential */ }
    throw new AttachmentUploadError(
      'upload_failed',
      `Upload server returned ${resp.status}${detail ? ` — ${detail}` : ''}.`,
    );
  }

  let attachment: MessageAttachment;
  try {
    attachment = (await resp.json()) as MessageAttachment;
  } catch {
    throw new AttachmentUploadError('bad_response', 'Upload server returned non-JSON response.');
  }
  if (!attachment || typeof attachment.url !== 'string') {
    throw new AttachmentUploadError('bad_response', 'Upload server response is missing url field.');
  }
  return attachment;
}

/**
 * Upload a batch of attachments sequentially. Returns the array of
 * resolved MessageAttachments. We go sequentially (not Promise.all) so a
 * single bad one fails fast with a clear error, instead of half the batch
 * succeeding silently and the other half raising.
 */
export async function uploadAgentAttachments(
  inputs: AgentAttachmentInput[],
  roomCode: string,
  deps: Parameters<typeof uploadAgentAttachment>[2] = {},
): Promise<MessageAttachment[]> {
  if (inputs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentUploadError(
      'too_many',
      `Too many attachments: ${inputs.length} > ${MAX_ATTACHMENTS_PER_MESSAGE}. Split into separate room_send calls.`,
    );
  }
  const out: MessageAttachment[] = [];
  for (const input of inputs) {
    out.push(await uploadAgentAttachment(input, roomCode, deps));
  }
  return out;
}
