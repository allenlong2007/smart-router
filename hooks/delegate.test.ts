import { expect, test } from 'claude-code/testing'

import { isOtherOpus, pickSubagent } from './delegate'
import { priceOf, stepCost } from './learn'

const parentModel = 'claude-opus-5-5'
const pick = (subagentType: string, prompt: string, model?: string) =>
  pickSubagent({ subagentType, prompt, description: '', model, parentModel })

test('read-only agent types go to Haiku unless the task needs judgement', () => {
  expect(pick('Explore', 'Find where the config file is read').model).toBe('haiku')
  expect(pick('Explore', 'Investigate the root cause of the crash').model).toBeUndefined()
})

test('general-purpose: decided changes and reading go to Sonnet, judgement and unclear tasks stay', () => {
  expect(pick('general-purpose', 'Rename parse_money to parse_price in every file').model).toBe('sonnet')
  expect(pick('general-purpose', 'Summarize what each module in src/ does').model).toBe('sonnet')
  expect(pick('general-purpose', 'Implement a ByteSize parameter type').model).toBeUndefined()
  expect(pick('general-purpose', 'Refactor the storage layer').model).toBeUndefined()
  expect(pick('general-purpose', 'Do the thing').model).toBeUndefined()
})

test('judgement agent types, forks and cheap parents keep their model', () => {
  expect(pick('Plan', 'List the files').model).toBeUndefined()
  expect(pick('pr-review-toolkit:code-reviewer', 'List the files').model).toBeUndefined()
  expect(pick('fork', 'List the files').model).toBeUndefined()
  expect(pickSubagent({ subagentType: 'Explore', prompt: 'Find x', description: '', parentModel: 'claude-sonnet-5-5' }).model).toBeUndefined()
})

test('an explicit model is kept, except an older Opus, which becomes the current one', () => {
  expect(pick('general-purpose', 'List the files', 'sonnet').model).toBeUndefined()
  expect(pick('general-purpose', 'List the files', 'claude-opus-5').model).toBe('opus')
  expect(pick('general-purpose', 'List the files', 'claude-opus-4-8').model).toBe('opus')
  expect(isOtherOpus('opus')).toBe(false)
  expect(isOtherOpus('claude-opus-5-5')).toBe(false)
})

test('prices follow the exact model: older Opus bills more than Opus 5.5', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(Math.abs(stepCost('claude-opus-5-5', u) - 4) < 1e-9).toBe(true)
  expect(Math.abs(stepCost('claude-opus-5', u) - 5) < 1e-9).toBe(true)
  expect(Math.abs(stepCost('claude-opus-4-8', u) - 5) < 1e-9).toBe(true)
  expect(Math.abs(stepCost('claude-haiku-5-5', u) - 0.1) < 1e-9).toBe(true)
  expect(Math.abs(priceOf('claude-fable-5-2').output - 40e-6) < 1e-9).toBe(true)
  expect(Math.abs(priceOf('sonnet').read - 0.1e-6) < 1e-9).toBe(true)
})
