// Plan B Phase 1 — Live Session Templates as a *commercial* product axis.
//
// Every template here describes (a) a concrete ICP that has a budget for
// the problem, (b) the artifact they actually buy, (c) the pricing
// surface that would be charged for it, and (d) realistic mock content
// that would survive a hostile read by someone in that ICP.
//
// The pages under /templates/* render straight from this file. Keeping
// it as static data means Plan B Phase 1 can ship as pure UI — no
// server, no LiveKit, no OpenAI Realtime — while still being concrete
// enough for Robin to sanity-check the monetization story.

export type TemplateId =
  | 'interview'
  | 'coaching'
  | 'customer-research'
  | 'sales-qualification'
  | 'standup-facilitator';

export interface LiveTemplate {
  id: TemplateId;
  /** URL slug under /templates/<slug>/. */
  slug: string;
  emoji: string;
  /** "AI Interview" — short product-shaped name. */
  label: string;
  /** Sub-headline displayed under the label. */
  tagline: string;
  /** Buyer-facing one-liner — the value prop, not the feature list. */
  pitch: string;
  /** ICP block: who pays, how much, what triggers the buy. */
  buyer: {
    /** Concrete persona, not a job title. e.g. "SMB hiring manager who screens
     *  20+ candidates a quarter and can't afford HireVue's $25k/year floor." */
    persona: string;
    /** Headline price point (illustrative; locks the conversation around it). */
    price: string;
    /** Trigger event — the moment in the buyer's day this product appears
     *  to be the right answer. */
    trigger: string;
  };
  /** Roles the room ships with for this template. Order matters — the
   *  first role is the one the AI plays; the rest are humans. */
  roles: { name: string; ai: boolean; brief: string }[];
  /** The artifact the buyer actually receives at the end. This is the
   *  monetizable thing — every template's hero CTA links to a paywall
   *  for unlocking / exporting it. */
  artifact: {
    name: string; // e.g. "Scorecard"
    deliverableShape: string; // e.g. "PDF + permanent share URL"
    monetizationLine: string; // the copy under the CTA
  };
  /** A snippet of plausible mock conversation rendered on the demo
   *  page so the buyer immediately sees "this would actually look
   *  like a real X". Not Lorem Ipsum — read it through the buyer's
   *  eyes, it should feel real. */
  mockTranscript: { speaker: string; ai: boolean; text: string }[];
  /** Short list of structured outcomes the artifact contains. Renders
   *  as the right-side outcome panel on the demo page. */
  outcome: { label: string; value: string }[];
  /** Status of the actual implementation behind the demo. We list this
   *  honestly so Robin can show the page to pilots without overselling. */
  status: 'live-demo' | 'design-preview' | 'coming-soon';
  /** Pricing tier teased on the page — not committed pricing, but a
   *  realistic shape the buyer can react to. */
  pricing: { tier: string; per: string; price: string; includes: string[] }[];
}

