// The router's judgement: what a turn would cost on each model, and what past
// turns taught about which model a kind of request needs. Pure functions over
// plain data, so the hooks module stores it and the tests drive it.

export type Tier = 'light' | 'medium' | 'full'
export type Family = 'haiku' | 'sonnet' | 'opus'

// USD per token, as the API billed this build's models (fresh input, output,
// cache read, cache write). Only the ratios matter to a decision.
export const PRICE: Record<Family, { input: number; output: number; read: number; write: number }> = {
  haiku: { input: 0.1e-6, output: 0.5e-6, read: 0.01e-6, write: 0.2e-6 },
  sonnet: { input: 2e-6, output: 10e-6, read: 0.1e-6, write: 4e-6 },
  opus: { input: 4e-6, output: 20e-6, read: 0.2e-6, write: 8e-6 },
}

export const TIER_FAMILY: Record<Exclude<Tier, 'full'>, Family> = { light: 'haiku', medium: 'sonnet' }
export const NEXT_TIER: Record<Tier, Tier> = { light: 'medium', medium: 'full', full: 'full' }

// What a turn is assumed to take before the router has seen that kind of
// turn, by the kind of request (the tier the rules allow) and the model
// running it: the session model answers a lookup from what it already read,
// where a cheaper model newly arrived in the conversation reads files again.
// Measured on this build: lookups take about 2 requests on Haiku; scoped
// edits about 6 on Sonnet and 7 on Opus, at roughly 200 output tokens each.
const DEFAULT_STEPS: Record<Tier, Record<Tier, number>> = {
  light: { light: 2.2, medium: 2.2, full: 1.5 },
  medium: { light: 6, medium: 6, full: 7 },
  full: { light: 8, medium: 8, full: 9 },
}
const DEFAULT_OUTPUT: Record<Tier, number> = { light: 150, medium: 200, full: 240 }
// Tokens a request after the first adds to the context besides the reply
// (tool calls and their results), as measured.
const STEP_GROWTH = 600
// A cheaper model must beat the session model's estimate by this factor. Deep
// into a conversation the session model holds in its cache, measured turns
// saved far less than estimated, so the bar is higher there.
const MARGIN = { short: 0.9, long: 0.5 }
// Measured cost over what the session model would have paid, above which a
// cheaper tier is not used for that kind of request at that conversation length.
const MAX_COST_RATIO = 0.9

// Each new outcome weighs this much more than the one before it, so the
// router follows how a kind of request behaves now, not months ago.
const DECAY = 0.93
// Learned failure rate above which a tier is not tried for that kind of request.
const MAX_FAIL_RATE = 0.34
const MAX_COMPLAINT_RATE = 0.15
// After this many turns of being passed over, a tier gets one more try, so a
// kind of request is not locked out by a bad patch.
const RETRY_AFTER = 8
// Decayed turn count a record needs before it rules anything: about three
// recent turns (three in a row decay to 2.79).
const MIN_EVIDENCE = 2.5

export type TierStats = {
  // Decayed counts: turns, failures (escalations, plus complaints twice over),
  // complaints, and sums of cost, steps and output tokens.
  n: number
  fails: number
  complaints: number
  cost: number
  steps: number
  out: number
  // Tokens the turns added to the conversation, and (economics records) what
  // the session model would have paid for them.
  growth: number
  baseline: number
  // Turns this tier was passed over since it last ran.
  skipped: number
}
export type Learned = Record<string, Partial<Record<Tier, TierStats>>>

export type Outcome = { escalated: boolean; cost: number; steps: number; out: number; growth: number }

const EMPTY: TierStats = { n: 0, fails: 0, complaints: 0, cost: 0, steps: 0, out: 0, growth: 0, baseline: 0, skipped: 0 }

function decayed(s: TierStats | undefined): TierStats {
  const b = s ?? EMPTY
  return {
    n: b.n * DECAY,
    fails: b.fails * DECAY,
    complaints: b.complaints * DECAY,
    cost: b.cost * DECAY,
    steps: b.steps * DECAY,
    out: b.out * DECAY,
    growth: b.growth * DECAY,
    baseline: b.baseline * DECAY,
    skipped: 0,
  }
}

