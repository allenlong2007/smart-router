import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION_MODEL = 'claude-opus-5-5'
const USAGE = { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Stands for the engine: records which model and effort each step was sent with.
function engine(on: On, sent: string[], opts: { triage?: string; stopReason?: string; env?: Record<string, string>; usage?: typeof USAGE } = {}) {
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
  on('tool.call', () => ({ result: {} }))
}

async function begin($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
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

test('subagents keep the model their own definition or caller picks', async ($, on) => {
  engine(on, [])
  const seen: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    seen.push(e.model)
    return { agentId: 'a1', model: e.model ?? e.parentModel } as any
  })
  await begin($)

  const spawn = (args: object) =>
    $.agent.spawn({ tool_use_id: 'x', description: 'd', prompt: 'p', parentModel: SESSION_MODEL, ...args } as any)
  await spawn({ subagentType: 'Explore' })
  await spawn({ subagentType: 'general-purpose' })

  expect(seen).toEqual([undefined, undefined])
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