const INTERVIEW: LiveTemplate = {
  id: 'interview',
  slug: 'interview',
  emoji: '🎙️',
  label: 'AI Interview',
  tagline: 'A real-time AI interviewer that runs the screening for you.',
  pitch:
    'Drop a candidate the link, the AI runs a 20-minute structured interview against your rubric, and you get a scorecard with quoted evidence. Built for SMB and startup hiring loops where HireVue is overkill.',
  buyer: {
    persona:
      'Hiring manager at a 20–200-person company screening 30+ candidates a quarter — the kind that can\'t justify HireVue\'s $25k/year floor but is losing 5–10 hours/week to first-round phone screens.',
    price: '$5 per completed interview · $99/mo unlimited (Pro)',
    trigger:
      '"Three days from now I have 8 phone screens for the same role and I haven\'t even read the resumes yet."',
  },
  roles: [
    { name: 'AI Interviewer', ai: true, brief: 'Runs the rubric, asks follow-ups, stays neutral.' },
    { name: 'Candidate', ai: false, brief: 'Joins from any browser — no login, no install.' },
    { name: 'Hiring Manager', ai: false, brief: 'Watches live or reviews the scorecard async.' },
  ],
  artifact: {
    name: 'Scorecard',
    deliverableShape: 'PDF + permanent share URL',
    monetizationLine:
      'Free preview shows top 3 dimensions. Pro unlocks the full rubric, evidence quotes, ATS export (Greenhouse / Lever / Ashby), and 30-day retention.',
  },
  mockTranscript: [
    {
      speaker: 'AI Interviewer',
      ai: true,
      text: 'Thanks for joining, Priya. I see you led the migration from REST to GraphQL at your last role. Walk me through the trade-off you optimized for first.',
    },
    {
      speaker: 'Priya (Candidate)',
      ai: false,
      text:
        'Honestly, it was the mobile team\'s pagination problem. Their old REST cursor design meant 14 round-trips on the home feed. We picked GraphQL specifically so they could batch the calls — the latency win was the headline, not "GraphQL because GraphQL."',
    },
    {
      speaker: 'AI Interviewer',
      ai: true,
      text: 'That trade-off framing matters. What did you give up to get it?',
    },
    {
      speaker: 'Priya (Candidate)',
      ai: false,
      text:
        'Caching got harder. We had a CDN-friendly REST surface that just stopped working — Apollo persisted queries got us 80% of it back, but for 6 weeks we were eating origin load. I should\'ve modeled that before cutover.',
    },
    {
      speaker: 'AI Interviewer',
      ai: true,
      text:
        'Solid self-aware answer. Last technical question, then we\'ll do a 5-minute behavioral round — design a rate limiter that survives a backend that occasionally stalls 10 seconds. Whiteboard it out loud.',
    },
  ],
  outcome: [
    { label: 'Recommendation', value: 'Strong yes — advance to onsite' },
    { label: 'Technical depth (1-5)', value: '4 — concrete trade-off framing, owns the post-mortem' },
    { label: 'Communication (1-5)', value: '4 — answers in cause→effect, not feature lists' },
    { label: 'Risk flag', value: 'Caching strategy gap — probe in onsite system design' },
    { label: 'Evidence quotes', value: '3 quoted lines tied to rubric dimensions' },
  ],
  status: 'design-preview',
  pricing: [
    {
      tier: 'Free',
      per: 'forever',
      price: '$0',
      includes: ['1 demo interview', 'Top-3 dimensions only', 'Watermarked share link', 'Email support'],
    },
    {
      tier: 'Pay-as-you-go',
      per: 'interview',
      price: '$5',
      includes: ['Full scorecard', 'Evidence quotes', 'PDF + permanent URL', 'Custom rubric'],
    },
    {
      tier: 'Pro',
      per: 'month',
      price: '$99',
      includes: ['Unlimited interviews', 'ATS export (Greenhouse/Lever/Ashby)', '30-day retention', 'Calibrated rubrics by role family', 'Priority support'],
    },
  ],
};