export function record(l: Learned, bucket: string, tier: Tier, o: Outcome): Learned {
  const s = decayed(l[bucket]?.[tier])
  const next: TierStats = {
    ...s,
    n: s.n + 1,
    fails: s.fails + (o.escalated ? 1 : 0),
    cost: s.cost + o.cost,
    steps: s.steps + o.steps,
    out: s.out + o.out,
    growth: s.growth + o.growth,
  }
  return { ...l, [bucket]: { ...l[bucket], [tier]: next } }
}

export type Band = 'short' | 'long'

// The key the economics of a kind of request are kept under: what a cheap
// turn saves depends on how much of the conversation the session model holds.
export function econKey(bucket: string, band: Band): string {
  return `${bucket}@${band}`
}

// What a cheap turn cost, the session model's later rewrite of its tokens
// included, against what the session model would have paid for the turn.
export function recordEcon(l: Learned, key: string, tier: Tier, cost: number, baseline: number): Learned {
  const s = decayed(l[key]?.[tier])
  return { ...l, [key]: { ...l[key], [tier]: { ...s, n: s.n + 1, cost: s.cost + cost, baseline: s.baseline + baseline } } }
}

export function costRatio(s: TierStats | undefined): number | undefined {
  return s === undefined || s.n < MIN_EVIDENCE || s.baseline <= 0 ? undefined : s.cost / s.baseline
}

// The person said the answer of a turn that started on `tier` was wrong.
export function recordComplaint(l: Learned, bucket: string, tier: Tier): Learned {
  const s = l[bucket]?.[tier] ?? { ...EMPTY, n: 1 }
  return { ...l, [bucket]: { ...l[bucket], [tier]: { ...s, fails: s.fails + 2, complaints: s.complaints + 1 } } }
}

// Failure rate with a small optimistic prior, so one early slip does not ban
// a tier and a clean record still needs a few turns to count.
export function failRate(s: TierStats | undefined): number {
  return s === undefined ? 0.1 : (s.fails + 0.2) / (s.n + 2)
}

function complaintRate(s: TierStats | undefined): number {
  return s === undefined ? 0 : s.complaints / (s.n + 2)
}

// What the caches hold when a turn begins.
export type CacheView = {
  // Tokens the turn's first request will carry.
  context: number
  // Tokens of this conversation each model still has cached (0: cold or stale).
  cached: Record<Family, number>
  // The shared opening (system prompt, tools) every session sends, and
  // whether each model has it cached from a recent session.
  prefix: number
  prefixWarm: Record<Family, boolean>
  // Turns in the last hour that could use each model: a cold opening written
  // now is read back by about that many turns, so its cost is shared by them.
  demand: Record<Family, number>
  // How likely the next turn is on the session model, which then writes this
  // turn's tokens into its own cache.
  returnChance: number
  band: Band
}

// Estimated USD a turn of `steps` requests and `out` output tokens per
// request costs on `family`, given what that model has cached.
export function growthOf(steps: number, out: number): number {
  return Math.max(0, steps - 1) * STEP_GROWTH + steps * out
}

export function estimateCost(family: Family, steps: number, out: number, v: CacheView, growth = growthOf(steps, out)): number {
  const p = PRICE[family]
  let cached = v.cached[family]
  if (cached === 0 && v.prefixWarm[family]) cached = Math.min(v.prefix, v.context)
  const uncached = Math.max(0, v.context - cached)
  const coldPrefix = cached === 0 ? Math.min(v.prefix, uncached) : 0
  const written = uncached - coldPrefix + coldPrefix / Math.max(1, Math.min(5, v.demand[family]))
  return written * p.write + steps * v.context * p.read + growth * p.write + steps * out * p.output
}

export type Choice = { tier: Tier; reason: string; estimates: Partial<Record<Tier, number>>; learned: Learned }

