import type { EngineInterface, Register } from 'claude-code'

import {
  choose,
  econKey,
  estimateCost,
  familyOf,
  NEXT_TIER,
  PRICE,
  priceOf,
  rankOf,
  record,
  recordComplaint,
  recordEcon,
  stepCost,
  TIER_FAMILY,
} from './learn'
import type { Band, CacheView, Family, Learned, Tier } from './learn'
import { DELEGATION_GUIDANCE, pickSubagent, SUBAGENT_LIMITS, SUBAGENT_MODEL } from './delegate'

// Smart Router: each turn starts on the cheapest model that suits it (Haiku for
// lookups and one-off commands, Sonnet for ordinary scoped edits, the session
// model for everything else) and climbs a rung the moment it shows it is harder
// than it looked. Two things refine the starting point:
// - a cost estimate that counts what each model has cached, so a switch that
//   would re-read a long conversation at full price is not made;
// - a record of past turns by kind of request: a model that kept needing to be
//   escalated, or whose answers the person called wrong, stops being tried for
//   that kind of request (with an occasional retry), and the turns' measured
//   steps and output feed the estimate.

type Mode = 'balanced' | 'safe' | 'off'

type Settings = {
  // balanced: Haiku, Sonnet and the session model; safe: Haiku and the session
  // model only (Sonnet is still the first rung a Haiku turn climbs to).
  mode: Mode
  // Ask a small model to triage prompts the keyword rules can't place.
  useClassifier: boolean
  // Learn from outcomes; off, the router decides by its rules alone.
  useLearning: boolean
  // Start subagents on a cheaper model when their task allows it.
  routeSubagents: boolean
  // Tell the session model it may hand self-contained parts to subagents.
  delegate: boolean
  // low (default): Opus and Haiku steps at low effort, Sonnet at medium; lower: the
  // same but hard work keeps the session's effort; session: effort left alone.
  effort: 'lower' | 'low' | 'session'
}

type Stats = {
  light: number
  medium: number
  full: number
  lightToMedium: number
  mediumToFull: number
  lightToFull: number
  classifierCalls: number
  classifierTokens: number
  subLight: number
  subMedium: number
  subFull: number
  subUp: number
  subSpent: number
  subBaseline: number
  // Estimated USD the turns cost, and what they would have cost on the session
  // model with its cache as it stood.
  spent: number
  baseline: number
}

type Route = {
  tier: Tier
  start: Tier
  bucket: string
  reason: string
  escalated?: string
  toolErrors: number
  // Index of the step the current tier began at, and of the latest step.
  tierStartStep: number
  step: number
  edited: Set<string>
  cost: number
  out: number
  baseline: number
  band: Band
  startContext: number
}

const DEFAULTS: Settings = { mode: 'balanced', useClassifier: true, useLearning: true, routeSubagents: true, delegate: false, effort: 'low' }
const NO_STATS: Stats = {
  light: 0,
  medium: 0,
  full: 0,
  lightToMedium: 0,
  mediumToFull: 0,
  lightToFull: 0,
  classifierCalls: 0,
  classifierTokens: 0,
  subLight: 0,
  subMedium: 0,
  subFull: 0,
  subUp: 0,
  subSpent: 0,
  subBaseline: 0,
  spent: 0,
  baseline: 0,
}

const TIER_MODEL: Record<Tier, string | undefined> = { light: 'haiku', medium: 'sonnet', full: undefined }

