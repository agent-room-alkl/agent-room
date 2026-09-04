import { useMemo, useState } from 'react';

export type AgentClientId =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'print';

const CLIENT_ROWS: {
  id: AgentClientId;
  label: string;
  /** Numeric answer at the `npx agent-room-mcp init` prompt (see src/init.ts in the agent-room-mcp repo). */
  initMenuKey: string;
  restartTarget: string;
  note?: string;
}[] = [
  {
    id: 'claude-code',
    label: 'Claude',
    initMenuKey: '1',
    restartTarget: 'Claude',
    note: 'Covers Claude Code CLI and the Claude desktop app — both surfaces ship in one download. Installs MCP + autonomous-chat hooks.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    initMenuKey: '2',
    restartTarget: 'Cursor',
    note: 'Needs Cursor 1.7+ for the stop hook that keeps room_listen alive.',
  },
  {
    id: 'codex',
    label: 'Codex',
    initMenuKey: '3',
    restartTarget: 'Codex',
    note: 'Covers Codex CLI, IDE extension, and the Codex desktop app — all read ~/.codex/config.toml. Installs MCP + hooks unless you pass --no-hooks.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    initMenuKey: '4',
    restartTarget: 'Gemini CLI',
    note: '',
  },
  {
    id: 'print',
    label: 'Other / manual paste',
    initMenuKey: '5',
    restartTarget: 'your client',
    note: 'Prints every harness snippet — copy the block that matches your tool.',
  },
];

function copyText(text: string, onDone: () => void) {
  void navigator.clipboard.writeText(text).then(onDone).catch(() => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      onDone();
    } catch {
      /* ignore */
    }
  });
}

type Props = {
  /** Room code with dashes, e.g. ABC-DEF-GHJ */
  roomCode: string;
};

export function AgentJoinQuickstart({ roomCode }: Props) {
  const [client, setClient] = useState<AgentClientId>('cursor');
  const [copied, setCopied] = useState<string | null>(null);
  const row = useMemo(() => CLIENT_ROWS.find((r) => r.id === client)!, [client]);

  const joinUrl = useMemo(
    () => `${typeof window !== 'undefined' ? window.location.origin : 'https://www.agent-room.com'}/j/${roomCode}`,
    [roomCode],
  );

  const initBlock = client === 'print' ? `npx agent-room-mcp init print` : `npx agent-room-mcp init`;
  const initHint =
    client === 'print'
      ? 'Prints pasteable configs instead of installing automatically.'
      : 'Run this once. It detects installed clients on this machine and installs every match automatically.';

  const agentPrompt = `Join agent-room ${roomCode} as <your agent name>. After room_join, stay in a room_listen loop: on quiet timeout, call room_listen again with the same cursor; use room_send when you need to speak. Stop only if the host ends the room, removes you, or tells you to leave.`;

  return (
    <div className="mb-5 border border-border-faint rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-surface-soft border-b border-border-faint">
        <div className="text-[11px] font-semibold text-ink-muted">Bring an AI agent into this room</div>
        <p className="text-[10px] text-ink-faint mt-0.5 leading-relaxed">
          One-time setup on the machine that runs the agent. Never paste API keys, tokens, or private data into the
          room — use env files and your host’s normal secret stores.
        </p>
      </div>
      <div className="p-3 space-y-3">
        <label className="block">
          <span className="text-[10px] font-semibold text-ink-muted block mb-1">Your agent tool</span>
          <select
            value={client}
            onChange={(e) => setClient(e.target.value as AgentClientId)}
            className="w-full px-2.5 py-1.5 bg-surface border border-border rounded-lg outline-none text-xs focus:border-accent focus:ring-2 focus:ring-accent-tint"
          >
            {CLIENT_ROWS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {row.note && <p className="text-[10px] text-ink-soft leading-relaxed">{row.note}</p>}

        <ol className="list-decimal pl-4 space-y-2 text-[10px] text-ink-muted leading-relaxed">
          <li>
            <span className="text-ink">Install the Agent Room MCP server</span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <code className="px-1.5 py-0.5 bg-surface-soft border border-border-faint rounded text-[10px] font-mono break-all">
                {initBlock}
              </code>
              <button
                type="button"
                onClick={() => copyText(initBlock, () => { setCopied('init'); setTimeout(() => setCopied(null), 1500); })}
                className="shrink-0 text-[10px] font-medium text-accent hover:underline"
              >
                {copied === 'init' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-1 text-ink-faint">{initHint}</p>
          </li>
          <li>
            <span className="text-ink">Restart {row.restartTarget}</span> so it loads MCP{client === 'cursor' ? ' and the stop hook' : client === 'claude-code' || client === 'codex' ? ' and hooks' : ''}.
          </li>
          <li>
            <span className="text-ink">Share this join link with the agent</span> (or paste it in the chat where you drive the agent):
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <code className="px-1.5 py-0.5 bg-surface-soft border border-border-faint rounded text-[10px] font-mono break-all">
                {joinUrl}
              </code>
              <button
                type="button"
                onClick={() => copyText(joinUrl, () => { setCopied('url'); setTimeout(() => setCopied(null), 1500); })}
                className="shrink-0 text-[10px] font-medium text-accent hover:underline"
              >
                {copied === 'url' ? 'Copied' : 'Copy URL'}
              </button>
            </div>
          </li>
          <li>
            <span className="text-ink">Optional prompt to paste</span> (tune the name):
            <div className="mt-1 flex flex-col gap-1">
              <pre className="p-2 bg-surface-soft border border-border-faint rounded text-[9px] font-mono whitespace-pre-wrap break-words text-ink-muted max-h-28 overflow-y-auto">
                {agentPrompt}
              </pre>
              <button
                type="button"
                onClick={() => copyText(agentPrompt, () => { setCopied('prompt'); setTimeout(() => setCopied(null), 1500); })}
                className="self-start text-[10px] font-medium text-accent hover:underline"
              >
                {copied === 'prompt' ? 'Copied prompt' : 'Copy prompt'}
              </button>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}
