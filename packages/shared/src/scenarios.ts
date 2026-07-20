export type DemoSlot = 'Builder' | 'Reviewer' | 'Researcher' | 'Coder' | 'Reasoner';
export type DemoProvider = 'anthropic' | 'openai' | 'google' | 'qwen' | 'deepseek';

export type HostedScenarioId =
  | 'blank'
  | 'developer'
  | 'docs-data'
  | 'design-creative'
  | 'marketing-growth'
  | 'high-stakes-decision';

export interface HostedScenarioAgent {
  /**
   * Position label kept for backwards compatibility with the per-tier model
   * dropdowns. The actual provider routing per scenario is `provider` below.
   */
  slot: DemoSlot;
  /**
   * The model provider that fills this role in this scenario. Different
   * scenarios assign providers based on each model's strengths — e.g.
   * Creative / Copy puts GPT in the lead writing role, Research puts
   * Gemini in the lead (web-search) role, Code Review puts Claude in
   * the implementer role.
   */
  provider: DemoProvider;
  roleLabel: string;
  promptHint: string;
}

export interface HostedScenario {
  id: HostedScenarioId;
  title: string;
  shortTitle: string;
  description: string;
  fit: string;
  exampleTopic: string;
  exampleMessage: string;
  agents: HostedScenarioAgent[];
  /**
   * Which slot is the "star" of this scenario — the one Value tier
   * promotes to a Best model while the other two stay on Value-tier
   * models. This keeps Value tier meaningful per-scenario.
   */
  primarySlot: DemoSlot;
}