// How much a tier may take on before it hands the turn up a rung.
const LIMITS: Record<Tier, { steps: number; toolErrors: number; files: number }> = {
  light: { steps: 6, toolErrors: 2, files: 0 },
  medium: { steps: 25, toolErrors: 3, files: 6 },
  full: { steps: Infinity, toolErrors: Infinity, files: Infinity },
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const DELEGATE_TOOLS = new Set(['Agent', 'Task'])

// A model's cache of a conversation outlives a pause of up to an hour; past
// this it is counted cold.
const CACHE_TTL_MS = 55 * 60_000
const DEFAULT_PREFIX = 30_000
// Past this many tokens held in the session model's cache, a conversation is
// "long": a cheap turn there is judged on its own measured economics.
const LONG_CONTEXT = 50_000

const COMPLEX =
  /\b(implement|refactor|architect|design|debug|investigat|diagnos|root cause|migrat|optimi[sz]|performance|secur|vulnerab|race condition|concurren|deadlock|algorithm|prove|plan|review|audit|build|scaffold|feature|integrat|deploy|why (does|is|did|do|would|isn)|what'?s wrong|what is wrong|wrong with|fail|broken|bug|crash|error|exception|stack ?trace|regression|mods?\b|plugin|schema|database|across|entire|whole|every|all (the )?files)\w*/i
const STANDARD =
  /\b(add|write|update|change|edit|tweak|adjust|convert|document|docstring|comment|rename|move|delete|remove|replace|format|lint|typo|bump|upgrade|translate|test for|unit test|readme|type hints?|log(ging)?)\b/i
const TRIVIAL =
  /^(what('s| is| are| does)|where('s| is| are)|which|who|when|show|list|print|cat|open|read|define|summari[sz]e|explain (what|this|the)|run (the )?(tests?|lint|linter|build|formatter)|git (status|log|diff|branch|show)|how (do i|to|does)|what does|is there|does (this|it|the))\b/i
// Loads whole files into the conversation. Measured: such a turn on Sonnet saved
// about $0.30, then Opus paid about $0.65 to cache-write the 60k tokens it added.
const BIG_READ = /\b(in full|full (file|files|text|source)|whole (file|files|module)|entire (file|files|module)|end to end|cover to cover|not excerpts|all of (each|it|them|the file))\b/i
const READ_VERB = /\b(read|load|go through|study|look through|skim)\b/i
const FILE_TOKEN = /\b[\w./-]+\.(py|ts|tsx|js|jsx|swift|go|rs|java|kt|rb|c|cc|cpp|h|m|md|json|ya?ml|toml)\b/gi

export function readsALot(t: string): boolean {
  if (BIG_READ.test(t)) return true
  return READ_VERB.test(t) && (t.match(FILE_TOKEN)?.length ?? 0) >= 3
}

// A read-only search or listing ("list every…", "find all…", "do not change any
// files"). Haiku matched Opus on these in the benchmark at about the same speed;
// words like "every" or "across" no longer push them to the session model.
const READ_ONLY = /\b(do not|don'?t|without) (change|chang|modify|edit|touch)\w* (any|the)? ?(files?|code)\b/i
const LISTING = /^(please )?(list|find|locate|enumerate|count|show( me)?|give me (a list|every|all|the (file|line))|where|which)\b/i
const JUDGEMENT =
  /\b(implement|refactor|architect|design|debug|investigat|diagnos|root cause|migrat|optimi[sz]|secur|vulnerab|race|concurren|deadlock|prove|plan|review|audit|why|wrong|fail|broken|bug|crash|error|exception|regression|fix|explain|how does|survey|longer than|compare|recommend|should)\w*/i

export function isReadOnlySearch(t: string): boolean {
  return LISTING.test(t.trim()) && !JUDGEMENT.test(t) && (READ_ONLY.test(t) || !STANDARD.test(t))
}

// Run a check and say what it printed; asking for a fix is not this.
const RUN_AND_REPORT =
  /^(please )?run (the )?(tests?|test suite|lint(er)?|build|type ?check)\b(?!.*\b(fix|make|change|until|then (fix|update)))/i
const CONFIRM = /^(y(es|ep|eah)?|ok(ay)?|sure|go( ahead| for it)?|do it|continue|proceed|sounds good|lgtm|ship it|approved?)[\s.!,]*$/i
const THANKS = /^(thanks?( you)?|ty|great|nice|cool|perfect|awesome|got it|👍)[\s.!]*$/i
// The person says the last answer missed: the next turns stay on the full model.
const COMPLAINT =
  /\b((that|it|this|you|the answer|your answer)('?s|'?re| is| are| was)( still| all)? (wrong|incorrect)|wrong (answer|again|file|fix)|didn'?t work|doesn'?t work|not working|still (fail|broken|wrong|not)|not what i (asked|wanted|meant)|try again|redo|that'?s not (it|right|what)|you missed|worse)/i

let settings: Settings = DEFAULTS
let isDisabledByEnv = false
let override: Tier | undefined
let sessionModel: string | undefined
let lastTier: Tier = 'full'
let lastBucket = 'none'
let lastTurn: { bucket: string; start: Tier } | undefined
let stickyFullTurns = 0
let lastContextTokens = 0
let isFirstStep = true
let current: Route | undefined
// A finished cheap turn waiting to learn what it really cost: the session
// model's rewrite of its tokens shows on the next turn's first request.
let pendingEcon: { key: string; tier: Tier; cost: number; baseline: number } | undefined
// What the session model's cache would hold had it run every step, for the
// baseline a cheap step is measured against.
let shadow: { tokens: number; at: number } | undefined
const routes = new Map<string, Route>()
// Subagents started below the session model: their rung, the parent's model,
// how they are doing, and what they cost against the parent's price.
type Sub = { tier: Tier; parentModel: string; toolErrors: number; steps: number; cost: number; baseline: number }
const subs = new Map<string, Sub>()
// Tokens of this conversation each model has cached, and when it last ran.
const sessionCache: Record<Family, { tokens: number; at: number }> = {
  haiku: { tokens: 0, at: 0 },
  sonnet: { tokens: 0, at: 0 },
  opus: { tokens: 0, at: 0 },
}

// What a session needs to route its next turn well, kept in the store under
// the session's id, so a resumed session (or a restarted process) carries on.
type SessionState = {
  sessionCache: Record<Family, { tokens: number; at: number }>
  lastContextTokens: number
  lastTier: Tier
  lastBucket: string
  lastTurn?: { bucket: string; start: Tier }
  stickyFullTurns: number
  pendingEcon?: { key: string; tier: Tier; cost: number; baseline: number }
  shadow?: { tokens: number; at: number }
  at: number
}
let sessionKey: string | undefined

async function loadSession($: EngineInterface) {
  try {
    sessionKey = `session:${await $.session.id()}`
  } catch {
    return
  }
  const s = (await $.store.get(sessionKey)) as SessionState | undefined
  if (s === undefined) return
  Object.assign(sessionCache, s.sessionCache)
  lastContextTokens = s.lastContextTokens
  lastTier = s.lastTier
  lastBucket = s.lastBucket
  lastTurn = s.lastTurn
  stickyFullTurns = s.stickyFullTurns
  pendingEcon = s.pendingEcon
  shadow = s.shadow
  isFirstStep = false
}

async function saveSession($: EngineInterface) {
  if (sessionKey === undefined) return
  const state: SessionState = { sessionCache, lastContextTokens, lastTier, lastBucket, lastTurn, stickyFullTurns, pendingEcon, shadow, at: Date.now() }
  await $.store.set(sessionKey, state)
  // Keep the 30 most recent sessions.
  const index = ((await $.store.get('sessions')) as string[] | undefined) ?? []
  const next = [...index.filter(k => k !== sessionKey), sessionKey]
  for (const old of next.slice(0, -30)) await $.store.delete(old)
  await $.store.set('sessions', next.slice(-30))
}

// The model a tier asks for, or undefined where the session's own model is
// already no more expensive.
function modelFor(tier: Tier, current: string): string | undefined {
  const target = TIER_MODEL[tier]
  return target !== undefined && rankOf(familyOf(target)) < rankOf(familyOf(current)) ? target : undefined
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
// Turns that keep the session's effort under 'lower': hard or unclear work.
const KEEP_EFFORT = /^(complex|long|triage:complex|complaint|continuation|unclassified|forced|off)$/

// The effort a step runs at: only ever lowered. Benchmark: Opus and Haiku at
// low matched medium and high on every task; Sonnet at low missed a feature
// twice, so Sonnet never goes below medium.
export function effortFor(route: { tier: Tier; bucket: string }, model: string, current: unknown): string | undefined {
  if (settings.effort === 'session') return undefined
  if (settings.effort === 'lower' && route.tier === 'full' && KEEP_EFFORT.test(route.bucket)) return undefined
  const floor = familyOf(model) === 'sonnet' ? 'medium' : 'low'
  const at = typeof current === 'string' ? LEVELS.indexOf(current) : current === undefined ? LEVELS.indexOf('medium') : -1
  if (at < 0 || at <= LEVELS.indexOf(floor)) return undefined
  return floor
}

function fullFamily(): Family {
  return familyOf(sessionModel ?? 'opus')
}

function familyOfTier(tier: Tier): Family {
  return tier === 'full' ? fullFamily() : TIER_FAMILY[tier]
}

type Decision = { tier: Tier; bucket: string; reason: string; band?: Band }

function keyword(re: RegExp, t: string): string {
  return (re.exec(t)?.[1] ?? '').toLowerCase().split(/\s+/)[0]
}

function heuristic(text: string): Decision | undefined {
  const t = text.trim()
  if (t === '') return { tier: 'full', bucket: 'continuation', reason: 'continuation' }
  if (CONFIRM.test(t)) return { tier: lastTier, bucket: lastBucket, reason: 'confirmation, same tier as before' }
  if (THANKS.test(t)) return { tier: 'light', bucket: 'ack', reason: 'acknowledgement' }
  if (t.includes('```') || t.length > 500 || t.split('\n').length > 4)
    return { tier: 'full', bucket: 'long', reason: 'long or code-bearing prompt' }
  // The session model would pay to cache-write it all on its next turn.
  if (readsALot(t)) return { tier: 'full', bucket: 'big-read', reason: 'loads whole files into the conversation' }
  if (t.length <= 400 && isReadOnlySearch(t)) return { tier: 'light', bucket: 'lookup:search', reason: 'read-only search' }
  if (t.length <= 200 && RUN_AND_REPORT.test(t)) return { tier: 'light', bucket: 'run-report', reason: 'run and report' }
  if (COMPLEX.test(t)) return { tier: 'full', bucket: 'complex', reason: 'complex task keywords' }
  if (t.length <= 300 && STANDARD.test(t))
    return { tier: 'medium', bucket: `edit:${keyword(STANDARD, t)}`, reason: 'scoped edit' }
  if (t.length <= 200 && TRIVIAL.test(t))
    return { tier: 'light', bucket: `lookup:${keyword(TRIVIAL, t)}`, reason: 'simple lookup or command' }
  return undefined
}

const TRIAGE_SYSTEM =
  'You triage requests sent to a coding assistant by how capable a model they need. Answer with one word.\n' +
  'trivial: a lookup, a short factual answer, or one read-only command; no code is written.\n' +
  'standard: a scoped, well-specified change or explanation: a small edit, a docstring, a simple test, a rename.\n' +
  'complex: design, debugging, ambiguous goals, multi-file or subtle changes, anything where a mistake is costly.\n' +
  'When unsure between two, answer the harder one.'

async function triage($: EngineInterface, text: string): Promise<Decision> {
  if (!settings.useClassifier) return { tier: 'full', bucket: 'unclassified', reason: 'unclassified' }
  const r = await $.model.complete({
    model: 'haiku',
    system: TRIAGE_SYSTEM,
    prompt: `Request:\n${text.slice(0, 2000)}\n\nAnswer trivial, standard or complex.`,
    maxTokens: 5,
    timeoutMs: 8000,
  })
  await bump($, { classifierCalls: 1, classifierTokens: r.usage.input_tokens + r.usage.output_tokens })
  const label = r.isAnswered ? r.text.trim().toLowerCase() : ''
  if (label.startsWith('trivial')) return { tier: 'light', bucket: 'triage:trivial', reason: 'triaged trivial' }
  if (label.startsWith('standard')) return { tier: 'medium', bucket: 'triage:standard', reason: 'triaged standard' }
  return { tier: 'full', bucket: 'triage:complex', reason: `triaged ${label || 'unclear'}` }
}

async function bump($: EngineInterface, by: Partial<Stats>) {
  const stats = { ...NO_STATS, ...((await $.store.get('stats')) as Partial<Stats> | undefined) }
  for (const [k, v] of Object.entries(by)) stats[k as keyof Stats] += v ?? 0
  await $.store.set('stats', stats)
}

async function getLearned($: EngineInterface): Promise<Learned> {
  return ((await $.store.get('learned')) as Learned | undefined) ?? {}
}

// What each model holds cached as a turn begins, from this session's steps
// and, for the shared opening, from recent sessions.
async function cacheView($: EngineInterface, text: string): Promise<CacheView> {
  const now = Date.now()
  const prefix = Number((await $.store.get('prefix')) ?? DEFAULT_PREFIX)
  const fullShare = Number((await $.store.get('fullShare')) ?? 0.6)
  const fams: Family[] = ['haiku', 'sonnet', 'opus']
  const pick = <T>(f: (fam: Family) => T) => Object.fromEntries(fams.map(fam => [fam, f(fam)])) as Record<Family, T>
  const cached = pick(fam => (now - sessionCache[fam].at < CACHE_TTL_MS ? sessionCache[fam].tokens : 0))
  const context = (lastContextTokens > 0 ? lastContextTokens : prefix) + Math.ceil(text.length / 4)
  return {
    context,
    cached,
    prefix,
    // Measured fresh sessions on every model read the shared opening from cache
    // (it is the same for every session of the account), so it is counted
    // warm; what a cheap turn really cost is learned and corrects this.
    prefixWarm: pick(() => true),
    demand: pick(() => 1),
    returnChance: fullShare,
    band: context > LONG_CONTEXT && cached[fullFamily()] > 0 ? 'long' : 'short',
  }
}

function show($: EngineInterface, route: Route) {
  const model = TIER_MODEL[route.tier]
  if (route.escalated !== undefined)
    $.ui.status(`route: ${model ?? sessionModel ?? 'session model'} (up from ${route.start}: ${route.escalated})`)
  else $.ui.status(model === undefined ? undefined : `route: ${model} (${route.reason})`)
}

// Hands the turn up: to the next rung, or past it to the session model where
// the next rung's cold cache would make it the dearer of the two.
async function escalate($: EngineInterface, route: Route, why: string, atStep: number) {
  if (route.tier === 'full') return
  const from = route.tier
  let to = NEXT_TIER[from]
  if (to === 'medium') {
    const v = await cacheView($, '')
    v.context = lastContextTokens > 0 ? lastContextTokens : v.context
    const remaining = 4
    if (estimateCost('sonnet', remaining, 700, v) >= estimateCost(fullFamily(), remaining, 700, v) * 0.9) to = 'full'
  }
  route.tier = to
  route.escalated = why
  route.toolErrors = 0
  route.tierStartStep = atStep
  lastTier = route.tier
  show($, route)
  await bump($, from === 'medium' ? { mediumToFull: 1 } : to === 'medium' ? { lightToMedium: 1 } : { lightToFull: 1 })
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

async function decide($: EngineInterface, text: string): Promise<Decision> {
  // A complaint about a cheap turn, or forcing a dearer model right after
  // one, is a mistake the record keeps against that kind of request.
  const forcedUp = override !== undefined && override !== 'light'
  if (lastTurn !== undefined && lastTurn.start !== 'full' && (COMPLAINT.test(text) || forcedUp)) {
    await $.store.set('learned', recordComplaint(await getLearned($), lastTurn.bucket, lastTurn.start))
    if (COMPLAINT.test(text)) stickyFullTurns = 2
  }
  if (override !== undefined) {
    const forced = { tier: override, bucket: 'forced', reason: 'forced by prefix' }
    override = undefined
    return forced
  }
  if (isDisabledByEnv || settings.mode === 'off') return { tier: 'full', bucket: 'off', reason: 'router off' }
  if (lastTurn !== undefined && lastTurn.start !== 'full' && COMPLAINT.test(text))
    return { tier: 'full', bucket: 'complaint', reason: 'last answer missed' }
  if (stickyFullTurns > 0) {
    stickyFullTurns -= 1
    return { tier: 'full', bucket: 'complaint', reason: 'recent answer missed' }
  }
  const d = heuristic(text) ?? (await triage($, text))
  if (d.tier === 'medium' && settings.mode === 'safe') return { ...d, tier: 'full' }
  if (d.tier === 'full') return d

  const allowed: Tier = settings.mode === 'safe' && d.tier === 'light' ? 'light' : d.tier
  const v = await cacheView($, text)
  const learned = settings.useLearning ? await getLearned($) : {}
  const c = choose(allowed, d.bucket, learned, v, fullFamily())
  if (settings.useLearning && c.learned !== learned) await $.store.set('learned', c.learned)
  const tier = settings.mode === 'safe' && c.tier === 'medium' ? 'full' : c.tier
  return { tier, bucket: d.bucket, band: v.band, reason: c.reason === '' ? d.reason : `${d.reason}; ${c.reason}` }
}

// A cheap subagent that stumbles is handed up one rung, Sonnet then the
// parent's model, for the rest of its run.
function subUp($: EngineInterface, sub: Sub) {
  sub.tier = sub.tier === 'light' ? 'medium' : 'full'
  sub.toolErrors = 0
  void bump($, { subUp: 1 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    await loadSession($)
    try {
      sessionModel = await $.session.model()
    } catch {}
    await $.command.register({
      name: 'route',
      description: 'Smart Router: status | learned | balanced | safe | off | classifier|learning|subagents|delegate on|off | forget | reset',
      argumentHint: 'status | learned | balanced | safe | off | classifier|learning|subagents|delegate on|off | forget | reset',
    })
    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const [cmd = 'status', arg] = e.args.trim().toLowerCase().split(/\s+/)
    if (cmd === 'balanced' || cmd === 'safe' || cmd === 'off') {
      await saveSettings($, { mode: cmd })
      return { text: `Smart Router mode: ${cmd}.` }
    }
    if ((cmd === 'classifier' || cmd === 'learning') && (arg === 'on' || arg === 'off')) {
      await saveSettings($, cmd === 'classifier' ? { useClassifier: arg === 'on' } : { useLearning: arg === 'on' })
      return { text: `Smart Router ${cmd} ${arg}.` }
    }
    if (cmd === 'effort' && (arg === 'lower' || arg === 'low' || arg === 'session')) {
      await saveSettings($, { effort: arg })
      return { text: `Smart Router effort ${arg}.` }
    }
    if ((cmd === 'subagents' || cmd === 'delegate') && (arg === 'on' || arg === 'off')) {
      await saveSettings($, cmd === 'subagents' ? { routeSubagents: arg === 'on' } : { delegate: arg === 'on' })
      return { text: `Smart Router ${cmd} ${arg}${cmd === 'delegate' ? ' (from the next session)' : ''}.` }
    }
    if (cmd === 'reset') {
      await $.store.set('stats', NO_STATS)
      return { text: 'Smart Router stats reset.' }
    }
    if (cmd === 'forget') {
      await $.store.set('learned', {})
      return { text: 'Smart Router forgot what it learned.' }
    }
    if (cmd === 'learned') {
      const learned = await getLearned($)
      const lines = Object.entries(learned).flatMap(([bucket, tiers]) =>
        Object.entries(tiers ?? {}).map(([tier, s]) =>
          s === undefined || s.n < 0.5
            ? ''
            : `${bucket.padEnd(18)} ${tier.padEnd(6)} turns ${s.n.toFixed(1).padStart(5)}  failed ${Math.round((100 * s.fails) / Math.max(1, s.n))}%  complaints ${s.complaints.toFixed(1)}  avg $${(s.cost / s.n).toFixed(4)}  steps ${(s.steps / s.n).toFixed(1)}`,
        ),
      )
      const shown = lines.filter(l => l !== '')
      return { text: shown.length === 0 ? 'Nothing learned yet.' : ['Kind of request   tier   (recent turns weigh most)', ...shown].join('\n') }
    }
    const s = { ...NO_STATS, ...((await $.store.get('stats')) as Partial<Stats> | undefined) }
    const saved = s.baseline > 0 ? Math.round(100 * (1 - s.spent / s.baseline)) : 0
    return {
      text: [
        `Smart Router — mode ${isDisabledByEnv ? 'off (SMART_ROUTER=off)' : settings.mode}, classifier ${settings.useClassifier ? 'on' : 'off'}, learning ${settings.useLearning ? 'on' : 'off'}`,
        `Session model: ${sessionModel ?? '(not seen yet)'}; last turn ended on: ${lastTier}`,
        `Turns started on — Haiku ${s.light}, Sonnet ${s.medium}, session model ${s.full}`,
        `Escalations — Haiku→Sonnet ${s.lightToMedium}, Haiku→session ${s.lightToFull}, Sonnet→session ${s.mediumToFull}`,
        `Estimated spend $${s.spent.toFixed(2)} vs $${s.baseline.toFixed(2)} all on the session model (${saved}% saved)`,
        `Triage calls: ${s.classifierCalls} (${s.classifierTokens} Haiku tokens)`,
        `Subagents ${settings.routeSubagents ? 'routed' : 'not routed'}, delegation guidance ${settings.delegate ? 'on' : 'off'}: started on Haiku ${s.subLight}, Sonnet ${s.subMedium}, session model ${s.subFull}; handed up ${s.subUp}`,
        `Subagent spend $${s.subSpent.toFixed(2)} vs $${s.subBaseline.toFixed(2)} on the session model (${s.subBaseline > 0 ? Math.round(100 * (1 - s.subSpent / s.subBaseline)) : 0}% saved)`,
        'Prefix a prompt with !full, !sonnet or !light to pick the starting tier. /route learned shows what it learned.',
      ].join('\n'),
    }
  })

  // A subagent starts with an empty context, so a cheaper model costs it no
  // cache: self-contained reading or a decided change runs on Haiku or Sonnet,
  // judgement stays on the session model.
  // `next` runs exactly once: a failure in the router's own bookkeeping must
  // never start the subagent a second time.
  on('agent.spawn', async ($, e, next) => {
    let pick: { tier: Tier; model?: string } | undefined
    try {
      if (!(isDisabledByEnv || settings.mode === 'off' || !settings.routeSubagents || e.resume !== undefined)) {
        const c = pickSubagent(e)
        const tier = settings.mode === 'safe' && c.tier === 'medium' ? 'full' : c.tier
        pick = { tier, model: tier === c.tier ? c.model : undefined }
      }
    } catch {
      pick = undefined
    }
    const res = await next(pick?.model === undefined ? e : { ...e, model: pick.model })
    if (pick === undefined) return res
    try {
      const id = (res as { agentId?: string }).agentId
      await bump($, pick.tier === 'light' ? { subLight: 1 } : pick.tier === 'medium' ? { subMedium: 1 } : { subFull: 1 })
      if (id !== undefined && pick.tier !== 'full')
        subs.set(id, { tier: pick.tier, parentModel: e.parentModel, toolErrors: 0, steps: 0, cost: 0, baseline: 0 })
      if (subs.size > 100) subs.delete(subs.keys().next().value as string)
    } catch {
      // stats only; the subagent is already running
    }
    return res
  })

  // Opt-in (`/route delegate on`): tell the main loop it may split a task.
  // Off by default: on the benchmark the nudge added cost and pushing harder
  // made Opus 5.5 pay for briefing and re-checking on top of the subagent.
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e)
    if (isDisabledByEnv || settings.mode === 'off' || !settings.delegate || !settings.routeSubagents) return res
    if (!e.tools.includes('Agent') || !/opus/i.test(e.model)) return res
    return { sections: [...res.sections, { id: 'smart-router:delegation', text: DELEGATION_GUIDANCE, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

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
    const decision = await decide($, e.text).catch(
      (): Decision => ({ tier: 'full', bucket: 'error', reason: 'routing unavailable' }),
    )
    const route: Route = {
      ...decision,
      start: decision.tier,
      toolErrors: 0,
      tierStartStep: 0,
      step: 0,
      edited: new Set(),
      cost: 0,
      out: 0,
      baseline: 0,
      band: decision.band ?? 'short',
      startContext: lastContextTokens,
    }
    routes.set(e.turnId, route)
    const share = Number((await $.store.get('fullShare')) ?? 0.6)
    await $.store.set('fullShare', share * 0.9 + (route.tier === 'full' ? 0.1 : 0))
    current = route
    lastTier = route.tier
    lastBucket = route.bucket
    await bump($, { [route.tier]: 1 })
    show($, route)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const sub = subs.get(e.agentId)
      if (sub === undefined) return yield* next(e)
      sub.steps += 1
      if (sub.tier !== 'full' && sub.steps > SUBAGENT_LIMITS[sub.tier].steps) subUp($, sub)
      const model = sub.tier === 'full' ? sub.parentModel : SUBAGENT_MODEL[sub.tier]
      const res = yield* next(model === e.model ? e : { ...e, model })
      if (res.usage !== null) {
        const u = res.usage
        sub.cost += stepCost(u.model || model, u)
        sub.baseline += stepCost(sub.parentModel, u)
      }
      if (sub.tier !== 'full' && (res.stopReason === 'max_tokens' || res.stopReason === 'refusal')) subUp($, sub)
      return res
    }
    sessionModel = e.model
    const route = routes.get(e.turnId)
    if (route !== undefined) route.step = e.index
    if (route !== undefined && route.tier !== 'full' && e.index - route.tierStartStep >= LIMITS[route.tier].steps)
      await escalate($, route, `over ${LIMITS[route.tier].steps} steps`, e.index)
    const model = route === undefined ? undefined : modelFor(route.tier, e.model)
    const effort = route === undefined ? undefined : effortFor(route, model ?? e.model, e.effort)
    const res = yield* next(model === undefined && effort === undefined ? e : { ...e, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
    if (res.usage !== null) {
      const u = res.usage
      const context = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const fam = familyOf(u.model || model || e.model)
      const now = Date.now()
      if (isFirstStep && u.cache_read_input_tokens > 1000) {
        const prior = Number((await $.store.get('prefix')) ?? u.cache_read_input_tokens)
        await $.store.set('prefix', Math.round(prior * 0.7 + u.cache_read_input_tokens * 0.3))
      }
      isFirstStep = false
      // What the session model would have paid for this step had it run every
      // step: `shadow` is what its cache would hold; past that it writes.
      const full = familyOf(e.model)
      if (shadow === undefined || now - shadow.at >= CACHE_TTL_MS)
        shadow = { tokens: Math.min(context, Number((await $.store.get('prefix')) ?? DEFAULT_PREFIX)), at: now }
      const fullCached = Math.min(shadow.tokens, context)
      const p = PRICE[full]
      const baseline =
        fam === full ? null : fullCached * p.read + (context - fullCached) * p.write + u.output_tokens * p.output
      shadow = { tokens: context + u.output_tokens, at: now }
      const cost = stepCost(u.model || model || e.model, u)
      sessionCache[fam] = { tokens: context + u.output_tokens, at: now }
      lastContextTokens = context + u.output_tokens
      if (route !== undefined) {
        route.cost += cost
        route.out += u.output_tokens
        route.baseline += baseline ?? cost
      }
      if (pendingEcon !== undefined && e.index === 0) {
        // Writes beyond the new prompt are the earlier cheap turn's tokens.
        const extra = fam === full ? Math.max(0, u.cache_creation_input_tokens - 1500) * PRICE[full].write : 0
        const pe = pendingEcon
        pendingEcon = undefined
        if (settings.useLearning)
          await $.store.set('learned', recordEcon(await getLearned($), pe.key, pe.tier, pe.cost + extra, pe.baseline))
      }
    }
    if (route !== undefined && model !== undefined && (res.stopReason === 'max_tokens' || res.stopReason === 'refusal'))
      await escalate($, route, `stopped: ${res.stopReason}`, e.index + 1)
    return res
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const sub = subs.get(e.agentId)
      const ran = await next(e)
      if (sub !== undefined && sub.tier !== 'full' && ran.deny === undefined && ran.isError === true)
        if (++sub.toolErrors >= SUBAGENT_LIMITS[sub.tier].toolErrors) subUp($, sub)
      return ran
    }
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

  on('turn.complete', async ($, e, next) => {
    const sub = e.agentId === undefined ? undefined : subs.get(e.agentId)
    if (sub !== undefined && e.agentId !== undefined) {
      await bump($, { subSpent: sub.cost, subBaseline: sub.baseline })
      subs.delete(e.agentId)
    }
    if (e.agentId === undefined) {
      const route = routes.get(e.turnId)
      if (route !== undefined) {
        lastTurn = { bucket: route.bucket, start: route.start }
        await bump($, { spent: route.cost, baseline: route.baseline })
        if (settings.useLearning && !['forced', 'off', 'error', 'complaint'].includes(route.bucket))
          await $.store.set(
            'learned',
            record(await getLearned($), route.bucket, route.start, {
              escalated: route.escalated !== undefined,
              cost: route.cost,
              steps: route.step + 1,
              out: route.out,
              growth: Math.max(0, lastContextTokens - route.startContext),
            }),
          )
        pendingEcon =
          route.start !== 'full' && route.escalated === undefined && route.baseline > 0
            ? { key: econKey(route.bucket, route.band), tier: route.start, cost: route.cost, baseline: route.baseline }
            : undefined
      }
      if (routes.size > 50) routes.delete(routes.keys().next().value as string)
      await saveSession($)
    }
    return next(e)
  })
}