const COACHING: LiveTemplate = {
  id: 'coaching',
  slug: 'coaching',
  emoji: '🎯',
  label: 'AI Coach',
  tagline: 'Practice the conversation that\'s coming up — interview, sales call, exec review.',
  pitch:
    'Pick the conversation you\'re scared of, the AI plays the other side at the difficulty level you set, and you get a feedback report you can re-attempt against. Built for individuals practicing on their own time.',
  buyer: {
    persona:
      'Mid-career engineer prepping for a senior interview at a top company, or a sales rep practicing a CFO close ahead of EOQ. Time-rich on weekday evenings, budget for one bottle of wine a month.',
    price: '$19/mo individual · $39/mo Pro · $299/seat/yr B2B (L&D)',
    trigger:
      '"I have an interview Thursday and the only person willing to mock me is my partner who already heard this rant twice."',
  },
  roles: [
    { name: 'AI Coach', ai: true, brief: 'Plays the counterparty (interviewer / customer / boss). Adjustable difficulty.' },
    { name: 'Practitioner', ai: false, brief: 'You — drives the session, gets a report at the end.' },
  ],
  artifact: {
    name: 'Practice Plan',
    deliverableShape: 'Per-session feedback card + month-over-month trend graph',
    monetizationLine:
      'First 3 sessions free. Pro unlocks unlimited sessions, voice-tone analysis (filler-word rate, pace, confidence drift), and a 30-day improvement graph you can show your career coach.',
  },
  mockTranscript: [
    {
      speaker: 'AI Coach (playing FAANG interviewer)',
      ai: true,
      text: 'Tell me about a time a project you led was about to miss its deadline. Walk me through what you actually did, not what you wish you\'d done.',
    },
    {
      speaker: 'You',
      ai: false,
      text:
        'Q4 last year, the migration. We were 60% through and the launch window was three weeks out. I cut the bottom-third of features — the ones we\'d been keeping for "completeness" — and shipped the rest on time.',
    },
    {
      speaker: 'AI Coach',
      ai: true,
      text: 'You\'re telling me what you decided, not how. Who pushed back when you proposed cutting features, and how did you get them on board?',
    },
  ],
  outcome: [
    { label: 'Session score', value: '7.2 / 10 (+0.4 vs last session)' },
    { label: 'STAR structure', value: 'Strong on Situation/Action; weak on Result quantification' },
    { label: 'Filler-word rate', value: '3.1% (down from 5.8%)' },
    { label: 'Pace', value: '142 wpm — within target band' },
    { label: 'Next focus', value: 'Run 2 sessions on stakeholder-pushback questions before Thursday' },
  ],
  status: 'design-preview',
  pricing: [
    { tier: 'Free', per: 'forever', price: '$0', includes: ['3 sessions / month', 'Text feedback only', 'No history graph'] },
    { tier: 'Pro', per: 'month', price: '$19', includes: ['Unlimited sessions', 'Voice-tone analysis', '90-day trend graph', 'Custom scenarios'] },
    { tier: 'B2B (L&D)', per: 'seat / yr', price: '$299', includes: ['Everything in Pro', 'Manager dashboard', 'SCIM / SSO', 'Custom rubrics by role'] },
  ],
};

const CUSTOMER_RESEARCH: LiveTemplate = {
  id: 'customer-research',
  slug: 'customer-research',
  emoji: '🔬',
  label: 'AI Customer Research',
  tagline: 'Run 10 customer interviews in a week, ship a research brief on Friday.',
  pitch:
    'A trained AI researcher conducts the interview, you watch live or async, and the output is a synthesized brief — themes, quotes, opportunity sizing — instead of 10 hours of recordings nobody will listen to.',
  buyer: {
    persona:
      'PMM or PM at a Series A–C SaaS company who needs to ship a positioning doc / pricing change / new-feature spec, and has a "real customer voice" requirement they can\'t skip but also can\'t justify hiring a research firm for.',
    price: '$25 per interview · $499 per project (10 interviews + brief)',
    trigger:
      '"Marketing is asking for a new pricing page by month-end and the only data we have is one Slack thread from a CSM."',
  },
  roles: [
    { name: 'AI Researcher', ai: true, brief: 'Runs your discovery script, asks neutral follow-ups, never leads.' },
    { name: 'Customer', ai: false, brief: 'Joins via browser link. No login required.' },
    { name: 'PMM / PM (you)', ai: false, brief: 'Live observer or async reviewer.' },
  ],
  artifact: {
    name: 'Research Brief',
    deliverableShape: 'Markdown + slide-ready deck export · permanent share URL',
    monetizationLine:
      'Free: 1 interview + summary. Project pricing ($499) covers 10 interviews + cross-interview synthesis (themes, frequency, supporting quotes) — replaces a $5k research engagement.',
  },
  mockTranscript: [
    {
      speaker: 'AI Researcher',
      ai: true,
      text: 'Thanks for making time, Marcus. Walk me through the last time you tried to evaluate a tool in this category — start from the moment you decided you needed it.',
    },
    {
      speaker: 'Marcus (Head of RevOps)',
      ai: false,
      text:
        'It was January, we\'d just hired our second AE and our forecast meetings were taking 90 minutes because nobody trusted the numbers. I went to G2, made a shortlist of four, and immediately got buried by SDRs.',
    },
    {
      speaker: 'AI Researcher',
      ai: true,
      text: 'You said "nobody trusted the numbers" — what specifically would have made the numbers more trustworthy?',
    },
  ],
  outcome: [
    { label: 'Theme #1', value: 'Trust in the data — surfaced in 8 of 10 interviews' },
    { label: 'Theme #2', value: 'Buying journey killed by SDR follow-up volume — 6 of 10' },
    { label: 'Theme #3', value: 'Forecast meetings as the trigger event — 7 of 10' },
    { label: 'Quoted evidence', value: '24 quotes auto-categorized by theme' },
    { label: 'Recommended next move', value: 'Position around forecast trust, not pipeline volume' },
  ],
  status: 'design-preview',
  pricing: [
    { tier: 'Free', per: 'forever', price: '$0', includes: ['1 interview', 'Single-interview summary'] },
    { tier: 'Per interview', per: 'interview', price: '$25', includes: ['Full transcript', 'Theme tagging', 'Quote extraction', 'Permanent share URL'] },
    { tier: 'Project bundle', per: '10 interviews', price: '$499', includes: ['10 interviews', 'Cross-interview synthesis', 'Themes + frequency + opportunity sizing', 'Slide-ready brief export'] },
  ],
};

