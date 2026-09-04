import { describe, expect, it, vi } from 'vitest';
import { createAuthorizedMcpHttpHandler, protectedResourceMetadata } from '../src/httpAuth.js';

describe('HTTP MCP OAuth 2.1 gate', () => {
  it('dispatches an audience-and-scope-bound principal without forwarding its bearer token', async () => {
    const dispatch = vi.fn(async (request, principal) => ({ status: 200, body: { request, principal } }));
    const verifier = { verify: vi.fn(async () => ({
      subject: 'agent-1', fleetId: 'fleet-1', issuer: 'https://issuer.invalid',
      audience: 'https://room.invalid/mcp', expiresAt: 2_000,
      scopes: ['agent-room:mcp'],
    })) };
    const handler = createAuthorizedMcpHttpHandler({
      resource: 'https://room.invalid/mcp',
      metadataUrl: 'https://room.invalid/.well-known/oauth-protected-resource',
      verifier, dispatch, trustedIssuers: ['https://issuer.invalid'], now: () => 1_000,
    });

    const response = await handler({ headers: { authorization: 'Bearer secret-token', 'x-request-id': 'r-1' } });

    expect(response.status).toBe(200);
    expect(verifier.verify).toHaveBeenCalledWith('secret-token', {
      resource: 'https://room.invalid/mcp', requiredScope: 'agent-room:mcp',
    });
    expect(dispatch.mock.calls[0]?.[0].headers.authorization).toBeUndefined();
  });

  it('refuses an invalid token before MCP dispatch with protected-resource metadata', async () => {
    const dispatch = vi.fn();
    const handler = createAuthorizedMcpHttpHandler({
      resource: 'https://room.invalid/mcp',
      metadataUrl: 'https://room.invalid/.well-known/oauth-protected-resource',
      verifier: { verify: async () => { throw new Error('bad token'); } }, dispatch,
      trustedIssuers: ['https://issuer.invalid'],
    });

    expect(await handler({ headers: { authorization: 'Bearer bad' } })).toEqual({
      status: 401,
      headers: { 'www-authenticate': 'Bearer resource_metadata="https://room.invalid/.well-known/oauth-protected-resource"' },
      body: { error: 'invalid_token' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(protectedResourceMetadata('https://room.invalid/mcp', ['https://issuer.invalid']))
      .toMatchObject({ resource: 'https://room.invalid/mcp', authorization_servers: ['https://issuer.invalid'] });
  });

  it.each([
    ['wrong audience', { audience: 'https://other.invalid/mcp' }],
    ['missing issuer', { issuer: '' }],
    ['expired token', { expiresAt: 999 }],
  ] as const)('refuses a principal with %s before dispatch', async (_label, override) => {
    const dispatch = vi.fn();
    const principal = { subject: 'agent-1', fleetId: 'fleet-1', issuer: 'https://issuer.invalid',
      audience: 'https://room.invalid/mcp', expiresAt: 2_000, scopes: ['agent-room:mcp'], ...override };
    const handler = createAuthorizedMcpHttpHandler({
      resource: 'https://room.invalid/mcp',
      metadataUrl: 'https://room.invalid/.well-known/oauth-protected-resource',
      verifier: { verify: async () => principal }, dispatch,
      trustedIssuers: ['https://issuer.invalid'], now: () => 1_000,
    });

    expect((await handler({ headers: { authorization: 'Bearer token' } })).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
