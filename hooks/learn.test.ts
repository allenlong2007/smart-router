import { expect, test } from 'claude-code/testing'

import { choose, econKey, estimateCost, failRate, record, recordComplaint, recordEcon } from './learn'
import type { CacheView, Learned } from './learn'

const allCold = (context: number): CacheView => ({
  context,
  cached: { haiku: 0, sonnet: 0, opus: 0 },
  prefix: 30_000,
  prefixWarm: { haiku: false, sonnet: false, opus: false },
  demand: { haiku: 0, sonnet: 0, opus: 0 },
  returnChance: 0.6,
  band: 'short',
})

// A long session that has run on Opus: Opus holds the conversation, the
// cheaper models hold only the shared opening.
const longOnOpus = (context: number): CacheView => ({
  context,
  cached: { haiku: 0, sonnet: 0, opus: context - 2_000 },
  prefix: 30_000,
  prefixWarm: { haiku: true, sonnet: true, opus: true },
  demand: { haiku: 3, sonnet: 3, opus: 3 },
  returnChance: 0.6,
  band: 'long',
})

// The same long session after earlier Haiku turns: Haiku holds most of it too.
const longHaikuWarm = (context: number): CacheView => ({
  ...longOnOpus(context),
  cached: { haiku: context - 8_000, sonnet: 0, opus: context - 2_000 },
})

test('a fresh session sends lookups to Haiku and scoped edits to Sonnet', async () => {
  const v: CacheView = { ...allCold(35_000), prefixWarm: { haiku: true, sonnet: true, opus: true } }
  expect(choose('light', 'lookup:what', {}, v, 'opus').tier).toBe('light')
  expect(choose('medium', 'edit:add', {}, v, 'opus').tier).toBe('medium')
})

test('deep into a long Opus conversation, a turn moves to a cheaper model only if that model already holds the conversation', async () => {
  const v = longOnOpus(150_000)
  // Writing 120k tokens into Sonnet's cold cache costs more than Opus re-reading them.
  expect(estimateCost('sonnet', 4, 700, v)).toBeGreaterThan(estimateCost('opus', 4, 700, v))
  expect(choose('medium', 'edit:add', {}, v, 'opus').tier).toBe('full')
  // A cold Haiku would write the whole conversation, and Opus later rewrites what Haiku read.
  expect(choose('light', 'lookup:what', {}, v, 'opus').tier).toBe('full')
  // A Haiku that ran recently in this conversation reads it from its cache.
  expect(choose('light', 'lookup:what', {}, longHaikuWarm(150_000), 'opus').tier).toBe('light')
})

test('a kind of request that keeps escalating off Haiku starts on Sonnet', async () => {
  const v = allCold(35_000)
  let l: Learned = {}
  for (let i = 0; i < 4; i++) l = record(l, 'lookup:what', 'light', { escalated: true, cost: 0.003, steps: 2, out: 300, growth: 2000 })
  expect(failRate(l['lookup:what']?.light)).toBeGreaterThan(0.34)
  const c = choose('light', 'lookup:what', l, v, 'opus')
  expect(c.tier).toBe('medium')
  expect(c.reason).toMatch(/light fails/)
})

test('a tier passed over long enough gets one retry, so a bad patch does not lock it out', async () => {
  const v = allCold(35_000)
  let l: Learned = {}
  for (let i = 0; i < 4; i++) l = record(l, 'lookup:what', 'light', { escalated: true, cost: 0.003, steps: 2, out: 300, growth: 2000 })
  const tiers: string[] = []
  for (let i = 0; i < 8; i++) {
    const c = choose('light', 'lookup:what', l, v, 'opus')
    tiers.push(c.tier)
    l = c.learned
  }
  expect(tiers.slice(0, 7).every(t => t === 'medium')).toBe(true)
  expect(tiers[7]).toBe('light')
})

test('a clean record keeps the cheap tier, and complaints count against it more than escalations', async () => {
  const v = allCold(35_000)
  let l: Learned = {}
  for (let i = 0; i < 6; i++) l = record(l, 'edit:rename', 'medium', { escalated: false, cost: 0.05, steps: 3, out: 500, growth: 2000 })
  expect(choose('medium', 'edit:rename', l, v, 'opus').tier).toBe('medium')
  l = recordComplaint(l, 'edit:rename', 'medium')
  l = recordComplaint(l, 'edit:rename', 'medium')
  expect(choose('medium', 'edit:rename', l, v, 'opus').tier).toBe('full')
})

test('old outcomes fade: a tier that failed long ago and has run cleanly since is trusted again', async () => {
  const v = allCold(35_000)
  let l: Learned = {}
  for (let i = 0; i < 4; i++) l = record(l, 'lookup:list', 'light', { escalated: true, cost: 0.003, steps: 2, out: 300, growth: 2000 })
  for (let i = 0; i < 12; i++) l = record(l, 'lookup:list', 'light', { escalated: false, cost: 0.003, steps: 2, out: 300, growth: 2000 })
  expect(choose('light', 'lookup:list', l, v, 'opus').tier).toBe('light')
})

test('with Sonnet as the session model, a "medium" turn simply stays on the session model', async () => {
  const c = choose('medium', 'edit:add', {}, allCold(35_000), 'sonnet')
  expect(c.tier).toBe('full')
})

test('a cheap tier that measured no saving for a kind of request is not used for it at that length', async () => {
  const v = longHaikuWarm(90_000)
  let l: Learned = {}
  // Haiku cost plus the session model's rewrite came to as much as the session model alone.
  for (let i = 0; i < 3; i++) l = recordEcon(l, econKey('lookup:what', 'long'), 'light', 0.02, 0.019)
  const c = choose('light', 'lookup:what', l, v, 'opus')
  expect(c.tier).not.toBe('light')
  expect(c.reason).toMatch(/saved nothing/)
  // In a short conversation the same kind of request still goes to Haiku.
  expect(choose('light', 'lookup:what', l, allCold(35_000), 'opus').tier).toBe('light')
})

test('a cheap tier that measured real savings keeps being used', async () => {
  const v = longHaikuWarm(90_000)
  let l: Learned = {}
  for (let i = 0; i < 3; i++) l = recordEcon(l, econKey('ack', 'long'), 'light', 0.001, 0.013)
  expect(choose('light', 'ack', l, v, 'opus').tier).toBe('light')
})
