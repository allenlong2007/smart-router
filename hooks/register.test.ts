import { effortFor, isReadOnlySearch, readsALot } from './register'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION_MODEL = 'claude-opus-5-5'
const USAGE = { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Stands for the engine: records which model and effort each step was sent with.
function engine(on: On, sent: string[], opts: { triage?: string; stopReason?: string; toolError?: boolean; env?: Record<string, string>; usage?: typeof USAGE } = {}) {
  mock.store(on)
  mock.env(on, opts.env ?? {})
  on('command.register', () => ({ value: { command: 'route' } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: (e as any).answer ?? '' }) as any)
  on('model.complete', () => ({ value: { isAnswered: true, text: opts.triage ?? 'complex', usage: USAGE } }))
  on('turn.step', async function* (_, e) {
    sent.push(`${e.model}${e.effort === undefined ? '' : `@${e.effort}`}`)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: (opts.stopReason ?? 'end_turn') as 'end_turn',
      usage: opts.usage === undefined ? null : { ...opts.usage, model: e.model },
    }
  })
  on('tool.call', () => ({ result: {}, ...(opts.toolError ? { isError: true } : {}) }) as any)
}

// Older tests check models alone: they run with effort left untouched.
async function begin($: any, effort = 'session') {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'route', args: `effort ${effort}` })
}

async function step($: any, turnId: string, index = 0, effort?: string) {
  const stream = $.turn.step({ turnId, index, model: SESSION_MODEL, messageCount: 1, ...(effort ? { effort } : {}) })
  for await (const _ of stream);
  return stream.result
}

test('lookups start on Haiku, scoped edits on Sonnet, hard work on the session model', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  await $.turn.start({ text: 'what does git status show?', turnId: 't1' })
  await step($, 't1')
  await $.turn.start({ text: 'add a docstring to the add function in calc.py', turnId: 't2' })
  await step($, 't2')
  await $.turn.start({ text: 'refactor the auth module to use sessions', turnId: 't3' })
  await step($, 't3')

  expect(sent).toEqual(['haiku', 'sonnet', SESSION_MODEL])
})

test('effort is passed on unchanged to the cheaper model', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  await $.turn.start({ text: 'what does main.py do?', turnId: 't1' })
  await step($, 't1', 0, 'high')

  expect(sent).toEqual(['haiku@high'])
})

test('a Haiku turn that wants to edit climbs to Sonnet, not straight to the session model', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  await $.turn.start({ text: 'what is in config.ts?', turnId: 't1' })
  await step($, 't1', 0)
  const ran = await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })
  await step($, 't1', 1)
  await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })
  await step($, 't1', 2)

  expect(ran.deny).toMatch(/more capable model now has the turn/)
  expect(sent).toEqual(['haiku', 'sonnet', 'sonnet'])
})

test('a Sonnet turn whose changes spread over many files climbs to the session model', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  await $.turn.start({ text: 'update the copyright year in the headers', turnId: 't1' })
  for (let i = 0; i < 7; i++) {
    await step($, 't1', i)
    await $.tool.call({ tool: 'Edit', file_path: `/f${i}.ts`, old_string: 'a', new_string: 'b' })
  }
  await step($, 't1', 7)

  expect(sent.slice(0, 7).every(m => m === 'sonnet')).toBe(true)
  expect(sent[7]).toBe(SESSION_MODEL)
})