// Picks the tier a turn starts on: the cheapest expected cost among the tiers
// at or above `allowed` that the learned record does not rule out. A tier's
// expected cost counts its chance of failing, which pays for the next tier too.
export function choose(
  allowed: Tier,
  bucket: string,
  learned: Learned,
  v: CacheView,
  full: Family,
): Choice {
  const order: Tier[] = allowed === 'light' ? ['light', 'medium', 'full'] : allowed === 'medium' ? ['medium', 'full'] : ['full']
  // A tier whose model is no cheaper than the session's is the session model.
  const tiers = order.filter(t => t === 'full' || rankOf(TIER_FAMILY[t]) < rankOf(full))
  const stats = learned[bucket] ?? {}
  let l = learned
  const expected: Partial<Record<Tier, number>> = {}
  const notes: string[] = []
  let best: Tier = 'full'

  const ekey = econKey(bucket, v.band)
  for (const t of [...tiers].reverse()) {
    const s = stats[t]
    const known = s !== undefined && s.n >= 2
    const steps = known ? s.steps / s.n : DEFAULT_STEPS[allowed][t]
    const out = known ? s.out / s.n / Math.max(1, steps) : DEFAULT_OUTPUT[t]
    const growth = known ? s.growth / s.n : growthOf(steps, out)
    if (t === 'full') {
      expected.full = estimateCost(full, steps, out, v, growth)
      continue
    }
    const fam = TIER_FAMILY[t]
    // The session model writes this turn's tokens when it next runs.
    const own = estimateCost(fam, steps, out, v, growth) + v.returnChance * growth * PRICE[full].write
    // An escalation goes to the next rung or, where that is dearer, straight to the session model.
    const above = Math.min(expected[NEXT_TIER[t]] ?? Infinity, expected.full ?? Infinity)
    const fr = failRate(s)
    const isUnreliable = s !== undefined && s.n >= MIN_EVIDENCE && (fr > MAX_FAIL_RATE || complaintRate(s) > MAX_COMPLAINT_RATE)
    const econ = l[ekey]?.[t]
    const ratio = costRatio(econ)
    const isUneconomic = ratio !== undefined && ratio > MAX_COST_RATIO
    if (isUnreliable || isUneconomic) {
      // Passed-over counts live on the record that ruled the tier out.
      const key = isUnreliable ? bucket : ekey
      const rec = (isUnreliable ? s : econ)!
      if (rec.skipped + 1 < RETRY_AFTER) {
        l = { ...l, [key]: { ...l[key], [t]: { ...rec, skipped: rec.skipped + 1 } } }
        notes.push(isUnreliable ? `${t} fails ${Math.round(fr * 100)}% here` : `${t} saved nothing here (${Math.round(ratio! * 100)}% of the cost)`)
        continue
      }
      notes.push(`retrying ${t}`)
    }
    expected[t] = own + fr * above
  }
  for (const t of tiers) if (expected[t] !== undefined && expected[t]! <= (expected[best] ?? Infinity)) best = t
  // Where the record ruled out the tier the rules allow, the next rung up
  // (Sonnet) is tried before the session model while it costs within 10% of it.
  const rung = tiers.find(t => t !== 'full' && t !== allowed && expected[t] !== undefined)
  if (rung !== undefined && expected[allowed] === undefined && expected[rung]! <= (expected.full ?? Infinity) * 1.1) best = rung
  // Near-ties on the tier the rules allow go to the more capable model.
  const margin = MARGIN[v.band]
  if (best === allowed && best !== 'full' && expected.full !== undefined && expected[best]! > expected.full * margin) {
    notes.push(`${best} would save under ${Math.round((1 - margin) * 100)}%`)
    best = 'full'
  }
  return { tier: best, reason: notes.join('; '), estimates: expected, learned: l }
}

export function rankOf(f: Family): number {
  return f === 'haiku' ? 1 : f === 'sonnet' ? 2 : 3
}

export function familyOf(model: string): Family {
  const m = model.toLowerCase()
  return m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : 'opus'
}

export function stepCost(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): number {
  const p = PRICE[familyOf(model)]
  return u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.read + u.cache_creation_input_tokens * p.write
}
