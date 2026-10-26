import type { EngineInterface, Register } from 'claude-code'

// Smart Router: each turn starts on the cheapest model that suits it (Haiku for
// lookups and one-off commands, Sonnet for ordinary scoped edits, the session
// model for everything else) and climbs one rung, Haiku -> Sonnet -> session
// model, the moment it shows it is harder than it looked: it wants to change
// files on Haiku, hits tool errors, runs long, spreads over many files, or is
// cut off.

type Tier = 'light' | 'medium' | 'full'
type Mode = 'balanced' | 'safe' | 'off'

type Settings = {
  // balanced: Haiku, Sonnet and the session model; safe: Haiku and the session
  // model only (Sonnet is still the first rung a Haiku turn climbs to).
  mode: Mode
  // Above this many context tokens, a switch to a model whose prompt cache is
  // cold costs more than it saves, so the turn stays where it is.
  switchContextLimit: number
  // Ask a small model to triage prompts the keyword rules can't place.
  useClassifier: boolean
}

type Stats = {
  light: number
  medium: number
  full: number
  lightToMedium: number
  mediumToFull: number
  subagents: number
  classifierCalls: number
  classifierTokens: number
}

type Route = {
  tier: Tier
  start: Tier
  reason: string
  escalated?: string
  toolErrors: number
  // Index of the step the current tier began at.
  tierStartStep: number
  // Index of the latest step.
  step: number
  edited: Set<string>
}

const DEFAULTS: Settings = { mode: 'balanced', switchContextLimit: 40_000, useClassifier: true }
const NO_STATS: Stats = {
  light: 0,
  medium: 0,
  full: 0,
  lightToMedium: 0,
  mediumToFull: 0,
  subagents: 0,
  classifierCalls: 0,
  classifierTokens: 0,
}

const TIER_MODEL: Record<Tier, string | undefined> = { light: 'haiku', medium: 'sonnet', full: undefined }
const NEXT_TIER: Record<Tier, Tier> = { light: 'medium', medium: 'full', full: 'full' }