export const HOSTED_SCENARIOS: HostedScenario[] = [
  {
    id: 'blank',
    title: 'Blank Room',
    shortTitle: 'Blank',
    description: 'Start from an empty room and choose the agents and versions yourself.',
    fit: 'Use this when none of the presets fit. Pick any mix of agents up to your current seat limit, then choose Standard, Value, Best, or custom model versions if your plan allows it.',
    exampleTopic: 'Open-ended agent room',
    exampleMessage: 'Help me think through this from multiple angles. Challenge assumptions, propose options, and converge on a practical next step.',
    agents: [
      { slot: 'Builder', provider: 'anthropic', roleLabel: 'Builder', promptHint: 'Create the first concrete draft, plan, or structure.' },
      { slot: 'Reviewer', provider: 'openai', roleLabel: 'Reviewer', promptHint: 'Pressure-test assumptions, risks, quality, and missing edge cases.' },
      { slot: 'Researcher', provider: 'google', roleLabel: 'Researcher', promptHint: 'Check current facts, sources, docs, market context, and external evidence.' },
      { slot: 'Coder', provider: 'deepseek', roleLabel: 'Coder', promptHint: 'Translate the discussion into implementation details, tests, APIs, and rollout steps.' },
      { slot: 'Reasoner', provider: 'qwen', roleLabel: 'Reasoner', promptHint: 'Run an independent logic pass on tradeoffs, contradictions, and failure modes.' },
    ],
    primarySlot: 'Builder',
  },
  {
    id: 'developer',
    title: 'Developer',
    shortTitle: 'Dev',
    description: 'Write, review, debug, and ship code with a full engineering team.',
    fit: 'Your default room for anything code: implement a feature, review a diff, hunt a bug, or weigh an architecture call. Claude reads the codebase, GPT blocks bad merges, DeepSeek writes the patch, Gemini checks docs/CVEs, Qwen models the failure modes.',
    exampleTopic: 'Ship and review a new feature',
    exampleMessage: 'Here is the change I want to make. Plan it, write the code, review it for regressions and edge cases, and tell me what tests I still need.',
    agents: [
      { slot: 'Builder', provider: 'anthropic', roleLabel: 'Codebase Lead', promptHint: 'Trace the change through architecture, state, data flow, and local conventions. Plan the implementation and say where it may break.' },
      { slot: 'Reviewer', provider: 'openai', roleLabel: 'Release Blocker', promptHint: 'Decide what should block merge: regressions, missing tests, unclear acceptance criteria, security issues, and rollback risk.' },
      { slot: 'Coder', provider: 'deepseek', roleLabel: 'Patch Engineer', promptHint: 'Write the actual code, tests, and migration steps. Run snippets to verify behavior before presenting them.' },
      { slot: 'Researcher', provider: 'google', roleLabel: 'Docs & CVE Checker', promptHint: 'Verify current framework behavior, package docs, runtime constraints, and known security advisories via web search.' },
      { slot: 'Reasoner', provider: 'qwen', roleLabel: 'Failure-Mode Analyst', promptHint: 'Model edge cases and causal chains. Find the scenario where this change passes review but fails in production.' },
    ],
    primarySlot: 'Builder',
  },
  {
    id: 'docs-data',
    title: 'Docs & Data',
    shortTitle: 'Docs',
    description: 'Turn messy inputs into clean reports, spreadsheets, decks, and analysis.',
    fit: 'For office and analytical work: draft and structure a report, build or clean a spreadsheet, outline a deck, or pull numbers into a recommendation. Agents can generate real .docx / .xlsx / .pptx / .pdf files and run code to crunch the data.',
    exampleTopic: 'Turn this data into a report',
    exampleMessage: 'Take this raw information, structure it into a clear report, build a summary spreadsheet, and tell me the three things that actually matter.',
    agents: [
      { slot: 'Builder', provider: 'anthropic', roleLabel: 'Document Lead', promptHint: 'Structure the report, deck, or document: outline, sections, headings, executive summary, and clear prose. Generate the actual file when asked.' },
      { slot: 'Coder', provider: 'deepseek', roleLabel: 'Data & File Engineer', promptHint: 'Run code to clean, compute, and chart the data, and produce real .xlsx / .docx / .pptx / .pdf files with python-docx, openpyxl, python-pptx, reportlab.' },
      { slot: 'Researcher', provider: 'google', roleLabel: 'Fact & Source Checker', promptHint: 'Verify figures, definitions, benchmarks, and external context via web search. Flag anything stated as fact that is not supported.' },
      { slot: 'Reviewer', provider: 'openai', roleLabel: 'Clarity Editor', promptHint: 'Cut fluff, tighten structure, fix inconsistent numbers/labels, and make the document skimmable and decision-ready.' },
      { slot: 'Reasoner', provider: 'qwen', roleLabel: 'Analysis Skeptic', promptHint: 'Pressure-test the conclusions: check the math, question the assumptions behind the numbers, and surface the strongest counter-read of the data.' },
    ],
    primarySlot: 'Builder',
  },
  {
    id: 'design-creative',
    title: 'Design & Creative',
    shortTitle: 'Design',
    description: 'Shape visual direction and generate images, mockups, and social assets.',
    fit: 'For visual and creative work: explore a concept, set art direction, and generate actual images for a campaign, post, logo direction, or page. GPT and Gemini can produce images; the others critique, source references, and keep it on-brand and feasible.',
    exampleTopic: 'Create visuals for a launch',
    exampleMessage: 'I need visual direction and some actual image options for this launch. Propose a concept, generate a few images, and tell me which direction is strongest and why.',
    agents: [
      { slot: 'Builder', provider: 'openai', roleLabel: 'Art Director & Image Maker', promptHint: 'Define the concept, mood, and layout, then generate actual images for it. Take clear but usable creative swings.' },
      { slot: 'Researcher', provider: 'google', roleLabel: 'Reference & Image Scout', promptHint: 'Find relevant visual references and category patterns via web search, and generate alternative image directions to compare.' },
      { slot: 'Reviewer', provider: 'anthropic', roleLabel: 'Brand Critic', promptHint: 'Challenge cliches, weak differentiation, accessibility issues, tone mismatch, and execution risk. Keep it on-brand.' },
      { slot: 'Coder', provider: 'deepseek', roleLabel: 'Production Planner', promptHint: 'Translate the direction into concrete assets, sizes, components, and the steps to actually produce them.' },
      { slot: 'Reasoner', provider: 'qwen', roleLabel: 'Concept Judge', promptHint: 'Evaluate whether each concept is coherent, differentiated, feasible, and worth producing — then pick the strongest.' },
    ],
    primarySlot: 'Builder',
  },
  {
    id: 'marketing-growth',
    title: 'Marketing & Growth',
    shortTitle: 'Growth',
    description: 'Plan campaigns, write copy, and pressure-test go-to-market.',
    fit: 'For getting attention and customers: positioning, launch and ad copy, social posts, GTM and channel plans. GPT writes the copy, Claude edits for brand, Gemini brings live market evidence, DeepSeek stress-tests the funnel logic.',
    exampleTopic: 'Plan a product launch',
    exampleMessage: 'Help me launch this. Sharpen the positioning, write the landing + social + email copy, and pressure-test the go-to-market plan.',
    agents: [
      { slot: 'Builder', provider: 'openai', roleLabel: 'Copy & Campaign Lead', promptHint: 'Write headlines, landing copy, ad and social variants, and email sequences. Take tasteful creative swings, then tighten for conversion.' },
      { slot: 'Reviewer', provider: 'anthropic', roleLabel: 'Brand & Positioning Editor', promptHint: 'Sharpen positioning, cut generic claims, fix tone, and make the differentiation specific and credible.' },
      { slot: 'Researcher', provider: 'google', roleLabel: 'Market & Channel Scout', promptHint: 'Bring current competitor framing, channel norms, pricing, and audience-language evidence via web search. Cite what changes the plan.' },
      { slot: 'Coder', provider: 'deepseek', roleLabel: 'Funnel & Tracking Planner', promptHint: 'Turn the plan into a concrete funnel, channel mix, landing structure, UTM/analytics setup, and a test plan.' },
      { slot: 'Reasoner', provider: 'qwen', roleLabel: 'Growth Skeptic', promptHint: 'Test whether the value prop follows from the evidence, find the weakest funnel assumption, and name the strongest buyer objection.' },
    ],
    primarySlot: 'Builder',
  },
  {
    id: 'high-stakes-decision',
    title: 'High-Stakes Decision',
    shortTitle: 'Decision',
    description: 'Insurance, legal, financial, and medical calls where being wrong is costly.',
    fit: 'For consequential decisions in regulated, high-risk fields. Five different model families weigh the question independently so no single model\'s blind spot decides it. CRITICAL: every agent is told to flag uncertainty and say "I don\'t know" rather than guess — never invent rules, citations, numbers, or precedents.',
    exampleTopic: 'Assess a high-stakes decision',
    exampleMessage: 'Here is the situation and the facts I have. Give me your assessment, state your confidence, list exactly what you are unsure about, and tell me what a qualified professional must verify before I act. Do not guess.',
    agents: [
      { slot: 'Reasoner', provider: 'qwen', roleLabel: 'Lead Analyst', promptHint: 'Reason carefully from ONLY the facts given. State your assessment, your confidence level, and the assumptions it rests on. If a fact is missing or you are not sure, say so explicitly — never invent figures, rules, citations, dates, or precedents. End by listing what a qualified professional must verify.' },
      { slot: 'Reviewer', provider: 'openai', roleLabel: 'Risk & Compliance Reviewer', promptHint: 'Stress-test the analysis for what could go wrong: regulatory, legal, financial, or safety risk. Flag anything stated as fact that is not actually established. If you do not know a rule or requirement, say "I do not know" rather than guessing — a confident wrong answer is the worst outcome here.' },
      { slot: 'Researcher', provider: 'google', roleLabel: 'Evidence Checker', promptHint: 'Verify claims against current sources via web search and cite them. Only state things you can support; clearly label anything unverified as unverified. Do NOT fabricate citations, statutes, case names, or numbers — if you cannot find a source, say so.' },
      { slot: 'Builder', provider: 'anthropic', roleLabel: 'Decision Synthesizer', promptHint: 'Combine the others into one clear recommendation with an explicit confidence level and the conditions under which it would change. Separate "what we know" from "what we are assuming". Always include a clear disclaimer that this is not professional (legal/medical/financial) advice and a human expert must confirm.' },
      { slot: 'Coder', provider: 'deepseek', roleLabel: 'Devil\'s Advocate', promptHint: 'Argue the opposite of the leading recommendation and find the scenario where following it causes real harm. Surface the single most dangerous unstated assumption. Do not soften — but do not invent facts to win; mark speculation as speculation.' },
    ],
    primarySlot: 'Reasoner',
  },
];

