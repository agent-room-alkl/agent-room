// Pure presentational voice indicator. The autoplay side-effect lives
// in the parent (TemplateInterviewLive / Room) so we can scope which
// messages play (e.g. "only the latest AI turn that arrived after I
// landed on the page") rather than have every Bubble try to speak its
// own text — that would replay 50 historical lines on first load.

interface Props {
  active: boolean;
}

export function AudioReplyBar({ active }: Props) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-2">
      <div className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-indigo-500' : 'bg-indigo-300'}`} />
      <div className="flex h-6 flex-1 items-center gap-1">
        {[16, 28, 20, 34, 22, 30, 18, 26, 32, 20, 28, 16, 24, 18].map((height, index) => (
          <span
            key={`${height}-${index}`}
            className={`w-full rounded-full bg-indigo-400 ${active ? 'animate-pulse' : 'opacity-35'}`}
            style={{ height: `${height}px`, animationDelay: `${index * 45}ms` }}
          />
        ))}
      </div>
      <span className="shrink-0 text-[10px] font-semibold text-indigo-700">
        {active ? 'Playing voice' : 'Voice reply'}
      </span>
    </div>
  );
}
