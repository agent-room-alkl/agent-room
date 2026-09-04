import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactUrl } from '../src/redact.js';
import { fetchAttachmentBytes, readAttachmentText } from '../src/tools.js';

afterEach(() => { delete process.env.AGENT_ROOM_BASE_URL; vi.unstubAllGlobals(); });

describe('urls in errors and logs carry no capability', () => {
  it('strips query, fragment and userinfo but keeps origin and path', () => {
    expect(redactUrl('https://room.example/attachments/ABC-x.txt?access=legacy-secret-capability')).toBe('https://room.example/attachments/ABC-x.txt');
    expect(redactUrl('https://user:pw@room.example/api/room#frag')).toBe('https://room.example/api/room');
    expect(redactUrl('/attachments/ABC-x.txt?access=legacy-secret-capability')).toBe('/attachments/ABC-x.txt');
  });

  it('a failed legacy attachment fetch names the status and the path, never the token', async () => {
    process.env.AGENT_ROOM_BASE_URL = 'https://room.example';
    const fetchFn = vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    const url = '/attachments/ABC-x.txt?access=legacy-secret-capability';
    let message = '';
    try { await fetchAttachmentBytes(url, 1024, {}, fetchFn); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('403');
    expect(message).toContain('/attachments/ABC-x.txt');
    expect(message).not.toContain('legacy-secret-capability');
    expect(message).not.toContain('access=');
    // A blob-read failure surfaces the same redacted message.
    vi.stubGlobal('fetch', fetchFn);
    let blobMessage = '';
    try { await readAttachmentText({ id: 'u', type: 'file', url, storageKey: 'k', name: 'x.bin', size: 1, mime: 'application/x-unknown', uploadedAt: 1 }, 100); }
    catch (error) { blobMessage = (error as Error).message; }
    expect(blobMessage).toContain('/attachments/ABC-x.txt');
    expect(blobMessage).not.toContain('legacy-secret-capability');
  });
});