const SALES_QUALIFICATION: LiveTemplate = {
  id: 'sales-qualification',
  slug: 'sales-qualification',
  emoji: '📞',
  label: 'AI Sales Qualifier',
  tagline: 'Pre-qualify discovery calls so your AEs only show up for real opportunities.',
  pitch:
    'AI runs a 10-minute BANT/MEDDIC call with the prospect before your AE is on the calendar. Output: a qualification report with the boxes filled, the disqualifying answers flagged, and the call recording linked. Built for SMB SaaS where SDR time is the bottleneck.',
  buyer: {
    persona:
      'VP Sales at a 50–500-person SaaS company watching 60% of demo slots end in "not a fit" and burning the AE\'s top hour every day on the wrong calls.',
    price: '$10 per qualified call · $79/seat/mo (Team)',
    trigger:
      '"Our AE-to-meeting ratio is fine on paper but our close rate is half what it should be — we\'re putting AEs in front of unqualified prospects."',
  },
  roles: [
    { name: 'AI Qualifier', ai: true, brief: 'Runs your BANT/MEDDIC questions, neutral and non-pushy.' },
    { name: 'Prospect', ai: false, brief: 'Books the slot from your existing scheduling link.' },
    { name: 'AE / SDR (you)', ai: false, brief: 'Reads the report; only takes the meeting if green.' },
  ],
  artifact: {
    name: 'Qualification Report',
    deliverableShape: 'PDF + Salesforce / HubSpot / Attio sync',
    monetizationLine:
      'Free: 5 calls / mo with manual export. Team plan ($79/seat/mo) syncs straight into your CRM with custom field mapping and disqualification automation.',
  },
  mockTranscript: [
    {
      speaker: 'AI Qualifier',
      ai: true,
      text: 'Quick pre-call so we make the most of your AE time on Thursday. What\'s pushing you to evaluate this category right now?',
    },
    {
      speaker: 'Sarah (Director of Ops)',
      ai: false,
      text:
        'Honestly, our CFO pinged us last week — we\'re paying for three overlapping tools and he wants one out by next quarter. So I\'m looking at consolidation, not net-new.',
    },
    {
      speaker: 'AI Qualifier',
      ai: true,
      text: 'Got it — consolidation, CFO-driven, next-quarter timeline. Who else needs to be in the room when you make the call?',
    },
  ],
  outcome: [
    { label: 'BANT — Budget', value: '✅ CFO-driven; existing-tool budget reallocation' },
    { label: 'BANT — Authority', value: '⚠️ Director, not VP. Need her boss in demo.' },
    { label: 'BANT — Need', value: '✅ Real consolidation pain, quantified' },
    { label: 'BANT — Timeline', value: '✅ Next-quarter, hard deadline' },
    { label: 'Recommendation', value: 'Take the meeting. Pull Sarah\'s VP Ops in.' },
  ],
  status: 'design-preview',
  pricing: [
    { tier: 'Free', per: 'forever', price: '$0', includes: ['5 calls / month', 'PDF export only'] },
    { tier: 'Pay-as-you-go', per: 'qualified call', price: '$10', includes: ['Full BANT/MEDDIC report', 'Recording + transcript'] },
    { tier: 'Team', per: 'seat / month', price: '$79', includes: ['Unlimited calls', 'CRM sync (Salesforce / HubSpot / Attio)', 'Disqualification automation', 'Custom rubric per persona'] },
  ],
};