// How much a tier may take on before it hands the turn up a rung.
const LIMITS: Record<Tier, { steps: number; toolErrors: number; files: number }> = {
  light: { steps: 6, toolErrors: 2, files: 0 },
  medium: { steps: 25, toolErrors: 3, files: 6 },
  full: { steps: Infinity, toolErrors: Infinity, files: Infinity },
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const DELEGATE_TOOLS = new Set(['Agent', 'Task'])

// Subagent types that only read and report back, and the tier each runs on.
const READ_ONLY_AGENTS: Record<string, Tier> = {
  Explore: 'medium',
  'claude-code-guide': 'medium',
  'statusline-setup': 'light',
}

const COMPLEX =
  /\b(implement|refactor|architect|design|debug|investigat|diagnos|root cause|migrat|optimi[sz]|performance|secur|vulnerab|race condition|concurren|deadlock|algorithm|prove|plan|review|audit|build|scaffold|feature|integrat|deploy|why (does|is|did|do)|fail|broken|bug|crash|error|exception|stack ?trace|regression|mods?\b|plugin|schema|database|across|entire|whole|every|all (the )?files)\w*/i
const STANDARD =
  /\b(add|write|update|change|edit|tweak|adjust|convert|document|docstring|comment|rename|move|delete|remove|replace|format|lint|typo|bump|upgrade|translate|test for|unit test|readme|type hints?|log(ging)?)\b/i
const TRIVIAL =
  /^(what('s| is| are| does)|where('s| is| are)|which|who|when|show|list|print|cat|open|read|define|summari[sz]e|explain (what|this|the)|run (the )?(tests?|lint|linter|build|formatter)|git (status|log|diff|branch|show)|how (do i|to|does)|what does|is there|does (this|it|the))\b/i
// Run a check and say what it printed; asking for a fix is not this.
const RUN_AND_REPORT =
  /^(please )?run (the )?(tests?|test suite|lint(er)?|build|type ?check)\b(?!.*\b(fix|make|change|until|then (fix|update)))/i
const CONFIRM =/^(y(es|ep|eah)?|ok(ay)?|sure|go( ahead| for it)?|do it|continue|proceed|sounds good|lgtm|ship it|approved?)[\s.!,]*$/i
const THANKS = /^(thanks?( you)?|ty|great|nice|cool|perfect|awesome|got it|👍)[\s.!]*$/i
// The person says the last answer missed: the next turns stay on the full model.
const COMPLAINT =
  /\b(wrong|incorrect|didn'?t work|doesn'?t work|not working|still (fail|broken|wrong|not)|not what i (asked|wanted|meant)|try again|redo|that'?s not|you missed|worse)\b/i

let settings: Settings = DEFAULTS
let isDisabledByEnv = false
let override: Tier | undefined
let sessionModel: string | undefined
let lastTier: Tier = 'full'
let lastWasCheap = false
let stickyFullTurns = 0
let lastTurnAt = 0
let lastContextTokens = 0
let current: Route | undefined
const routes = new Map<string, Route>()

function rank(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 1
  if (m.includes('sonnet')) return 2
  return 3
}

// The model a tier asks for, or undefined where the session's own model is
// already no more expensive.
function modelFor(tier: Tier, current: string): string | undefined {
  const target = TIER_MODEL[tier]
  return target !== undefined && rank(target) < rank(current) ? target : undefined
}

function heuristic(text: string): { tier: Tier; reason: string } | undefined {
  const t = text.trim()
  if (t === '') return { tier: 'full', reason: 'continuation' }
  if (CONFIRM.test(t)) return { tier: lastTier, reason: 'confirmation, same tier as before' }
  if (THANKS.test(t)) return { tier: 'light', reason: 'acknowledgement' }
  if (lastWasCheap && COMPLAINT.test(t)) {
    stickyFullTurns = 2
    return { tier: 'full', reason: 'last answer missed' }
  }
  if (t.includes('```') || t.length > 500 || t.split('\n').length > 4)
    return { tier: 'full', reason: 'long or code-bearing prompt' }
  if (t.length <= 200 && RUN_AND_REPORT.test(t)) return { tier: 'light', reason: 'run and report' }
  if (COMPLEX.test(t)) return { tier: 'full', reason: 'complex task keywords' }
  if (t.length <= 300 && STANDARD.test(t)) return { tier: 'medium', reason: 'scoped edit' }
  if (t.length <= 200 && TRIVIAL.test(t)) return { tier: 'light', reason: 'simple lookup or command' }
  return undefined
}

const TRIAGE_SYSTEM =
  'You triage requests sent to a coding assistant by how capable a model they need. Answer with one word.\n' +
  'trivial: a lookup, a short factual answer, or one read-only command; no code is written.\n' +
  'standard: a scoped, well-specified change or explanation: a small edit, a docstring, a simple test, a rename.\n' +
  'complex: design, debugging, ambiguous goals, multi-file or subtle changes, anything where a mistake is costly.\n' +
  'When unsure between two, answer the harder one.'

async function triage($: EngineInterface, text: string): Promise<{ tier: Tier; reason: string }> {
  if (!settings.useClassifier) return { tier: 'full', reason: 'unclassified' }
  const r = await $.model.complete({
    model: 'haiku',
    system: TRIAGE_SYSTEM,
    prompt: `Request:\n${text.slice(0, 2000)}\n\nAnswer trivial, standard or complex.`,
    maxTokens: 5,
    timeoutMs: 8000,
  })
  await bump($, 'classifierCalls')
  await bump($, 'classifierTokens', r.usage.input_tokens + r.usage.output_tokens)
  const label = r.isAnswered ? r.text.trim().toLowerCase() : ''
  if (label.startsWith('trivial')) return { tier: 'light', reason: 'triaged trivial' }
  if (label.startsWith('standard')) return { tier: 'medium', reason: 'triaged standard' }
  return { tier: 'full', reason: `triaged ${label || 'unclear'}` }
}

async function bump($: EngineInterface, key: keyof Stats, by = 1) {
  const stats = { ...NO_STATS, ...((await $.store.get('stats')) as Partial<Stats> | undefined) }
  stats[key] += by
  await $.store.set('stats', stats)
}

function show($: EngineInterface, route: Route) {
  const model = TIER_MODEL[route.tier]
  if (route.escalated !== undefined)
    $.ui.status(`route: ${model ?? sessionModel ?? 'session model'} (up from ${route.start}: ${route.escalated})`)
  else $.ui.status(model === undefined ? undefined : `route: ${model} (${route.reason})`)
}

// Hands the turn one rung up; the next model request goes to the new tier.
async function escalate($: EngineInterface, route: Route, why: string, atStep: number) {
  if (route.tier === 'full') return
  const from = route.tier
  route.tier = NEXT_TIER[from]
  route.escalated = why
  route.toolErrors = 0
  route.tierStartStep = atStep
  lastTier = route.tier
  show($, route)
  await bump($, from === 'light' ? 'lightToMedium' : 'mediumToFull')
}

async function loadSettings($: EngineInterface) {
  settings = { ...DEFAULTS, ...((await $.store.get('settings')) as Partial<Settings> | undefined) }
  if (!['balanced', 'safe', 'off'].includes(settings.mode)) settings.mode = 'balanced'
  isDisabledByEnv = (await $.env.get('SMART_ROUTER')) === 'off'
}

async function saveSettings($: EngineInterface, patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  await $.store.set('settings', settings)
}

function decideStart(text: string, $: EngineInterface): Promise<{ tier: Tier; reason: string }> | { tier: Tier; reason: string } {
  if (override !== undefined) {
    const forced = { tier: override, reason: 'forced by prefix' }
    override = undefined
    return forced
  }
  if (isDisabledByEnv || settings.mode === 'off') return { tier: 'full', reason: 'router off' }
  if (stickyFullTurns > 0 && !COMPLAINT.test(text)) {
    stickyFullTurns -= 1
    return { tier: 'full', reason: 'recent answer missed' }
  }
  return heuristic(text) ?? triage($, text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    await $.command.register({
      name: 'route',
      description: 'Smart Router: status | balanced | safe | off | classifier on|off | reset',
      argumentHint: 'status | balanced | safe | off | classifier on|off | reset',
    })
    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const [cmd = 'status', arg] = e.args.trim().toLowerCase().split(/\s+/)
    if (cmd === 'balanced' || cmd === 'safe' || cmd === 'off') {
      await saveSettings($, { mode: cmd })
      return { text: `Smart Router mode: ${cmd}.` }
    }
    if (cmd === 'classifier' && (arg === 'on' || arg === 'off')) {
      await saveSettings($, { useClassifier: arg === 'on' })
      return { text: `Smart Router classifier ${arg}.` }
    }
    if (cmd === 'reset') {
      await $.store.set('stats', NO_STATS)
      return { text: 'Smart Router stats reset.' }
    }
    const s = { ...NO_STATS, ...((await $.store.get('stats')) as Partial<Stats> | undefined) }
    return {
      text: [
        `Smart Router — mode ${isDisabledByEnv ? 'off (SMART_ROUTER=off)' : settings.mode}, classifier ${settings.useClassifier ? 'on' : 'off'}`,
        `Session model: ${sessionModel ?? '(not seen yet)'}; last turn ended on: ${lastTier}`,
        `Turns started on — Haiku ${s.light}, Sonnet ${s.medium}, session model ${s.full}`,
        `Escalations — Haiku→Sonnet ${s.lightToMedium}, Sonnet→session model ${s.mediumToFull}`,
        `Read-only subagents on a cheaper model: ${s.subagents}`,
        `Triage calls: ${s.classifierCalls} (${s.classifierTokens} Haiku tokens)`,
        'Prefix a prompt with !full, !sonnet or !light to pick the starting tier for that turn.',
      ].join('\n'),
    }
  })

  // `!full …` / `!sonnet …` / `!light …` pick the tier for the turn this prompt starts.
  on('prompt.submit', ($, e, next) => {
    if (e.command !== undefined || e.isMeta) return next(e)
    const m = /^\s*!(full|opus|sonnet|medium|light|haiku|cheap)\b\s*/i.exec(e.text)
    if (m === null) return next(e)
    const word = m[1].toLowerCase()
    override = word === 'full' || word === 'opus' ? 'full' : word === 'sonnet' || word === 'medium' ? 'medium' : 'light'
    return next({ ...e, text: e.text.slice(m[0].length) })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    let decision = await Promise.resolve(decideStart(e.text, $)).catch(() => ({
      tier: 'full' as Tier,
      reason: 'triage unavailable',
    }))
    if (decision.reason !== 'forced by prefix') {
      if (decision.tier === 'medium' && settings.mode === 'safe') decision = { tier: 'full', reason: decision.reason }
      // A model whose cache is cold re-reads the whole context at full price.
      const isCacheWarm = decision.tier === lastTier && Date.now() - lastTurnAt < 270_000
      if (decision.tier !== 'full' && !isCacheWarm && lastContextTokens > settings.switchContextLimit)
        decision = { tier: 'full', reason: 'context too large to switch cheaply' }
    }
    const route: Route = { ...decision, start: decision.tier, toolErrors: 0, tierStartStep: 0, step: 0, edited: new Set() }
    routes.set(e.turnId, route)
    current = route
    lastTier = route.tier
    await bump($, route.tier)
    show($, route)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    sessionModel = e.model
    const route = routes.get(e.turnId)
    if (route !== undefined) route.step = e.index
    if (route !== undefined && route.tier !== 'full' && e.index - route.tierStartStep >= LIMITS[route.tier].steps)
      await escalate($, route, `over ${LIMITS[route.tier].steps} steps`, e.index)
    const model = route === undefined ? undefined : modelFor(route.tier, e.model)
    // Effort is passed on untouched: a cheaper model thinks as hard as asked.
    const res = yield* next(model === undefined ? e : { ...e, model })
    if (res.usage !== null)
      lastContextTokens =
        res.usage.input_tokens + res.usage.cache_read_input_tokens + res.usage.cache_creation_input_tokens
    if (route !== undefined && model !== undefined && (res.stopReason === 'max_tokens' || res.stopReason === 'refusal'))
      await escalate($, route, `stopped: ${res.stopReason}`, e.index + 1)
    return res
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const route = current
    if (route === undefined || route.tier === 'full') return next(e)
    const step = route.step + 1
    if (route.tier === 'light' && (WRITE_TOOLS.has(e.tool) || DELEGATE_TOOLS.has(e.tool))) {
      await escalate($, route, `needs ${e.tool}`, step)
      return {
        deny:
          `smart-router: this turn started on a lightweight model, which does not make ${e.tool} calls. ` +
          'A more capable model now has the turn: make this call again yourself if it is still right.',
      }
    }
    if (WRITE_TOOLS.has(e.tool)) {
      const path = (e as { file_path?: string; notebook_path?: string }).file_path ?? (e as { notebook_path?: string }).notebook_path
      if (path !== undefined) route.edited.add(path)
    }
    const ran = await next(e)
    const limits = LIMITS[route.tier]
    if (ran.deny === undefined && ran.isError === true && ++route.toolErrors >= limits.toolErrors)
      await escalate($, route, 'repeated tool errors', step)
    else if (route.edited.size > limits.files) await escalate($, route, `changes span ${route.edited.size} files`, step)
    return ran
  }).catch(($, e, next) => next(e))

  // Read-only searches that report back to the main model.
  on('agent.spawn', async ($, e, next) => {
    const tier = READ_ONLY_AGENTS[e.subagentType]
    if (isDisabledByEnv || settings.mode === 'off' || e.model !== undefined || tier === undefined) return next(e)
    const model = modelFor(tier, e.parentModel)
    if (model === undefined) return next(e)
    await bump($, 'subagents')
    return next({ ...e, model })
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      lastTurnAt = Date.now()
      const route = routes.get(e.turnId)
      lastWasCheap = route !== undefined && route.tier !== 'full'
      if (routes.size > 50) routes.delete(routes.keys().next().value as string)
    }
    return next(e)
  })
}
