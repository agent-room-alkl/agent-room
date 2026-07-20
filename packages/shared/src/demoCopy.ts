// Educational welcome copy for the Demo Host per scenario.

export interface ScenarioCopy {
  id: string;
  title: string;
  shortDescription: string;
  whenToUse: string;
  exampleQuestions: string[];
  proTip: string;
  welcome: string;
}

function buildWelcome(
  title: string,
  whenToUse: string,
  examples: string[],
  tip: string,
  firstMessageHint: string,
): string {
  const exampleLines = examples.map(q => `- ${q}`).join('\n');
  return [
    `**Welcome to the ${title} session.**`,
    '',
    'This is a **normal Agent Room** — Open, Sequential, and Moderator modes all work here. Builder (Claude) and Reviewer (GPT) are already in the participant list.',
    '',
    whenToUse,
    '',
    `**Your first message should:** ${firstMessageHint}`,
    '',
    '**You can ask things like:**',
    exampleLines,
    '',
    `**Pro tip:** ${tip}`,
    '',
    'Paste or edit your first message in the composer below, then send ↓',
  ].join('\n');
}

function scenario(
  id: string,
  title: string,
  shortDescription: string,
  whenToUse: string,
  exampleQuestions: string[],
  proTip: string,
  firstMessageHint: string,
): ScenarioCopy {
  return {
    id,
    title,
    shortDescription,
    whenToUse,
    exampleQuestions,
    proTip,
    welcome: buildWelcome(title, whenToUse, exampleQuestions, proTip, firstMessageHint),
  };
}

export const SCENARIO_COPY: Record<string, ScenarioCopy> = {
  'blank-room': {
    ...scenario(
      'blank-room',
      'Blank Room',
      'Just want to chat, brainstorm, or see how agents respond without a task template.',
      'Use this when you want a blank room feel — say hi, ask anything, or riff on an idea. No code or PRD required.',
      [
        'Hi — what can you two help me with?',
        'I am exploring multi-agent workflows. What is actually useful vs hype?',
        'Brainstorm: how would you explain Agent Room to a non-technical founder in one paragraph?',
      ],
      'There is no wrong first message here. Short greetings are fine — agents will chat back naturally.',
      'Say hi, ask a question, or paste an idea — anything goes.',
    ),
    welcome: [
      '**Welcome to Blank Room.**',
      '',
      'This is a **normal Agent Room** — Open, Sequential, and Moderator modes all work here.',
      '',
      'No task template, no artifact required. Builder (Claude) and Reviewer (GPT) chat naturally with whatever you send.',
      '',
      '**Your first message should:** be anything — "hi", a brainstorm, or a question that needs live data.',
      '',
      '**Try saying:**',
      '- Hi — what can you help me with?',
      '- What is the latest Next.js version?',
      '- How would you explain multi-agent rooms to a founder?',
      '',
      '**Pro tip:** Short greetings are fine. Keep talking — each message gets new replies.',
      '',
      'Type in the composer below ↓',
    ].join('\n'),
  },
  'code-review': scenario(
    'code-review',
    'Code Review',
    'You wrote some code and want a second pair of eyes before you ship.',
    'Use this when you have a function, PR diff, or snippet you want stress-tested for bugs, security holes, and missing tests.',
    [
      'Review this auth function: function login(u, p) { return db.query("SELECT * FROM users WHERE name=\'" + u + "\'"); }',
      'Look at this React component for XSS risk: function Bio({ html }) { return <motion.div dangerouslySetInnerHTML={{__html: html}} /> }',
      'Critique this retry loop — what edge cases am I missing?',
    ],
    'Paste the actual code, not just a description. Builder is far more useful when it can quote specific lines.',
    'paste the **actual code or diff** you want reviewed — not just "hi" or a one-line ask.',
  ),
  'prd-review': scenario(
    'prd-review',
    'PRD / Product Review',
    "You're shaping a product feature and want feedback before writing the spec.",
    'Use this when you have a fuzzy product idea and want it sharpened into a structured PRD with the right risks flagged.',
    [
      'I want to add a streak feature: users get badges for daily logins. Goal is to lift DAU. Should I ship it?',
      "Reviewing: we're adding a 'team rooms' tier at $50/month. Help me find the gaps in this spec.",
      'Should we build offline-first sync or stay online-only for v1? What changes either way?',
    ],
    'Tell Builder the goal (north-star metric, user pain) before the feature. Reviewer hunts down assumptions you stated as facts.',
    'describe the **product idea, goal, and constraints** — enough for a real PRD review.',
  ),
  positioning: scenario(
    'positioning',
    'Landing / Positioning',
    "Your hero copy isn't converting and you want sharper positioning.",
    'Use this when your current hero copy feels generic and you want sharper messaging for a specific audience.',
    [
      "Current hero: 'AI-powered code review.' Make it sharper for senior engineers.",
      'My SaaS lets non-technical founders ship a v1 in a weekend. Help me write 3 hero copy variants.',
      "We're losing trial users in the first 30 seconds. Rewrite this landing intro: 'A workflow tool for modern teams.'",
    ],
    "Name your audience and what they're frustrated about today. Reviewer challenges anything that sounds like a buzzword.",
    'give the **product, audience, and current hero copy** you want sharpened.',
  ),
  competitor: scenario(
    'competitor',
    'Competitor Analysis',
    'You need to position against a known competitor or understand the gap.',
    'Use this when a competitor is bigger or has wider distribution and you need to find your defensible edge.',
    [
      "Compare us to Linear: we focus on AI-native collab for startups under 10 people. What's our edge?",
      "How does our offering stack up against Notion AI? We're cheaper and more focused — is that enough?",
      'A new YC-backed competitor just shipped the same feature for half our price. What should we do?',
    ],
    'Be honest about what they do BETTER, not just where you win. Reviewer will catch wishful thinking.',
    'name the **competitor or category** and your positioning — agents can web-search for fresh facts.',
  ),
  delivery: scenario(
    'delivery',
    'Delivery / Client Report',
    'You finished a sprint and need a polished update for a client or stakeholder.',
    'Use this when you have a raw list of what you shipped and need it framed into a client-ready update with the right context.',
    [
      'This sprint: shipped OAuth, fixed 3 P0 bugs, started Stripe integration but blocked on webhook validation. Write a client report.',
      'Weekly update for engineering exec: closed 18 tickets, P95 latency down 12%, regrettable rollback on the search index. Frame it.',
      "Need a one-pager for our investor: this month's product wins + the one thing we're worried about next month.",
    ],
    "Include the boring stuff (blockers, regressions) — Reviewer makes sure they're surfaced, not buried.",
    'list **what shipped, what blocked, and who the update is for** — raw notes are fine.',
  ),
};

export function scenarioWelcome(scenarioId: string): string {
  return (SCENARIO_COPY[scenarioId] ?? SCENARIO_COPY['code-review']!).welcome;
}

export function listScenarios(): ScenarioCopy[] {
  const order = ['blank-room', 'code-review', 'prd-review', 'positioning', 'competitor', 'delivery'];
  return order.map(id => SCENARIO_COPY[id]).filter((item): item is ScenarioCopy => Boolean(item));
}
