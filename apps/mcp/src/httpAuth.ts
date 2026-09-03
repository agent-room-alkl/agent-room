export interface McpFleetPrincipal {
  subject: string;
  fleetId: string;
  issuer: string;
  audience: string;
  expiresAt: number;
  scopes: readonly string[];
}

export interface McpAccessTokenVerifier {
  verify(token: string, request: { resource: string; requiredScope: string }): Promise<McpFleetPrincipal>;
}

export interface McpHttpRequest {
  headers: Readonly<Record<string, string | undefined>>;
}

export interface McpHttpResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}

export type AuthorizedMcpHandler = (
  request: McpHttpRequest,
  principal: McpFleetPrincipal,
) => Promise<McpHttpResponse>;

export function protectedResourceMetadata(resource: string, authorizationServers: readonly string[]) {
  return {
    resource,
    authorization_servers: [...authorizationServers],
    bearer_methods_supported: ['header'],
    scopes_supported: ['agent-room:mcp'],
  };
}

/**
 * OAuth 2.1 gate for a future HTTP MCP transport. The existing stdio entry is
 * deliberately separate and unchanged. Tokens stop here and are never passed
 * to tool handlers.
 */
export function createAuthorizedMcpHttpHandler(options: {
  resource: string;
  metadataUrl: string;
  verifier: McpAccessTokenVerifier;
  dispatch: AuthorizedMcpHandler;
  trustedIssuers: readonly string[];
  now?: () => number;
}): (request: McpHttpRequest) => Promise<McpHttpResponse> {
  return async request => {
    const header = request.headers.authorization;
    const challenge = `Bearer resource_metadata="${options.metadataUrl}"`;
    if (!header?.startsWith('Bearer ') || !header.slice(7).trim()) {
      return { status: 401, headers: { 'www-authenticate': challenge }, body: { error: 'invalid_token' } };
    }
    let principal: McpFleetPrincipal;
    try {
      principal = await options.verifier.verify(header.slice(7), {
        resource: options.resource,
        requiredScope: 'agent-room:mcp',
      });
      if (!options.trustedIssuers.includes(principal.issuer) || principal.expiresAt <= (options.now?.() ?? Date.now()) ||
        principal.audience !== options.resource || !principal.scopes.includes('agent-room:mcp')) {
        throw new Error('resource or scope mismatch');
      }
    } catch {
      return { status: 401, headers: { 'www-authenticate': challenge }, body: { error: 'invalid_token' } };
    }
    return options.dispatch({ ...request, headers: { ...request.headers, authorization: undefined } }, principal);
  };
}
