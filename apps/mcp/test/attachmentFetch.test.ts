import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentAuthHeaders, fetchAttachmentBytes, readAttachmentText, resolveAttachmentUrl } from '../src/tools.js';

afterEach(() => { delete process.env.AGENT_ROOM_BASE_URL; vi.unstubAllGlobals(); });

describe('attachment reader against a self-hosted room', () => {
  it('resolves a relative attachment url against the room base and presents the access header', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    expect(resolveAttachmentUrl('/attachments/ABC-file.txt')).toBe('https://room.example/attachments/ABC-file.txt');
    expect(resolveAttachmentUrl('https://cdn.example/x.txt')).toBe('https://cdn.example/x.txt');
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const bytes = await fetchAttachmentBytes('/attachments/ABC-file.txt', 1024, { accessToken: 'a'.repeat(43) }, fetchFn);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(seen).toEqual([{ url: 'https://room.example/attachments/ABC-file.txt', headers: { 'x-agent-room-access': 'a'.repeat(43) } }]);
  });
});

describe('room capability never leaves the room origin', () => {
  it('sends the access header to the room origin only, never to a third-party attachment host', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    const auth = { accessToken: 'a'.repeat(43) };
    expect(attachmentAuthHeaders('https://room.example/attachments/x.txt', auth)).toEqual({ 'x-agent-room-access': auth.accessToken });
    expect(attachmentAuthHeaders('https://cdn.example/x.txt', auth)).toEqual({});
    expect(attachmentAuthHeaders('https://room.example.evil.test/x.txt', auth)).toEqual({});
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(new Uint8Array([9]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAttachmentBytes('https://cdn.example/public.txt', 1024, auth, fetchFn);
    await fetchAttachmentBytes('/attachments/ABC-x.txt', 1024, auth, fetchFn);
    expect(seen).toEqual([
      { url: 'https://cdn.example/public.txt', headers: {} },
      { url: 'https://room.example/attachments/ABC-x.txt', headers: { 'x-agent-room-access': auth.accessToken } },
    ]);
  });
});

describe('attachment download size boundary', () => {
  it('drops room credentials when a same-origin attachment redirects cross-origin', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    const seen: Array<{ url: string; headers: Record<string, string>; redirect?: RequestRedirect }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
      if (url === 'https://room.example/attachments/x.txt') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example/x.txt' } });
      }
      return new Response(new Uint8Array([7]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAttachmentBytes('/attachments/x.txt', 10, { accessToken: 'a'.repeat(43) }, fetchFn);
    expect(seen).toEqual([
      { url: 'https://room.example/attachments/x.txt', headers: { 'x-agent-room-access': 'a'.repeat(43) }, redirect: 'manual' },
      { url: 'https://cdn.example/x.txt', headers: {}, redirect: 'manual' },
    ]);
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const bodyRead = vi.fn();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '1025' }),
      get body() { bodyRead(); throw new Error('body must not be read'); },
      arrayBuffer: vi.fn(() => { throw new Error('arrayBuffer must not be called'); }),
    } as unknown as Response;
    const fetchFn = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(fetchAttachmentBytes('/attachments/too-large.bin', 1024, {}, fetchFn))
      .rejects.toThrow('Attachment is 1025 bytes');
    expect(bodyRead).not.toHaveBeenCalled();
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it('cancels a chunked stream as soon as its cumulative bytes exceed the cap', async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(99));
      },
      cancel,
    });
    const arrayBuffer = vi.fn(() => { throw new Error('arrayBuffer must not be called'); });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body,
      arrayBuffer,
    } as unknown as Response;
    const fetchFn = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(fetchAttachmentBytes('/attachments/chunked.bin', 10, {}, fetchFn))
      .rejects.toThrow('Attachment exceeds 10 bytes');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('returns exact bytes from an under-cap streamed body without arrayBuffer', async () => {
    const arrayBuffer = vi.fn(() => { throw new Error('arrayBuffer must not be called'); });
    const response = new Response(new Uint8Array([1, 3, 5, 7]), { status: 200 });
    Object.defineProperty(response, 'arrayBuffer', { value: arrayBuffer });
    const fetchFn = vi.fn(async () => response) as unknown as typeof fetch;

    await expect(fetchAttachmentBytes('/attachments/small.bin', 4, {}, fetchFn))
      .resolves.toEqual(new Uint8Array([1, 3, 5, 7]));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });
});

describe('self-hosted image attachments', () => {
  it('returns the image bytes through the authenticated reader instead of a url the caller cannot open', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    }));
    const read = await readAttachmentText(
      { id: 'i1', type: 'image', url: '/attachments/ABC-pic.png', storageKey: 'k', name: 'pic.png', size: 4, mime: 'image/png', uploadedAt: 1 },
      1000,
      { accessToken: 'a'.repeat(43) },
    );
    expect(read.source).toBe('fetched_image');
    expect(read.mime).toBe('image/png');
    expect(Buffer.from(read.image ?? '', 'base64')).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(read.warning).toBeUndefined();
    expect(seen).toEqual([{ url: 'https://room.example/attachments/ABC-pic.png', headers: { 'x-agent-room-access': 'a'.repeat(43) } }]);
  });
});
