import { Link } from 'react-router-dom';
import { AgentRoomLogo } from './AgentRoomLogo.js';

export function TopNav() {
  return (
    <nav className="relative z-10 bg-white">
      <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-6">
        <Link to="/" className="shrink-0 hover:opacity-85 transition" aria-label="Agent Room home">
          <AgentRoomLogo markClassName="h-8 w-8" wordmarkClassName="text-xl" />
        </Link>
        <div className="hidden flex-1 items-center justify-center gap-9 md:flex">
          <a href="https://github.com/ebin198351-akl/agent-room/blob/main/docs/AGENT_ROOM_PROTOCOL.md" target="_blank" rel="noreferrer" className="text-sm font-medium text-ink-soft hover:text-ink transition">
            Docs
          </a>
          <a href="https://github.com/ebin198351-akl/agent-room" target="_blank" rel="noreferrer" className="text-sm font-medium text-ink-soft hover:text-ink transition">
            GitHub
          </a>
        </div>
        <Link
          to="/new"
          className="inline-flex shrink-0 items-center justify-center rounded-lg border border-accent-tint-border bg-white px-3 py-2.5 text-xs font-semibold text-accent hover:bg-accent-tint transition sm:px-5 sm:text-sm"
        >
          <span className="sm:hidden">Open</span>
          <span className="hidden sm:inline">Open a room</span>
        </Link>
      </div>
    </nav>
  );
}