const STANDUP_FACILITATOR: LiveTemplate = {
  id: 'standup-facilitator',
  slug: 'standup-facilitator',
  emoji: '🌀',
  label: 'AI Standup Facilitator',
  tagline: 'Run the standup so the engineering manager doesn\'t have to.',
  pitch:
    'AI joins your daily 15-minute standup, asks each engineer the three questions, surfaces blockers, and writes the action items into Linear/Jira automatically. Output: a timeline + owner-assigned action items, not yet another Slack thread nobody re-reads.',
  buyer: {
    persona:
      'Engineering manager of a 5–15-person team without a dedicated scrum master, or an SRE on-call rotation that does daily handoffs and keeps losing context.',
    price: '$99/mo per team (≤10 people) · $499/mo (≤50 people)',
    trigger:
      '"My standup just turned into a 30-minute meeting again because I was on PTO and the team free-formed it."',
  },
  roles: [
    { name: 'AI Facilitator', ai: true, brief: 'Asks each person the 3 questions, time-boxes, captures blockers.' },
    { name: 'Engineers', ai: false, brief: 'Show up via web/Slack — no extra tool to install.' },
    { name: 'Manager', ai: false, brief: 'Reads the recap; intervenes on blockers async.' },
  ],
  artifact: {
    name: 'Standup Recap',
    deliverableShape: 'Linear / Jira / GitHub Issues action items + Slack/Email recap',
    monetizationLine:
      '7-day free trial. Team plan unlocks ticket sync, blocker-aging tracking ("X has been blocked 3 days"), and rotation memory across on-call handoffs.',
  },
  mockTranscript: [
    {
      speaker: 'AI Facilitator',
      ai: true,
      text: 'Morning team — let\'s keep it tight, 90 seconds each. Priya, you\'re up. Yesterday, today, blockers.',
    },
    {
      speaker: 'Priya (Senior Eng)',
      ai: false,
      text:
        'Yesterday I shipped the Stripe webhook retry fix to staging. Today I\'m moving it to prod after the design review at 11. Blocker: still waiting on the security team\'s sign-off on the new IAM role — it\'s been 4 days.',
    },
    {
      speaker: 'AI Facilitator',
      ai: true,
      text: '4-day security blocker noted — flagging for Marcus async. Sam, you\'re next.',
    },
  ],
  outcome: [
    { label: 'Today\'s blockers', value: '2 (1 escalated, 1 self-resolved)' },
    { label: 'Action items synced', value: '4 → Linear (auto-assigned to owners)' },
    { label: 'Aging blocker flagged', value: 'IAM role review — 4 days, escalated to Marcus' },
    { label: 'Velocity check', value: 'In-progress count unchanged 3 days running — investigate' },
    { label: 'Manager TL;DR', value: '1 item needs your call before EOD' },
  ],
  status: 'design-preview',
  pricing: [
    { tier: 'Free trial', per: '7 days', price: '$0', includes: ['Full Team plan, no card'] },
    { tier: 'Team', per: 'team / mo', price: '$99', includes: ['≤10 people', 'Linear / Jira sync', 'Blocker-aging tracker', 'Rotation memory'] },
    { tier: 'Org', per: 'org / mo', price: '$499', includes: ['≤50 people', 'Multi-team rollups', 'SCIM / SSO', 'Custom standup formats per team'] },
  ],
};

export const LIVE_TEMPLATES: LiveTemplate[] = [
  INTERVIEW,
  COACHING,
  CUSTOMER_RESEARCH,
  SALES_QUALIFICATION,
  STANDUP_FACILITATOR,
];

export function templateBySlug(slug: string): LiveTemplate | null {
  return LIVE_TEMPLATES.find(t => t.slug === slug) ?? null;
}
