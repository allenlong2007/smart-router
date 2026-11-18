// Subagents: which model a subagent the session model starts should run on.
// A subagent starts with an empty context, so a cheaper model pays no cache
// penalty there: the main conversation stays on the session model, and only
// the self-contained piece handed off runs cheaper. Pure functions, so the
// hooks module calls them and the tests drive them.

import { familyOf, rankOf } from './learn'
import type { Tier } from './learn'

export type SubagentChoice = { tier: Tier; model?: string; reason: string }

// Agent types that only search and read: a lookup job.
const READ_ONLY_TYPES = /^(explore|claude-code-guide|web-fetch|statusline-setup)$/i
// Agent types whose whole job is judgement: they keep the session model.
const JUDGEMENT_TYPES = /(plan|review|architect|security|analy[sz]er|hunter|resolver|tdd|guide-|explorer$)/i
// A handed-off task that needs judgement, whatever type runs it.
const HARD =
  /\b(design|architect|debug|root cause|diagnos|fix(es|ing)?\b|bug|implement|refactor|migrat|secur|vulnerab|review|audit|plan(s|ning)?\b|prove|race condition|concurren|deadlock|optimi[sz]|performance|decide|judge|evaluate|trade-?offs?|why (does|is|did))\w*/i
// Reading, finding and summarising.
const SEARCH =
  /\b(find|search|locate|look (up|for|through)|grep|list|collect|gather|read|summari[sz]e|map out|where (is|are|does)|which files?|what (does|is|are)|count|enumerate|check whether|report)\w*/i
// A change already decided, carried out.
const MECHANICAL =
  /\b(rename|replace|update (the )?(imports?|callers?|references?|docstrings?|comments?)|add (a )?(docstrings?|comments?|type hints?)|format|reformat|move|delete|remove|bump|write (unit )?tests? for|apply (this|the) (change|patch|edit))\b/i

export const SUBAGENT_MODEL: Record<Exclude<Tier, 'full'>, string> = { light: 'haiku', medium: 'sonnet' }

// The only Opus the router hands work to is the current one, by its alias.
export function isOtherOpus(model: string | undefined): boolean {
  if (model === undefined) return false
  const m = model.toLowerCase()
  return m.includes('opus') && m !== 'opus' && !m.includes('opus-5-5')
}

export function pickSubagent(input: {
  subagentType: string
  prompt: string
  description: string
  model?: string
  parentModel: string
}): SubagentChoice {
  const { subagentType, prompt, description, model, parentModel } = input
  if (subagentType === 'fork') return { tier: 'full', reason: 'fork inherits' }
  if (isOtherOpus(model)) return { tier: 'full', model: 'opus', reason: 'older Opus replaced by the current one' }
  if (model !== undefined) return { tier: 'full', reason: 'model chosen by the caller' }
  // Only ever hand work down: a cheaper parent keeps its own model.
  if (rankOf(familyOf(parentModel)) < rankOf('opus')) return { tier: 'full', reason: 'parent already cheap' }
  const text = `${description}\n${prompt}`
  if (JUDGEMENT_TYPES.test(subagentType)) return { tier: 'full', reason: `${subagentType} needs judgement` }
  if (HARD.test(text)) return { tier: 'full', reason: 'task needs judgement' }
  if (READ_ONLY_TYPES.test(subagentType)) return { tier: 'light', model: SUBAGENT_MODEL.light, reason: `${subagentType}: read-only search` }
  if (MECHANICAL.test(text)) return { tier: 'medium', model: SUBAGENT_MODEL.medium, reason: 'decided change, carried out' }
  if (SEARCH.test(text)) return { tier: 'medium', model: SUBAGENT_MODEL.medium, reason: 'reading and summarising' }
  return { tier: 'full', reason: 'unclear task' }
}

// How much a downgraded subagent may stumble before it is handed up a rung.
export const SUBAGENT_LIMITS: Record<Exclude<Tier, 'full'>, { toolErrors: number; steps: number }> = {
  light: { toolErrors: 3, steps: 40 },
  medium: { toolErrors: 4, steps: 80 },
}

// What the main loop is told about handing work off, when that is on.
export const DELEGATION_GUIDANCE = [
  '# Splitting work across models',
  'You run on the most capable model; cheaper models are available for subagents. When a task has a self-contained part that is mostly reading, searching or summarising across several files, or a mechanical change you have already decided on in full, hand that part to a subagent: `Explore` for searches, or the general-purpose agent with `model: "sonnet"` for scoped reading or edits. Keep design, debugging, judgement calls, the final edit to anything subtle, and checking the result yourself.',
  'Do not delegate a lookup you can finish in one or two tool calls, or a part whose result you would have to re-read in full anyway. Give a subagent a complete, specific brief and ask for a short answer with file:line references.',
].join('\n')
