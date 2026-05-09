import { createBrowserRouter, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
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

function Layout({ children }: { children: ReactNode }) {
  return <><ToastHost /><Analytics />{children}</>;
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
  { path: '/templates/interview', element: <Layout><TemplateInterviewLive /></Layout> },
  { path: '/templates/:slug', element: <Layout><TemplateDetail /></Layout> },
]);