test('a cheap reply cut off at max_tokens climbs a rung', async ($, on) => {
  const sent: string[] = []
  engine(on, sent, { stopReason: 'max_tokens' })
  await begin($)

  await $.turn.start({ text: 'what does main.py do?', turnId: 't1' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  await step($, 't1', 2)

  expect(sent).toEqual(['haiku', 'sonnet', SESSION_MODEL])
})

test('ambiguous prompts follow the triage, and anything not trivial or standard stays full', async ($, on) => {
  const sent: string[] = []
  engine(on, sent, { triage: 'standard' })
  await begin($)

  await $.turn.start({ text: 'can you look into the thing we talked about with the cache', turnId: 't1' })
  await step($, 't1')

  expect(sent).toEqual(['sonnet'])
})

test('a complaint after a cheap turn keeps the next turns on the session model', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  await $.turn.start({ text: 'what does main.py do?', turnId: 't1' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: '' } as any)
  await $.turn.start({ text: "that's not right, look again", turnId: 't2' })
  await step($, 't2')
  await $.turn.complete({ turnId: 't2', answer: '' } as any)
  await $.turn.start({ text: 'what does util.py do?', turnId: 't3' })
  await step($, 't3')

  expect(sent).toEqual(['haiku', SESSION_MODEL, SESSION_MODEL])
})

test('!sonnet and !full pick the tier and are stripped from the prompt', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await begin($)

  const submitted = await $.prompt.submit({ text: '!full what is 2+2' } as any)
  await $.turn.start({ text: 'what is 2+2', turnId: 't1' })
  await step($, 't1')
  await $.prompt.submit({ text: '!sonnet refactor everything' } as any)
  await $.turn.start({ text: 'refactor everything', turnId: 't2' })
  await step($, 't2')

  expect((submitted as any).text).toBe('what is 2+2')
  expect(sent).toEqual([SESSION_MODEL, 'sonnet'])
})

test('SMART_ROUTER=off leaves every turn on the session model', async ($, on) => {
  const sent: string[] = []
  engine(on, sent, { env: { SMART_ROUTER: 'off' } })
  await begin($)

  await $.turn.start({ text: 'what does git status show?', turnId: 't1' })
  await step($, 't1')

  expect(sent).toEqual([SESSION_MODEL])
})

test('subagents start on the cheapest model their task allows; judgement and explicit picks are kept', async ($, on) => {
  engine(on, [])
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { agentId: `a${seen.length}`, model: e.model ?? e.parentModel } as any
  })
  await begin($)

  const spawn = (args: object) =>
    $.agent.spawn({ tool_use_id: 'x', description: 'd', prompt: 'p', parentModel: SESSION_MODEL, ...args } as any)
  await spawn({ subagentType: 'Explore', prompt: 'Find where config is loaded' })
  await spawn({ subagentType: 'general-purpose', prompt: 'List every call to parse_args with file:line' })
  await spawn({ subagentType: 'general-purpose', prompt: 'Fix the clamping bug in IntRange' })
  await spawn({ subagentType: 'general-purpose', prompt: 'p' })
  await spawn({ subagentType: 'Plan', prompt: 'Find the files to change' })
  await spawn({ subagentType: 'general-purpose', prompt: 'List the files', model: 'opus' })
  await spawn({ subagentType: 'general-purpose', prompt: 'List the files', model: 'claude-opus-5' })
  await spawn({ subagentType: 'fork', prompt: 'List the files' })

  expect(seen).toEqual(['haiku', 'sonnet', undefined, undefined, undefined, 'opus', 'opus', undefined])
})

test('subagent routing can be turned off', async ($, on) => {
  engine(on, [])
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { agentId: 'a1', model: e.model ?? e.parentModel } as any
  })
  await begin($)
  await $.command.run({ command: 'route', args: 'subagents off' } as any)
  await $.agent.spawn({ tool_use_id: 'x', description: 'd', prompt: 'Find where config is loaded', subagentType: 'Explore', parentModel: SESSION_MODEL } as any)
  expect(seen).toEqual([undefined])
})

test('a cheap subagent runs its steps on its model, moves up after repeated tool errors, and is measured against the parent', async ($, on) => {
  const sent: string[] = []
  engine(on, sent, { toolError: true, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  on('agent.spawn', (_, e) => ({ agentId: 'sub1', model: e.model ?? e.parentModel }) as any)
  await begin($)
  await $.agent.spawn({ tool_use_id: 'x', description: 'd', prompt: 'Find where config is loaded', subagentType: 'Explore', parentModel: SESSION_MODEL } as any)

  const subStep = async (index: number) => {
    const stream = $.turn.step({ turnId: 'st', index, model: SESSION_MODEL, messageCount: 1, agentId: 'sub1' } as any)
    for await (const _ of stream);
  }
  await subStep(0)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'sub1' } as any)
  await subStep(1)
  await $.turn.complete({ turnId: 'st', agentId: 'sub1', answer: '' } as any)

  expect(sent).toEqual(['haiku', 'sonnet'])
  const status = await $.command.run({ command: 'route', args: '' } as any)
  expect((status as any).text).toContain('handed up 1')
  expect((status as any).text).toMatch(/Subagent spend \$0\.00\d* vs \$0\.01/)
})

