import { createBrowserRouter, useParams } from 'react-router-dom';
import { Component, type ReactNode } from 'react';
import { Home } from './screens/Home.js';
import { CreateMeeting } from './screens/CreateMeeting.js';
import { Lobby } from './screens/Lobby.js';
import { Room } from './screens/Room.js';
import { Report } from './screens/Report.js';
import { Join } from './screens/Join.js';
import { UnlockPending } from './screens/UnlockPending.js';
import { TemplatesIndex } from './screens/TemplatesIndex.js';
import { TemplateDetail } from './screens/TemplateDetail.js';
import { TemplateInterviewLive } from './screens/TemplateInterviewLive.js';
import { ToastHost } from './components/Toast.js';
import { Analytics } from './components/Analytics.js';

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[page-error]', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-surface-soft px-6 py-10 text-ink">
        <div className="mx-auto max-w-2xl rounded-xl border border-red-200 bg-white p-6 shadow-card">
          <div className="text-xs font-semibold uppercase tracking-widest text-red-600">Page crashed</div>
          <h1 className="mt-3 text-xl font-bold">Runtime error</h1>
          <pre className="mt-4 max-h-[360px] overflow-auto rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-900 whitespace-pre-wrap">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
        </div>
      </div>
    );
  }
}

function Layout({ children }: { children: ReactNode }) {
  return <><ToastHost /><Analytics /><PageErrorBoundary>{children}</PageErrorBoundary></>;
}

// Wrappers force a full remount whenever :code changes. Without this
// React reuses the same component instance across param changes, which
// kept stale `useRoom` polling state alive when a host transitioned
// through room_end → room_create in the same tab — the symptom Robin
// hit where new agents' messages didn't appear until a hard refresh.
function RoomByParam() {
  const { code = '' } = useParams();
  return <Room key={code} />;
}
function LobbyByParam() {
  const { code = '' } = useParams();
  return <Lobby key={code} />;
}
function ReportByParam() {
  const { code = '' } = useParams();
  return <Report key={code} />;
}

export const router = createBrowserRouter([
  { path: '/', element: <Layout><Home /></Layout> },
  { path: '/new', element: <Layout><CreateMeeting /></Layout> },
  { path: '/r/:code/lobby', element: <Layout><LobbyByParam /></Layout> },
  { path: '/r/:code', element: <Layout><RoomByParam /></Layout> },
  { path: '/r/:code/report', element: <Layout><ReportByParam /></Layout> },
  { path: '/r/unlock-pending', element: <Layout><UnlockPending /></Layout> },
  { path: '/j/:code', element: <Layout><Join /></Layout> },
  { path: '/j', element: <Layout><Join /></Layout> },
  // Plan B Phase 1: Live Session Templates pages.
  { path: '/templates', element: <Layout><TemplatesIndex /></Layout> },
  // Interview gets a *live* room (real Agent Room + scripted-or-LLM AI
  // Interviewer) so visitors can chat with it. Other templates render
  // the static design-preview page until we promote them to live.
  //
  // Two-step flow:
  //   /templates/interview        → host setup (brief textarea), creates
  //                                 room on submit, then redirects to:
  //   /templates/interview/:code  → host monitor view (transcript +
  //                                 share link + host-note input). The
  //                                 candidate joins via /r/:code.
  { path: '/templates/interview', element: <Layout><TemplateInterviewLive /></Layout> },
  { path: '/templates/interview/:code', element: <Layout><TemplateInterviewLive /></Layout> },
  { path: '/templates/:slug', element: <Layout><TemplateDetail /></Layout> },
]);
