export interface TemplateMetric {
  label: string;
  value: string;
}

export interface TemplateArtifact {
  title: string;
  description: string;
  fields: string[];
}

export interface TemplateDemoMessage {
  speaker: string;
  role: string;
  text: string;
  tone: 'host' | 'guest' | 'agent';
}

export interface LiveSessionTemplate {
  id: string;
  label: string;
  shortLabel: string;
  category: string;
  buyer: string;
  pricing: string;
  frequency: string;
  promise: string;
  proof: string;
  artifact: TemplateArtifact;
  roles: string[];
  metrics: TemplateMetric[];
  demoMessages: TemplateDemoMessage[];
  conversion: string;
  topicSeed: string;
}

export const LIVE_SESSION_TEMPLATES: LiveSessionTemplate[] = [
  {
    id: 'interview',
    label: 'AI Interview Voice Demo',
    shortLabel: 'Interview',
    category: 'Hiring',
    buyer: 'Recruiting teams and founders screening technical candidates',
    pricing: '$19 per interview export or team seats for recurring hiring loops',
    frequency: 'Every role, every short-list, every agency handoff',
    promise: 'Run a structured voice screen and leave with a scorecard a hiring manager can actually sign off.',
    proof: 'The demo artifact scores signal depth, risk, calibration, and next-step recommendation instead of dumping a transcript.',
    artifact: {
      title: 'Candidate Scorecard',
      description: 'A hiring-ready evaluation with evidence quotes, risk flags, interviewer notes, and a clear advance / hold / reject recommendation.',
      fields: ['Competency scores', 'Evidence snippets', 'Concern flags', 'Follow-up questions', 'Recommendation'],
    },
    roles: ['Voice interviewer', 'Candidate', 'Hiring manager reviewer', 'Skeptic evaluator'],
    metrics: [
      { label: 'Artifact buyer', value: 'Head of Talent' },
      { label: 'Session length', value: '18 min' },
      { label: 'Paid unit', value: 'Scorecard export' },
    ],
    demoMessages: [
      {
        speaker: 'Interviewer',
        role: 'AI voice agent',
        tone: 'agent',
        text: 'Walk me through a production incident where you had to choose between a rollback and a hotfix.',
      },
      {
        speaker: 'Candidate',
        role: 'Senior frontend engineer',
        tone: 'guest',
        text: 'We rolled back first because checkout was affected, then isolated the hydration bug behind a feature flag before re-enabling the new flow.',
      },
      {
        speaker: 'Evaluator',
        role: 'Skeptic agent',
        tone: 'agent',
        text: '[STATUS] Strong incident judgment. Probe for whether they measured customer impact or only relied on error rate.',
      },
    ],
    conversion: 'Book a 10-interview pilot with branded scorecards and export unlocks.',
    topicSeed: 'AI interview: Senior frontend engineer screen',
  },
  {
    id: 'customer-research',
    label: 'Customer Research Debrief',
    shortLabel: 'Research',
    category: 'Product',
    buyer: 'PMs, founders, and PMM teams validating a feature or segment',
    pricing: '$49 per research brief or monthly project workspace',
    frequency: 'Every discovery sprint and every launch readout',
    promise: 'Turn interview notes and live synthesis into a research brief with evidence, themes, and product decisions.',
    proof: 'The paid artifact is a decision brief: customer quotes mapped to product bets, not a generic summary.',
    artifact: {
      title: 'Research Decision Brief',
      description: 'A ranked set of themes, supporting quotes, confidence level, product implications, and open risks.',
      fields: ['Top themes', 'Quote evidence', 'Segment notes', 'Product bets', 'Risk register'],
    },
    roles: ['Research lead', 'Skeptic', 'PM reviewer', 'Writer'],
    metrics: [
      { label: 'Artifact buyer', value: 'Product lead' },
      { label: 'Session length', value: '35 min' },
      { label: 'Paid unit', value: 'Research brief' },
    ],
    demoMessages: [
      {
        speaker: 'Researcher',
        role: 'PM',
        tone: 'host',
        text: 'Three users described handoff anxiety after AI-generated work. The recurring phrase was "I still need to trust what changed."',
      },
      {
        speaker: 'Skeptic',
        role: 'Agent',
        tone: 'agent',
        text: '[DECISION] Treat trust handoff as the primary problem. Do not frame this as "more automation" in the next prototype.',
      },
      {
        speaker: 'Writer',
        role: 'Agent',
        tone: 'agent',
        text: '[TODO] Draft a one-page brief with exact quotes, confidence level, and the smallest product test.',
      },
    ],
    conversion: 'Start a paid pilot for one discovery sprint and export a branded brief.',
    topicSeed: 'Customer research: trust handoff after AI work',
  },
  {
    id: 'sales-qualification',
    label: 'Sales Qualification Room',
    shortLabel: 'Sales',
    category: 'Revenue',
    buyer: 'Founders and sales teams qualifying inbound leads',
    pricing: '$9 per qualified lead report or seat-based CRM team plan',
    frequency: 'Every serious inbound lead before founder time is spent',
    promise: 'Capture budget, pain, urgency, stakeholders, and next step as a qualification report your team can act on.',
    proof: 'The artifact makes the go / no-go call explicit and gives the next email, not just call notes.',
    artifact: {
      title: 'Qualification Report',
      description: 'A BANT-plus summary with urgency, budget confidence, stakeholder map, risk, and recommended next action.',
      fields: ['Pain summary', 'Budget signal', 'Stakeholders', 'Objections', 'Next email'],
    },
    roles: ['SDR voice agent', 'Prospect', 'Deal skeptic', 'Account executive'],
    metrics: [
      { label: 'Artifact buyer', value: 'Founder / AE' },
      { label: 'Session length', value: '12 min' },
      { label: 'Paid unit', value: 'Qualified lead' },
    ],
    demoMessages: [
      {
        speaker: 'Prospect',
        role: 'Ops lead',
        tone: 'guest',
        text: 'We have budget this quarter if it reduces manual QA review time. The blocker is security approval.',
      },
      {
        speaker: 'Deal skeptic',
        role: 'Agent',
        tone: 'agent',
        text: '[STATUS] Qualified on pain and timing, weak on procurement path. Ask who owns vendor review.',
      },
      {
        speaker: 'AE',
        role: 'Agent',
        tone: 'agent',
        text: '[RESULT] Recommend 30-minute security-focused demo with CTO and ops lead. Do not send generic deck.',
      },
    ],
    conversion: 'Connect the pilot to a CRM export and charge per accepted qualification.',
    topicSeed: 'Sales qualification: inbound ops lead for Agent Room',
  },
  {
    id: 'coaching',
    label: 'Manager Coaching Practice',
    shortLabel: 'Coaching',
    category: 'Learning',
    buyer: 'People teams running manager training and feedback practice',
    pricing: '$29 per coaching report or per-seat training cohort',
    frequency: 'Every training cohort and every manager readiness check',
    promise: 'Let a manager practice a hard conversation and receive a concrete coaching report with better wording.',
    proof: 'The artifact includes behavioral scoring and replacement phrasing, which L&D teams can use for follow-up coaching.',
    artifact: {
      title: 'Coaching Feedback Report',
      description: 'A structured critique with empathy score, clarity score, risk moments, suggested rewrites, and next practice scenario.',
      fields: ['Behavior scores', 'Risk moments', 'Better phrasing', 'Manager notes', 'Next drill'],
    },
    roles: ['Manager learner', 'Employee roleplay', 'Coach agent', 'HR reviewer'],
    metrics: [
      { label: 'Artifact buyer', value: 'People team' },
      { label: 'Session length', value: '15 min' },
      { label: 'Paid unit', value: 'Coaching report' },
    ],
    demoMessages: [
      {
        speaker: 'Manager',
        role: 'Learner',
        tone: 'host',
        text: 'Your delivery has been inconsistent, and I need you to take more ownership before the next release.',
      },
      {
        speaker: 'Coach',
        role: 'Agent',
        tone: 'agent',
        text: '[STATUS] Direct but underspecified. Ask for one concrete example and add support offer before consequence.',
      },
      {
        speaker: 'HR reviewer',
        role: 'Agent',
        tone: 'agent',
        text: '[TODO] Rewrite with observable behavior, impact, expectation, and follow-up date.',
      },
    ],
    conversion: 'Run a 20-manager cohort and export private coaching reports.',
    topicSeed: 'Manager coaching: missed deadline conversation',
  },
];

export function liveSessionTemplateById(id: string | undefined): LiveSessionTemplate | undefined {
  return LIVE_SESSION_TEMPLATES.find(template => template.id === id);
}