test('delegation guidance is opt-in, and only where the session model can start subagents', async ($, on) => {
  engine(on, [])
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }) as any)
  await begin($)
  const off = (await $.prompt.compose({ model: SESSION_MODEL, promptModel: SESSION_MODEL, surfaces: [], tools: ['Agent'], outputStyle: null, traits: [] } as any)) as any
  expect(off.sections.length).toBe(1)
  await $.command.run({ command: 'route', args: 'delegate on' } as any)
  const compose = (model: string, tools: string[]) =>
    $.prompt.compose({ model, promptModel: model, surfaces: [], tools, outputStyle: null, traits: [] } as any)
  const withAgent = (await compose(SESSION_MODEL, ['Read', 'Agent'])) as any
  const noAgent = (await compose(SESSION_MODEL, ['Read'])) as any
  const onHaiku = (await compose('claude-haiku-5-5', ['Agent'])) as any
  expect(withAgent.sections.map((x: any) => x.id)).toEqual(['intro', 'smart-router:delegation'])
  expect(noAgent.sections.length).toBe(1)
  expect(onHaiku.sections.length).toBe(1)
})

test('running the tests to report on them starts on Haiku; asking for a fix does not', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  await $.turn.start({ text: 'Run the tests and tell me how many pass and how many fail.', turnId: 't1' })
  await step($, 't1')
  await $.turn.start({ text: 'run the tests and fix whatever fails', turnId: 't2' })
  await step($, 't2')

  expect(sent).toEqual(['haiku', SESSION_MODEL])
})

test('turns of a kind that keep escalating off Haiku start on Sonnet next time', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  for (let i = 1; i <= 4; i++) {
    await $.turn.start({ text: 'what is in config.ts?', turnId: `t${i}` })
    await step($, `t${i}`, 0)
    await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b' })
    await step($, `t${i}`, 1)
    await $.turn.complete({ turnId: `t${i}`, answer: '' } as any)
  }
  sent.length = 0
  await $.turn.start({ text: 'what is in main.ts?', turnId: 't5' })
  await step($, 't5', 0)

  expect(sent).toEqual(['sonnet'])
})

test('a complaint is remembered against the kind of request that caused it', async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  for (let i = 1; i <= 3; i++) {
    await $.turn.start({ text: 'add a docstring to foo', turnId: `a${i}` })
    await step($, `a${i}`)
    await $.turn.complete({ turnId: `a${i}`, answer: '' } as any)
    await $.turn.start({ text: "that's wrong, try again", turnId: `b${i}` })
    await step($, `b${i}`)
    await $.turn.complete({ turnId: `b${i}`, answer: '' } as any)
    // The two turns after a complaint stay on the session model.
    for (const s of ['c', 'd']) {
      await $.turn.start({ text: 'what is 1+1?', turnId: `${s}${i}` })
      await step($, `${s}${i}`)
      await $.turn.complete({ turnId: `${s}${i}`, answer: '' } as any)
    }
  }
  sent.length = 0
  await $.turn.start({ text: 'add a docstring to bar', turnId: 'z' })
  await step($, 'z')

  expect(sent).toEqual([SESSION_MODEL])
})

test("asking what is wrong with code is a debugging question, not a complaint about the last answer", async ($, on) => {
  const sent: string[] = []
  engine(on, sent)
  await begin($)

  await $.turn.start({ text: 'what does main.py do?', turnId: 't1' })
  await step($, 't1')
  await $.turn.complete({ turnId: 't1', answer: '' } as any)
  await $.turn.start({ text: 'what is wrong in util.py?', turnId: 't2' })
  await step($, 't2')

  expect(sent).toEqual(['haiku', SESSION_MODEL])
})