/** Custom-tier model dropdowns for hosted start flow (shared by web UI). */
export const HOSTED_CUSTOM_MODEL_CHOICES: Record<DemoSlot, readonly string[]> = {
  Builder: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  Reviewer: ['gpt-5', 'gpt-5-mini', 'gpt-4o-mini'],
  Researcher: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  Coder: ['deepseek-reasoner', 'deepseek-chat'],
  Reasoner: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
};

export const HOSTED_PROVIDER_MODEL_CHOICES: Record<DemoProvider, readonly string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4o-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  qwen: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'],
  deepseek: ['deepseek-reasoner', 'deepseek-chat'],
};

export const HOSTED_TIER_MODEL_BY_PROVIDER: Record<'best' | 'value' | 'standard', Record<DemoProvider, string>> = {
  best: {
    anthropic: 'claude-opus-4-7',
    openai: 'gpt-5',
    google: 'gemini-2.5-pro',
    qwen: 'qwen3.7-max',
    deepseek: 'deepseek-reasoner',
  },
  value: {
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-5-mini',
    google: 'gemini-2.5-flash',
    qwen: 'qwen3.7-plus',
    deepseek: 'deepseek-chat',
  },
  standard: {
    anthropic: 'claude-haiku-4-5',
    openai: 'gpt-4o-mini',
    google: 'gemini-2.5-flash',
    qwen: 'qwen3.6-flash',
    deepseek: 'deepseek-chat',
  },
};

export function getHostedScenario(id: string | undefined): HostedScenario | undefined {
  return HOSTED_SCENARIOS.find(s => s.id === id);
}

export function scenarioAgentForSlot(scenario: HostedScenario | undefined, slot: DemoSlot): HostedScenarioAgent | undefined {
  return scenario?.agents.find(a => a.slot === slot);
}