test('savings are measured against the session model with its cache, not a cold one', async ($, on) => {
  const sent: string[] = []
  // Each request reads 30k cached tokens, writes 2k and replies with 100.
  engine(on, sent, { usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 } })
  await begin($)

  await $.turn.start({ text: 'what does main.py do?', turnId: 't1' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  await $.turn.complete({ turnId: 't1', answer: '' } as any)
  const status = await $.command.run({ command: 'route', args: '' } as any)

  expect(sent).toEqual(['haiku', 'haiku'])
  // Haiku: about $0.0015. Opus would have paid about $0.032: the first request
  // writes past the shared opening, the second reads it all from cache.
  expect((status as any).text).toMatch(/Estimated spend \$0\.00 vs \$0\.03 /)
})

test('prompts that load whole files stay on the session model; ordinary lookups do not', () => {
  expect(readsALot('Read src/click/core.py and src/click/types.py in full (all of each file, not excerpts). Then give me an overview')).toBe(true)
  expect(readsALot('Read the whole file and summarize it')).toBe(true)
  expect(readsALot('Read a.py, b.py and c.py and tell me how they connect')).toBe(true)
  expect(readsALot('What does parse_args in core.py return?')).toBe(false)
  expect(readsALot('Read a.py and tell me what it does')).toBe(false)
  expect(readsALot('List every place where os.environ is read')).toBe(false)
})

test('a failure after the subagent starts never starts it twice', async ($, on) => {
  engine(on, [])
  let spawns = 0
  on('agent.spawn', (_, e) => {
    spawns += 1
    // a result the router cannot read: its bookkeeping throws after the spawn
    return Object.defineProperty({ model: e.model ?? e.parentModel }, 'agentId', { get() { throw new Error('bad result') }, enumerable: true }) as any
  })
  await begin($)
  await $.agent.spawn({ tool_use_id: 'x', description: 'd', prompt: 'Find where config is loaded', subagentType: 'Explore', parentModel: SESSION_MODEL } as any).catch(() => {})
  expect(spawns).toBe(1)
})

test('effort is lowered where the benchmark showed no loss: Haiku and easy Opus turns to low, Sonnet to medium, hard work kept', async ($, on) => {
  const sent: string[] = []
  engine(on, sent, { triage: 'complex' })
  await begin($, 'lower')
  const turn = async (id: string, text: string, effort: string) => {
    await $.turn.start({ text, turnId: id })
    await step($, id, 0, effort)
  }
  await turn('t1', 'List every place where os.environ is read. Do not change any files.', 'high')
  await turn('t2', 'Add a docstring to parse_args', 'high')
  await turn('t3', 'Debug why the clamp returns the wrong value and fix it', 'high')
  await turn('t4', 'Read core.py and types.py in full and give me an overview', 'medium')
  await turn('t5', 'Add a docstring to parse_args', 'low')
  expect(sent).toEqual(['haiku@low', 'sonnet@medium', `${SESSION_MODEL}@high`, `${SESSION_MODEL}@low`, 'sonnet@low'])
})

test('read-only searches go to Haiku even when they say every; judgement and edits do not', () => {
  expect(isReadOnlySearch('List every call to echo( inside src/click, as file.py:line. Do not change any files.')).toBe(true)
  expect(isReadOnlySearch('Find all places that read os.environ')).toBe(true)
  expect(isReadOnlySearch('List every bug in the parser')).toBe(false)
  expect(isReadOnlySearch('Explain how parameters are ordered. Do not change any files.')).toBe(false)
  expect(isReadOnlySearch('Find the typo and update the docstring')).toBe(false)
})

test('the default effort setting runs hard Opus turns at low too, and never goes below medium on Sonnet', async ($, on) => {
  const sent: string[] = []
  engine(on, sent, { triage: 'complex' })
  await begin($, 'low')
  await $.turn.start({ text: 'Debug why the clamp returns the wrong value and fix it', turnId: 't1' })
  await step($, 't1', 0, 'medium')
  await $.turn.start({ text: 'Add a docstring to parse_args', turnId: 't2' })
  await step($, 't2', 0, 'high')
  expect(sent).toEqual([`${SESSION_MODEL}@low`, 'sonnet@medium'])
})
