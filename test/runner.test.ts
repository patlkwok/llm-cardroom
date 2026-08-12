import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MatchRunner } from '../src/main/games/runner.ts'
import { defaultSettings, type MatchEvent, type MatchSettings } from '../src/shared/types.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

interface Capture {
  events: MatchEvent[]
  prompts: string[]
  systemPrompts: string[]
  emit: (event: MatchEvent) => void
}

function capture(): Capture {
  const events: MatchEvent[] = []
  return { events, prompts: [], systemPrompts: [], emit: (event) => events.push(event) }
}

/** Every log line the runner emitted, in order. */
function logTexts(sink: Capture): string[] {
  return sink.events.filter((e) => e.type === 'log').map((e) => (e.type === 'log' ? e.entry.text : ''))
}

/** The deal lines that state a stake, ignoring round headers and reveals. */
function betLines(sink: Capture): string[] {
  return sink.events
    .filter((e) => e.type === 'log' && e.entry.level === 'deal')
    .map((e) => (e.type === 'log' ? e.entry.text : ''))
    .filter((text) => text.includes(' bets '))
}

function finalSnapshot(sink: Capture) {
  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  return final.snapshot
}

/**
 * Stands in for OpenRouter. `reply` receives the user prompt and returns the
 * raw assistant message, so tests can simulate good and bad models alike.
 */
function mockOpenRouter(
  reply: (userPrompt: string) => string,
  sink?: Capture
): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      messages: Array<{ role: string; content: string }>
    }
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')
    const prompt = lastUser?.content ?? ''
    sink?.prompts.push(prompt)
    sink?.systemPrompts.push(body.messages.find((m) => m.role === 'system')?.content ?? '')

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: reply(prompt) } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0001 }
      })
    }
  }) as unknown as typeof fetch
}

/**
 * Picks a legal action straight out of the prompt the runner built.
 * `takeInsurance` models a player who always buys the side bet — mathematically
 * a losing habit, but a legal one worth exercising.
 */
function respondFromPrompt(prompt: string, takeInsurance = false): string {
  if (prompt.includes('Do you take insurance?')) {
    return JSON.stringify({
      reasoning: takeInsurance ? 'Ace up, buying the side bet.' : 'Declining the side bet.',
      insurance: takeInsurance
    })
  }
  if (prompt.includes('Decide how much to wager')) {
    const min = Number(prompt.match(/Table minimum: (\d+)/)?.[1] ?? 5)
    return JSON.stringify({ reasoning: 'Betting the minimum.', bet: min })
  }

  const line = prompt.split('\n').find((l) => l.startsWith('Legal actions:'))
  const options = (line ?? '').replace('Legal actions:', '').trim()

  if (/^(hit|stand|double|split)/.test(options)) {
    const actions = options.split(',').map((a) => a.trim())
    // Prefer standing so blackjack rounds resolve quickly and predictably.
    const choice = actions.includes('stand') ? 'stand' : actions[0]
    return JSON.stringify({ reasoning: `Taking ${choice}.`, action: choice })
  }

  if (options.includes('check')) {
    return JSON.stringify({ reasoning: 'Free card, so I check.', action: 'check' })
  }
  const call = options.match(/call (\d+)/)
  if (call) {
    return JSON.stringify({ reasoning: 'Price is fine, calling.', action: 'call' })
  }
  return JSON.stringify({ reasoning: 'Nothing to do but fold.', action: 'fold' })
}

/** A model that always takes insurance when it is offered. */
const alwaysInsures = (prompt: string): string => respondFromPrompt(prompt, true)

function blackjackSettings(overrides: Partial<MatchSettings> = {}): MatchSettings {
  return {
    ...defaultSettings(),
    game: 'blackjack',
    stepDelayMs: 0,
    maxRounds: 8,
    players: [
      {
        id: 'p1',
        name: 'Tester',
        modelId: 'test/model',
        modelName: 'Test',
        reasoningEffort: 'default' as const
      }
    ],
    ...overrides
  }
}

/** A blackjack table with several models sharing one shoe. */
function multiBlackjackSettings(
  seatCount: number,
  overrides: Partial<MatchSettings> = {}
): MatchSettings {
  return blackjackSettings({
    players: Array.from({ length: seatCount }, (_, i) => ({
      id: `p${i}`,
      name: `Seat${i}`,
      modelId: 'test/model',
      modelName: 'Test',
      reasoningEffort: 'default' as const
    })),
    ...overrides
  })
}

function pokerSettings(playerCount: number, overrides: Partial<MatchSettings> = {}): MatchSettings {
  const base = defaultSettings()
  return {
    ...base,
    game: 'poker',
    stepDelayMs: 0,
    // Equity is a few hundred milliseconds of real work per board change, which
    // swamps a zero-delay test table. equity.test.ts covers it directly.
    showEquity: false,
    maxRounds: 6,
    poker: { ...base.poker, startingStack: 500, smallBlind: 5, bigBlind: 10 },
    players: Array.from({ length: playerCount }, (_, i) => ({
      id: `p${i}`,
      name: `Bot${i}`,
      modelId: 'test/model',
      modelName: 'Test',
      reasoningEffort: 'default' as const
    })),
    ...overrides
  }
}

test('a blackjack session runs end to end against a mocked model', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const runner = new MatchRunner(blackjackSettings(), 'test-key', sink.emit)
  await runner.run()

  const snapshots = sink.events.filter((e) => e.type === 'snapshot')
  const final = snapshots[snapshots.length - 1]
  assert.equal(final.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')

  const bj = final.snapshot.blackjack
  assert.ok(bj)
  assert.equal(bj.roundsPlayed, 8, 'played the requested number of rounds')
  const seat = bj.players[0]
  assert.equal(seat.handsWon + seat.handsLost + seat.handsPushed > 0, true, 'hands were scored')
  assert.equal(seat.bankroll, 1000 + seat.sessionNet, 'bankroll matches the session result')

  const decisions = sink.events.filter((e) => e.type === 'decision')
  assert.ok(decisions.length > 0, 'the model was asked to act')
  for (const event of decisions) {
    if (event.type !== 'decision') continue
    assert.equal(event.record.fallback, undefined, 'no fallbacks with a well-behaved model')
    assert.ok(event.record.reasoning.length > 0)
  }

  const stats = final.snapshot.stats[0]
  assert.equal(stats.decisions, decisions.length)
  assert.ok(stats.costUsd > 0, 'cost was accumulated')
})

test('blackjack prompts describe the hand the model must play', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const runner = new MatchRunner(blackjackSettings({ maxRounds: 3 }), 'test-key', sink.emit)
  await runner.run()

  // Insurance offers are a different prompt shape; check the play prompts.
  const playPrompts = sink.prompts.filter((p) => p.includes('Legal actions:'))
  assert.ok(playPrompts.length > 0)
  for (const prompt of playPrompts) {
    assert.match(prompt, /Dealer shows: /, 'the upcard is stated')
    assert.match(prompt, /Your bankroll: [\d.]+/, 'the bankroll is stated')
  }
})

/* ------------------------------------------------- multi-seat blackjack */

test('several models share one blackjack shoe and one dealer', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = multiBlackjackSettings(4, { maxRounds: 6 })
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const snapshot = finalSnapshot(sink)
  assert.equal(snapshot.status, 'finished')
  const bj = snapshot.blackjack
  assert.ok(bj)
  assert.equal(bj.players.length, 4)
  assert.equal(bj.roundsPlayed, 6)

  for (const seat of bj.players) {
    assert.equal(
      seat.bankroll,
      1000 + seat.sessionNet,
      `${seat.name}'s bankroll should equal its start plus its own net`
    )
    assert.equal(seat.roundsPlayed, 6, `${seat.name} played every round`)
  }

  // Each seat is dealt its own hand in every round, and the dealer plays once.
  const dealsPerRound = new Map<string, number>()
  for (const text of betLines(sink)) {
    const name = text.split(' bets ')[0]
    dealsPerRound.set(name, (dealsPerRound.get(name) ?? 0) + 1)
  }
  assert.deepEqual([...dealsPerRound.values()], [6, 6, 6, 6])
  assert.equal(
    logTexts(sink).filter((t) => t.startsWith('Dealer ')).length,
    6,
    'one dealer hand a round, not one per seat'
  )

  // Every seat gets its own decisions and its own usage row.
  assert.equal(snapshot.stats.length, 4)
  for (const stat of snapshot.stats) assert.ok(stat.decisions > 0, 'every seat was asked to act')
})

test('a blackjack model is shown the other seats but only plays its own hand', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  await new MatchRunner(
    multiBlackjackSettings(3, { maxRounds: 4 }),
    'test-key',
    sink.emit
  ).run()

  const playPrompts = sink.prompts.filter((p) => p.includes('Legal actions:'))
  assert.ok(playPrompts.length > 0)
  for (const prompt of playPrompts) {
    assert.equal((prompt.match(/Your hand:|You have split into/g) ?? []).length, 1, 'one hand is yours')
    assert.match(prompt, /Other players at this table \(all cards are dealt face up\):/)

    // The face-up block must actually carry cards — that is the whole point of
    // seating several models on one shoe.
    const block = prompt.split('Other players at this table')[1].split('\n\n')[0]
    assert.ok(
      (block.match(/\b[2-9TJQKA][cdhs]\b/g) ?? []).length >= 2,
      `the other seats' cards should be listed: ${block}`
    )
  }

  assert.ok(
    sink.systemPrompts.some((p) => p.includes('all player cards are dealt FACE UP')),
    'the rule is stated in force, not left to be inferred'
  )
})

test('a single-seat blackjack table lists no other players', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  await new MatchRunner(blackjackSettings({ maxRounds: 3 }), 'test-key', sink.emit).run()

  for (const prompt of sink.prompts) {
    assert.ok(!prompt.includes('Other players at this table'), 'nobody else is at the table')
  }
  for (const prompt of sink.systemPrompts) {
    assert.ok(!prompt.includes('FACE UP'), 'and no face-up rule to explain')
  }
})

test('every seat is offered insurance in its own right', async () => {
  const sink = capture()
  mockOpenRouter(alwaysInsures, sink)

  const settings = multiBlackjackSettings(3, { maxRounds: 60 })
  settings.blackjack = { ...settings.blackjack, offerInsurance: true, startingBankroll: 100000 }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const texts = logTexts(sink)
  const taken = texts.filter((t) => /takes insurance for [\d.]+ chips/.test(t))
  const settled = texts.filter((t) => /Insurance (pays 2:1|loses)/.test(t))
  assert.ok(taken.length > 0, 'insurance should come up over 60 rounds')
  assert.equal(settled.length, taken.length, 'every side bet settles exactly once')

  // An ace up offers the bet to all three seats, not just the first.
  const names = new Set(taken.map((t) => t.split(' takes insurance')[0]))
  assert.equal(names.size, 3, `every seat bought insurance at some point, saw ${[...names]}`)

  const bj = finalSnapshot(sink).blackjack
  assert.ok(bj)
  for (const seat of bj.players) {
    assert.equal(seat.bankroll, 100000 + seat.sessionNet, `${seat.name} balances`)
  }
})

test('a model can join a blackjack table mid-match, from the next round', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = multiBlackjackSettings(2, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 300))
  runner.applyLiveSettings({
    ...settings,
    players: [
      ...settings.players,
      { id: 'late', name: 'Latecomer', modelId: 'test/model', modelName: 'Test', reasoningEffort: 'default' as const }
    ]
  })
  // Adding a model pauses the table so its setup can be adjusted first.
  await new Promise((r) => setTimeout(r, 150))
  const paused = finalSnapshot(sink)
  assert.equal(paused.status, 'paused', 'the table waits for setup')
  assert.ok(!paused.blackjack?.players.some((p) => p.id === 'late'), 'not seated yet')

  runner.resume()
  await new Promise((r) => setTimeout(r, 500))
  runner.stop()
  await running

  const texts = logTexts(sink)
  const joinIndex = texts.findIndex((t) => t.includes('Latecomer joins the table with 1000 chips'))
  assert.ok(joinIndex >= 0, 'the join is announced')
  // The seat count may only change between rounds, never during one.
  assert.match(texts[joinIndex + 1] ?? '', /^Round \d+:/, 'the join lands right before a new round')

  const bj = finalSnapshot(sink).blackjack
  assert.ok(bj)
  assert.equal(bj.players.length, 3)
  const late = bj.players.find((p) => p.id === 'late')
  assert.ok(late)
  assert.ok(late.roundsPlayed > 0, 'and it actually played')
  assert.ok(late.roundsPlayed < bj.roundsPlayed, 'but only from the round it joined')
})

test('a blackjack model can be removed mid-match and takes its chips', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = multiBlackjackSettings(3, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 300))
  runner.applyLiveSettings({ ...settings, players: settings.players.slice(0, 2) })
  await new Promise((r) => setTimeout(r, 500))
  runner.stop()
  await running

  assert.ok(
    logTexts(sink).some((t) => /Seat2 leaves the table, taking [\d.]+ chips/.test(t)),
    'the departure is announced with the chips taken'
  )

  const bj = finalSnapshot(sink).blackjack
  assert.ok(bj)
  assert.equal(bj.players.length, 2)
  assert.ok(!bj.players.some((p) => p.id === 'p2'))
})

test('the last blackjack seat leaving closes the table', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = multiBlackjackSettings(2, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 250))
  runner.applyLiveSettings({ ...settings, players: [] })
  await running

  assert.ok(
    logTexts(sink).some((t) => t.includes('Nobody is left at the table')),
    'the table closes rather than dealing to an empty felt'
  )
  assert.equal(finalSnapshot(sink).status, 'finished')
})

test('a blackjack seat that busts out is announced once, not every later round', async () => {
  const sink = capture()
  // Betting the whole bankroll every round empties at least one seat quickly,
  // with plenty of rounds still to come — which is when a per-round scan over
  // current state starts repeating itself.
  mockOpenRouter((prompt) => {
    if (prompt.includes('Decide how much to wager')) {
      const max = Number(prompt.match(/Most you may wager: (\d+)/)?.[1] ?? 25)
      return JSON.stringify({ reasoning: 'All in.', bet: max })
    }
    return respondFromPrompt(prompt)
  }, sink)

  const settings = multiBlackjackSettings(3, { maxRounds: 40 })
  settings.blackjack = { ...settings.blackjack, modelChoosesBet: true, startingBankroll: 100 }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const outs = logTexts(sink).filter((t) => t.includes('is out of chips'))
  assert.ok(outs.length > 0, 'the scenario should bust someone out')

  const counts = new Map<string, number>()
  for (const text of outs) {
    const name = text.split(' is out of chips')[0]
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  for (const [name, n] of counts) {
    assert.equal(n, 1, `"${name} is out of chips" was logged ${n} times`)
  }

  // A seat that is out stays out. It keeps showing the hand it went broke on
  // until the next deal clears the felt, so what proves it was not dealt in
  // again is a hand with no outcome — one still being played.
  const out = new Set<string>()
  for (const event of sink.events) {
    if (event.type !== 'snapshot' || !event.snapshot.blackjack) continue
    for (const seat of event.snapshot.blackjack.players) {
      if (out.has(seat.id)) {
        assert.ok(
          seat.hands.every((hand) => hand.outcome !== undefined),
          `${seat.name} was dealt a live hand after busting out`
        )
      }
      if (seat.busted) out.add(seat.id)
    }
  }
  assert.ok(out.size > 0, 'at least one seat should have gone out')
})

test('a poker match runs end to end and conserves chips', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(4)
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  await runner.run()

  const snapshots = sink.events.filter((e) => e.type === 'snapshot')
  const final = snapshots[snapshots.length - 1]
  assert.equal(final.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')

  const poker = final.snapshot.poker
  assert.ok(poker)
  assert.ok(poker.handsPlayed >= 1)

  const chips = poker.seats.reduce((sum, seat) => sum + seat.stack, 0) + poker.pot
  assert.equal(chips, 4 * 500, 'no chips created or destroyed')

  const decisions = sink.events.filter((e) => e.type === 'decision')
  assert.ok(decisions.length > 0)
  for (const event of decisions) {
    if (event.type !== 'decision') continue
    assert.equal(event.record.fallback, undefined)
  }
})

test('poker prompts give each model its own cards and the shared board', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const runner = new MatchRunner(pokerSettings(3, { maxRounds: 2 }), 'test-key', sink.emit)
  await runner.run()

  for (const prompt of sink.prompts) {
    assert.match(prompt, /Your cards: [2-9TJQKA][cdhs] [2-9TJQKA][cdhs]/, 'two hole cards')
    assert.match(prompt, /Pot: \d+ chips/)
    assert.match(prompt, /Legal actions: /)
    assert.match(prompt, /Players still in the hand:/)

    // The spectator sees every hand; a model must only ever see its own. The
    // opponent listing must therefore carry no card codes at all.
    const block = prompt.split('Players still in the hand:')[1]?.split('\n\n')[0] ?? ''
    const leaked = block.match(/\b[2-9TJQKA][cdhs]\b/g)
    assert.equal(leaked, null, `opponent hole cards leaked into the prompt: ${block}`)
  }

  // Exactly one hand is ever named as "yours" per prompt.
  for (const prompt of sink.prompts) {
    assert.equal((prompt.match(/Your cards:/g) ?? []).length, 1)
  }
})

test('a fold redistributes the win probabilities in the very same snapshot', async () => {
  const sink = capture()
  // The first player to face a bet folds, so a fold lands early in the hand
  // with two contenders still to divide the equity between them.
  mockOpenRouter((prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('Legal actions:')) ?? ''
    if (line.includes('call')) return JSON.stringify({ reasoning: 'Not worth it.', action: 'fold' })
    return JSON.stringify({ reasoning: 'Free card.', action: 'check' })
  }, sink)

  const settings = pokerSettings(3, { maxRounds: 1, showEquity: true, stepDelayMs: 0 })
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const states = sink.events
    .filter((e) => e.type === 'snapshot')
    .map((e) => (e.type === 'snapshot' ? e.snapshot.poker : undefined))

  // The first frame the operator sees with somebody folded must already show
  // the redistribution. Refreshing after the push left the new numbers stranded
  // in state until the *next* player acted.
  const afterFold = states.find(
    (poker) => poker?.phase === 'hand' && poker.seats.some((seat) => seat.folded)
  )
  assert.ok(afterFold, 'somebody should fold in a hand where every call is refused')

  const live = afterFold.seats.filter((seat) => !seat.folded)
  for (const seat of afterFold.seats) {
    if (seat.folded) {
      assert.equal(seat.equity, undefined, `${seat.name} folded but still shows a win probability`)
    } else {
      assert.ok(seat.equity !== undefined, `${seat.name} is live but shows no win probability`)
    }
  }
  const sum = live.reduce((total, seat) => total + (seat.equity ?? 0), 0)
  assert.ok(
    Math.abs(sum - 1) < 0.02,
    `the remaining seats should split the whole pot's chances, saw ${sum.toFixed(3)}`
  )
})

test('a model that never returns valid JSON falls back instead of stalling', async () => {
  const sink = capture()
  mockOpenRouter(() => 'I am not going to answer in JSON, sorry.')

  const runner = new MatchRunner(blackjackSettings({ maxRounds: 3 }), 'test-key', sink.emit)
  await runner.run()

  const snapshots = sink.events.filter((e) => e.type === 'snapshot')
  const final = snapshots[snapshots.length - 1]
  assert.equal(final.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')
  assert.equal(final.snapshot.blackjack?.roundsPlayed, 3, 'the table kept moving')

  const decisions = sink.events.filter((e) => e.type === 'decision')
  for (const event of decisions) {
    if (event.type !== 'decision') continue
    assert.ok(event.record.fallback, 'each decision is marked as a fallback')
  }
  assert.ok(final.snapshot.stats[0].fallbacks > 0)
})

test('an illegal action is rejected and retried before falling back', async () => {
  const sink = capture()
  let calls = 0
  mockOpenRouter((prompt) => {
    calls++
    // First answer is always illegal; the correction should produce a legal one.
    if (calls % 2 === 1) return JSON.stringify({ reasoning: 'Splitting.', action: 'split' })
    return respondFromPrompt(prompt)
  }, sink)

  const runner = new MatchRunner(blackjackSettings({ maxRounds: 4 }), 'test-key', sink.emit)
  await runner.run()

  const decisions = sink.events.filter((e) => e.type === 'decision')
  const retried = decisions.filter((e) => e.type === 'decision' && e.record.attempts > 1)
  assert.ok(retried.length > 0, 'at least one decision needed a second attempt')

  // The corrective message must tell the model what went wrong.
  const corrections = sink.prompts.filter((p) => p.includes('Reply again with only the JSON object'))
  assert.ok(corrections.length > 0)
  assert.ok(
    corrections.some((c) => /not legal right now|is not an action/.test(c)),
    'the correction names the problem'
  )
})

test('a network failure is reported without crashing the match', async () => {
  const sink = capture()
  globalThis.fetch = (async () => {
    throw new Error('socket hang up')
  }) as unknown as typeof fetch

  const runner = new MatchRunner(blackjackSettings({ maxRounds: 2 }), 'test-key', sink.emit)
  await runner.run()

  const snapshots = sink.events.filter((e) => e.type === 'snapshot')
  const final = snapshots[snapshots.length - 1]
  assert.equal(final.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')

  const errors = sink.events.filter(
    (e) => e.type === 'log' && e.entry.level === 'error'
  )
  assert.ok(errors.length > 0, 'the failure was logged for the operator')
})

test('stopping a match ends the run promptly', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const runner = new MatchRunner(
    blackjackSettings({ maxRounds: 0, stepDelayMs: 50 }),
    'test-key',
    sink.emit
  )
  const running = runner.run()
  setTimeout(() => runner.stop(), 120)
  await running

  const snapshots = sink.events.filter((e) => e.type === 'snapshot')
  const final = snapshots[snapshots.length - 1]
  assert.equal(final.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')
})

test('thinking events bracket every model call', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const runner = new MatchRunner(blackjackSettings({ maxRounds: 3 }), 'test-key', sink.emit)
  await runner.run()

  const thinking = sink.events.filter((e) => e.type === 'thinking')
  const on = thinking.filter((e) => e.type === 'thinking' && e.active).length
  const off = thinking.filter((e) => e.type === 'thinking' && !e.active).length
  assert.ok(on > 0)
  assert.equal(on, off, 'every spinner that starts also stops')
})

test('reasoning effort shapes the request body, and temperature is never sent', async () => {
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"reasoning":"ok","action":"stand"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 }
      })
    }
  }) as unknown as typeof fetch

  const cases: Array<[MatchSettings['players'][number]['reasoningEffort'], unknown, number]> = [
    ['default', undefined, 900],
    ['none', { enabled: false }, 900],
    ['low', { effort: 'low' }, 3000],
    ['medium', { effort: 'medium' }, 6000],
    ['high', { effort: 'high' }, 12000]
  ]

  for (const [effort, expectedReasoning, expectedBudget] of cases) {
    bodies.length = 0
    const settings = blackjackSettings({ maxRounds: 1 })
    // Self-sizing bets guarantee at least one call per round, even when the
    // deal is a natural and needs no play decision.
    settings.blackjack = { ...settings.blackjack, modelChoosesBet: true }
    settings.players = [{ ...settings.players[0], reasoningEffort: effort }]
    await new MatchRunner(settings, 'test-key', capture().emit).run()

    assert.ok(bodies.length > 0, `no request sent for effort ${effort}`)
    for (const body of bodies) {
      assert.equal(body.temperature, undefined, 'temperature must never be sent')
      assert.deepEqual(body.reasoning, expectedReasoning, `reasoning field for ${effort}`)
      assert.equal(body.max_tokens, expectedBudget, `token budget for ${effort}`)
    }
  }
})

test('the operator can change the stake mid-match; it lands on the next round', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = blackjackSettings({ maxRounds: 0, stepDelayMs: 20 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  // Let a couple of rounds go by at the original stake, then raise it.
  await new Promise((r) => setTimeout(r, 250))
  runner.applyLiveSettings({
    ...settings,
    blackjack: { ...settings.blackjack, baseBet: 200 }
  })
  await new Promise((r) => setTimeout(r, 400))
  runner.stop()
  await running

  const deals = sink.events
    .filter((e) => e.type === 'log' && e.entry.level === 'deal')
    .map((e) => (e.type === 'log' ? e.entry.text : ''))
    .filter((t) => t.includes('bets'))

  const stakes = deals.map((t) => Number(t.match(/bets (\d+)/)?.[1]))
  assert.ok(stakes.length >= 2, `expected several deals, saw ${stakes.length}`)
  assert.equal(stakes[0], 25, 'started at the configured stake')
  assert.ok(stakes.includes(200), `expected the new stake to appear, saw ${stakes.join(', ')}`)

  // No round may straddle the change: every deal is one stake or the other.
  for (const stake of stakes) assert.ok(stake === 25 || stake === 200, `unexpected stake ${stake}`)

  const changeLogged = sink.events.some(
    (e) => e.type === 'log' && e.entry.text.includes('Stake changed from 25 to 200')
  )
  assert.ok(changeLogged, 'the change is reported to the operator')
})

test('the pace and round limit can also be changed mid-match', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = blackjackSettings({ maxRounds: 0, stepDelayMs: 20 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 200))
  // Capping the match at 1 round should end it rather than run forever.
  runner.applyLiveSettings({ ...settings, maxRounds: 1 })
  await running

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished', 'the new limit ended the match')
})

test('the model sizes its own bet when that mode is on', async () => {
  const sink = capture()
  mockOpenRouter((prompt) => {
    if (prompt.includes('Decide how much to wager')) {
      return JSON.stringify({ reasoning: 'Shoe is rich, pressing up.', bet: 75 })
    }
    return respondFromPrompt(prompt)
  }, sink)

  const settings = blackjackSettings({ maxRounds: 3 })
  settings.blackjack = { ...settings.blackjack, modelChoosesBet: true }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const betPrompts = sink.prompts.filter((p) => p.includes('Decide how much to wager'))
  assert.equal(betPrompts.length, 3, 'asked once before each deal')
  for (const prompt of betPrompts) {
    assert.match(prompt, /Bankroll: [\d.]+ chips/)
    assert.match(prompt, /Table minimum: \d+\. Most you may wager: \d+/)
  }

  // Dealer reveals are logged at the same level, so keep only the deal lines.
  const deals = sink.events
    .filter((e) => e.type === 'log' && e.entry.level === 'deal')
    .map((e) => (e.type === 'log' ? e.entry.text : ''))
    .filter((t) => t.includes(' bets '))
  assert.equal(deals.length, 3)
  assert.ok(deals.every((t) => t.includes('bets 75')), `expected 75-chip bets, saw: ${deals.join(' | ')}`)

  const betDecisions = sink.events.filter(
    (e) => e.type === 'decision' && e.record.actionLabel.startsWith('bets')
  )
  assert.equal(betDecisions.length, 3, 'each wager is recorded with its reasoning')
})

test('an out-of-range wager is clamped rather than rejected', async () => {
  const sink = capture()
  mockOpenRouter((prompt) => {
    if (prompt.includes('Decide how much to wager')) {
      return JSON.stringify({ reasoning: 'All in!', bet: 999_999 })
    }
    return respondFromPrompt(prompt)
  }, sink)

  const settings = blackjackSettings({ maxRounds: 1 })
  settings.blackjack = { ...settings.blackjack, modelChoosesBet: true }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const deals = betLines(sink)
  assert.equal(deals.length, 1)
  assert.match(deals[0], /bets 1000\b/, 'clamped to the whole bankroll')
})

test('a model that cannot size a bet falls back to the table minimum', async () => {
  const sink = capture()
  mockOpenRouter((prompt) => {
    if (prompt.includes('Decide how much to wager')) return 'I would rather not say.'
    return respondFromPrompt(prompt)
  }, sink)

  const settings = blackjackSettings({ maxRounds: 2 })
  settings.blackjack = { ...settings.blackjack, modelChoosesBet: true }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const deals = sink.events
    .filter((e) => e.type === 'log' && e.entry.level === 'deal')
    .map((e) => (e.type === 'log' ? e.entry.text : ''))
    .filter((t) => t.includes(' bets '))
  assert.ok(deals.length > 0)
  assert.ok(
    deals.every((t) => t.includes('bets 25')),
    `fell back to the minimum and kept playing, saw: ${deals.join(' | ')}`
  )

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')
})

test('the model is asked about insurance and the side bet settles', async () => {
  const sink = capture()
  mockOpenRouter((prompt) => {
    if (prompt.includes('Do you take insurance?')) {
      return JSON.stringify({ reasoning: 'Ace up, taking the side bet.', insurance: true })
    }
    return respondFromPrompt(prompt)
  }, sink)

  const settings = blackjackSettings({ maxRounds: 120 })
  settings.blackjack = { ...settings.blackjack, offerInsurance: true, startingBankroll: 100000 }
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  await runner.run()

  const offers = sink.prompts.filter((p) => p.includes('Do you take insurance?'))
  assert.ok(offers.length > 0, 'insurance should be offered over 120 rounds')
  for (const prompt of offers) {
    assert.match(prompt, /dealer's upcard is an ace/)
    assert.match(prompt, /Insurance costs [\d.]+ chips, half your stake/)
  }

  const taken = sink.events.filter(
    (e) => e.type === 'decision' && e.record.actionLabel === 'takes insurance'
  )
  assert.equal(taken.length, offers.length, 'each offer is recorded as a decision')

  const settled = sink.events.filter(
    (e) => e.type === 'log' && /Insurance (pays 2:1|loses)/.test(e.entry.text)
  )
  assert.equal(settled.length, offers.length, 'every insurance bet is settled in the log')

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  const bj = final.snapshot.blackjack
  assert.ok(bj)
  assert.equal(
    bj.players[0].bankroll,
    100000 + bj.players[0].sessionNet,
    'insurance is included in the accounting'
  )
})

test('a model that always insures sees both outcomes, and the books balance', async () => {
  const sink = capture()
  mockOpenRouter(alwaysInsures, sink)

  const settings = blackjackSettings({ maxRounds: 400 })
  settings.blackjack = { ...settings.blackjack, offerInsurance: true, startingBankroll: 1_000_000 }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const texts = sink.events
    .filter((e) => e.type === 'log')
    .map((e) => (e.type === 'log' ? e.entry.text : ''))

  const taken = texts.filter((t) => /takes insurance for [\d.]+ chips/.test(t))
  const won = texts.filter((t) => t.includes('Insurance pays 2:1'))
  const lost = texts.filter((t) => t.includes('Insurance loses'))

  assert.ok(taken.length > 10, `insurance should be taken often, saw ${taken.length}`)
  assert.equal(won.length + lost.length, taken.length, 'every side bet settles exactly once')
  assert.ok(won.length > 0, 'the dealer should turn over blackjack sometimes')
  assert.ok(lost.length > 0, 'and not have it most of the time')

  // The dealer holds blackjack behind an ace roughly 4/13 of the time; a wildly
  // different rate would mean the peek or the offer is wired up wrongly.
  const winRate = won.length / taken.length
  assert.ok(winRate > 0.12 && winRate < 0.55, `insurance win rate looks wrong: ${winRate.toFixed(2)}`)

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  const bj = final.snapshot.blackjack
  assert.ok(bj)
  assert.equal(bj.roundsPlayed, 400)
  assert.equal(
    bj.players[0].bankroll,
    1_000_000 + bj.players[0].sessionNet,
    'insurance included in the accounting'
  )

  // Insurance decisions are recorded as their own entries in the feed.
  const insuranceDecisions = sink.events.filter(
    (e) => e.type === 'decision' && e.record.actionLabel === 'takes insurance'
  )
  assert.equal(insuranceDecisions.length, taken.length)
  for (const event of insuranceDecisions) {
    if (event.type !== 'decision') continue
    assert.equal(event.record.fallback, undefined, 'a valid answer is not a fallback')
    assert.match(event.record.reasoning, /buying the side bet/)
  }
})

test('taking insurance against a dealer blackjack is a wash for the round', async () => {
  const sink = capture()
  mockOpenRouter(alwaysInsures, sink)

  const settings = blackjackSettings({ maxRounds: 400 })
  settings.blackjack = { ...settings.blackjack, offerInsurance: true, startingBankroll: 1_000_000 }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const entries = sink.events
    .filter((e) => e.type === 'log')
    .map((e) => (e.type === 'log' ? e.entry.text : ''))

  // Find a round where insurance won and the hand was an ordinary loss: the
  // 2:1 payout should exactly cancel the lost stake.
  const winIndex = entries.findIndex((t) => t.includes('Insurance pays 2:1'))
  assert.ok(winIndex >= 0)
  const followUp = entries.slice(winIndex, winIndex + 6)
  assert.ok(
    followUp.some((t) => /loses -?\d/.test(t) || /pushes/.test(t) || /wins with blackjack/.test(t)),
    `the hand result should follow the insurance line: ${followUp.join(' | ')}`
  )
})

test('insurance is skipped entirely when the rule is off', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = blackjackSettings({ maxRounds: 60 })
  settings.blackjack = { ...settings.blackjack, offerInsurance: false }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  assert.equal(sink.prompts.filter((p) => p.includes('Do you take insurance?')).length, 0)
})

test('a model that cannot answer the insurance offer declines and plays on', async () => {
  const sink = capture()
  mockOpenRouter((prompt) => {
    if (prompt.includes('Do you take insurance?')) return 'maybe?'
    return respondFromPrompt(prompt)
  }, sink)

  const settings = blackjackSettings({ maxRounds: 80 })
  settings.blackjack = { ...settings.blackjack, offerInsurance: true, startingBankroll: 100000 }
  await new MatchRunner(settings, 'test-key', sink.emit).run()

  const declines = sink.events.filter(
    (e) => e.type === 'decision' && e.record.actionLabel === 'declines insurance'
  )
  assert.ok(declines.length > 0, 'fell back to declining')
  for (const event of declines) {
    if (event.type === 'decision') assert.ok(event.record.fallback)
  }

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')
  assert.equal(final.snapshot.blackjack?.roundsPlayed, 80)
})

test('a model can join a poker table mid-match, from the next hand', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(3, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 300))
  runner.applyLiveSettings({
    ...settings,
    players: [
      ...settings.players,
      { id: 'late', name: 'Latecomer', modelId: 'test/model', modelName: 'Test', reasoningEffort: 'default' as const }
    ]
  })
  // Adding a model pauses the table so its setup can be adjusted first.
  await new Promise((r) => setTimeout(r, 150))
  runner.resume()
  await new Promise((r) => setTimeout(r, 600))
  runner.stop()
  await running

  const joined = sink.events.some(
    (e) => e.type === 'log' && e.entry.text.includes('Latecomer joins the table with 500 chips')
  )
  assert.ok(joined, 'the join is announced')

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  const poker = final.snapshot.poker
  assert.ok(poker)
  assert.equal(poker.seats.length, 4)
  assert.ok(poker.seats.some((s) => s.id === 'late'))
  assert.ok(
    final.snapshot.players.some((p) => p.id === 'late'),
    'the roster the UI sees includes the newcomer'
  )

  // The seat count may only change between hands, never during one.
  const logs = sink.events.filter((e) => e.type === 'log').map((e) => (e.type === 'log' ? e.entry : null))
  const joinIndex = logs.findIndex((l) => l?.text.includes('joins the table'))
  assert.ok(joinIndex >= 0)
  assert.match(logs[joinIndex + 1]?.text ?? '', /^Hand \d+:/, 'the join lands right before a new hand')
})

test('adding a model mid-match pauses so its effort can still be set', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(3, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 250))
  const withNewcomer = {
    ...settings,
    players: [
      ...settings.players,
      { id: 'late', name: 'Latecomer', modelId: 'test/model', modelName: 'Test', reasoningEffort: 'default' as const }
    ]
  }
  runner.applyLiveSettings(withNewcomer)
  await new Promise((r) => setTimeout(r, 200))

  let snap = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(snap?.type, 'snapshot')
  assert.equal(snap.snapshot.status, 'paused', 'the table waits for setup')
  assert.ok(
    sink.events.some((e) => e.type === 'log' && e.entry.text.includes('Set them up now')),
    'the operator is told why'
  )
  // Not seated yet, so nothing has been dealt to the newcomer.
  assert.ok(!snap.snapshot.poker?.seats.some((s) => s.id === 'late'))

  // Raise the newcomer's effort while paused, then resume.
  runner.applyLiveSettings({
    ...withNewcomer,
    players: withNewcomer.players.map((p) =>
      p.id === 'late' ? { ...p, reasoningEffort: 'high' as const } : p
    )
  })
  runner.resume()
  await new Promise((r) => setTimeout(r, 500))
  runner.stop()
  await running

  snap = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(snap?.type, 'snapshot')
  const seated = snap.snapshot.players.find((p) => p.id === 'late')
  assert.ok(seated, 'the newcomer is in the roster')
  assert.equal(seated.reasoningEffort, 'high', 'it joined with the effort set while paused')
  assert.ok(
    sink.events.some(
      (e) => e.type === 'log' && e.entry.text.includes('joins the table with 500 chips (high reasoning effort)')
    ),
    'the effort is noted when it sits down'
  )
})

test('a model waiting to join can still be renamed, and joins under the new name', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(3, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 300))
  const withNewcomer = {
    ...settings,
    players: [
      ...settings.players,
      { id: 'late', name: 'Placeholder', modelId: 'test/model', modelName: 'Test', reasoningEffort: 'default' as const }
    ]
  }
  runner.applyLiveSettings(withNewcomer)
  await new Promise((r) => setTimeout(r, 150))

  // Renamed while it waits, which is exactly what the sidebar now allows.
  runner.applyLiveSettings({
    ...withNewcomer,
    players: withNewcomer.players.map((p) =>
      p.id === 'late' ? { ...p, name: 'Renamed Bot' } : p
    )
  })
  runner.resume()
  await new Promise((r) => setTimeout(r, 600))
  runner.stop()
  await running

  const texts = logTexts(sink)
  assert.ok(texts.some((t) => t.includes('Renamed Bot joins the table')), 'joins under the new name')
  assert.ok(!texts.some((t) => t.includes('Placeholder joins the table')), 'and not under the old one')

  const snapshot = finalSnapshot(sink)
  const seat = snapshot.poker?.seats.find((s) => s.id === 'late')
  assert.ok(seat, 'the newcomer took a seat')
  assert.equal(seat.name, 'Renamed Bot', 'the felt shows the edited name')
  assert.equal(
    snapshot.players.find((p) => p.id === 'late')?.name,
    'Renamed Bot',
    'and so does the roster the UI reads back'
  )
})

test('editing a model that is already waiting to join does not stop the table again', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  // A slow pace keeps the hand running long enough to edit the newcomer after
  // resuming but before the hand boundary seats it.
  const settings = pokerSettings(3, { maxRounds: 0, stepDelayMs: 200 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 500))
  const withNewcomer = {
    ...settings,
    players: [
      ...settings.players,
      { id: 'late', name: 'Placeholder', modelId: 'test/model', modelName: 'Test', reasoningEffort: 'default' as const }
    ]
  }
  runner.applyLiveSettings(withNewcomer)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(finalSnapshot(sink).status, 'paused', 'arriving pauses the table once')

  runner.resume()
  await new Promise((r) => setTimeout(r, 50))
  // An edit to a model already in the queue is not a fresh arrival. Pausing
  // again here would stop the table dead on every keystroke of a rename.
  runner.applyLiveSettings({
    ...withNewcomer,
    players: withNewcomer.players.map((p) =>
      p.id === 'late' ? { ...p, name: 'Renamed' } : p
    )
  })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(finalSnapshot(sink).status, 'running', 'editing it does not pause the table again')

  runner.stop()
  await running

  const announcements = logTexts(sink).filter((t) => t.includes('will join next'))
  assert.equal(announcements.length, 1, `announced once, saw ${announcements.length}`)
})

test("a seated model's name is fixed for the match", async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(3, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 250))
  // Try to rename everyone already dealt in. Their names are on the felt and
  // all through the log, so they may not move.
  runner.applyLiveSettings({
    ...settings,
    players: settings.players.map((p) => ({ ...p, name: `${p.name} renamed` }))
  })
  await new Promise((r) => setTimeout(r, 500))
  runner.stop()
  await running

  const snapshot = finalSnapshot(sink)
  for (const player of snapshot.players) {
    assert.match(player.name, /^Bot\d$/, `${player.name} kept the name it sat down with`)
  }
  for (const seat of snapshot.poker?.seats ?? []) {
    assert.match(seat.name, /^Bot\d$/, `${seat.name} kept the name it sat down with`)
  }
})

test("a seated model's reasoning effort cannot be changed mid-match", async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(3, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 250))
  // Try to raise the effort of everyone already at the table.
  runner.applyLiveSettings({
    ...settings,
    players: settings.players.map((p) => ({ ...p, reasoningEffort: 'high' as const }))
  })
  await new Promise((r) => setTimeout(r, 500))
  runner.stop()
  await running

  const snap = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(snap?.type, 'snapshot')
  for (const player of snap.snapshot.players) {
    assert.equal(
      player.reasoningEffort,
      'default',
      `${player.name} kept the effort it sat down with`
    )
  }
  assert.equal(snap.snapshot.status, 'finished', 'the match was never paused for a seated change')
})

test('a model can be removed mid-match and takes its chips', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(4, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 300))
  runner.applyLiveSettings({ ...settings, players: settings.players.slice(0, 3) })
  await new Promise((r) => setTimeout(r, 600))
  runner.stop()
  await running

  const left = sink.events.find(
    (e) => e.type === 'log' && e.entry.text.includes('leaves the table, taking')
  )
  assert.ok(left, 'the departure is announced with the chips taken')

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.poker?.seats.length, 3)
  assert.ok(!final.snapshot.poker?.seats.some((s) => s.id === 'p3'))
})

test('dropping below two players closes the table', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const settings = pokerSettings(3, { maxRounds: 0, stepDelayMs: 15 })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  const running = runner.run()

  await new Promise((r) => setTimeout(r, 300))
  runner.applyLiveSettings({ ...settings, players: settings.players.slice(0, 1) })
  await running

  const closed = sink.events.some(
    (e) => e.type === 'log' && e.entry.text.includes('Fewer than two players remain')
  )
  assert.ok(closed, 'the table closes rather than dealing to one player')

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished')
})

/** Fails every chat call with the given HTTP status. */
function mockHttpFailure(status: number, body: string): void {
  globalThis.fetch = (async () => ({
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body)
  })) as unknown as typeof fetch
}

test('a rejected API key stops the match instead of falling back forever', async () => {
  const sink = capture()
  mockHttpFailure(401, '{"error":{"message":"No auth credentials found"}}')

  const runner = new MatchRunner(blackjackSettings({ maxRounds: 50 }), 'bad-key', sink.emit)
  await runner.run()

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'error', 'the match ends in an error state')
  assert.match(final.snapshot.errorText ?? '', /rejected the API key \(401\)/)

  // It must give up immediately, not grind through 50 rounds of fallbacks.
  assert.ok(
    (final.snapshot.blackjack?.roundsPlayed ?? 99) <= 1,
    'stopped on the first failure'
  )
  const decisions = sink.events.filter((e) => e.type === 'decision')
  assert.equal(decisions.length, 0, 'no decision is recorded for a fatal failure')
})

test('exhausted credits stop the match with a clear explanation', async () => {
  const sink = capture()
  mockHttpFailure(402, '{"error":{"message":"Insufficient credits"}}')

  const runner = new MatchRunner(pokerSettings(3, { maxRounds: 20 }), 'test-key', sink.emit)
  await runner.run()

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'error')
  assert.match(final.snapshot.errorText ?? '', /insufficient credits \(402\)/i)
})

test('a forbidden model stops the match rather than folding every hand', async () => {
  const sink = capture()
  mockHttpFailure(403, '{"error":{"message":"Model not available to this key"}}')

  const runner = new MatchRunner(pokerSettings(3, { maxRounds: 20 }), 'test-key', sink.emit)
  await runner.run()

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'error')
  assert.match(final.snapshot.errorText ?? '', /403/)
})

test('a fatal failure is not retried', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return {
      ok: false,
      status: 401,
      text: async () => 'unauthorised',
      json: async () => ({})
    }
  }) as unknown as typeof fetch

  await new MatchRunner(blackjackSettings({ maxRounds: 5 }), 'bad', capture().emit).run()
  assert.equal(calls, 1, 'one attempt, no retries, no second player asked')
})

test('ordinary rate limiting still retries rather than killing the match', async () => {
  const sink = capture()
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    // Fail the first call only; the retry should succeed.
    if (calls === 1) {
      return { ok: false, status: 429, text: async () => 'slow down', json: async () => ({}) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"reasoning":"ok","action":"stand"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 }
      })
    }
  }) as unknown as typeof fetch

  await new MatchRunner(blackjackSettings({ maxRounds: 2 }), 'test-key', sink.emit).run()

  const final = sink.events.filter((e) => e.type === 'snapshot').pop()
  assert.equal(final?.type, 'snapshot')
  assert.equal(final.snapshot.status, 'finished', 'a 429 is transient, not fatal')
  assert.ok(calls > 1, 'it retried')
})

test('poker refuses to start with fewer than two models', async () => {
  const sink = capture()
  mockOpenRouter(respondFromPrompt, sink)

  const runner = new MatchRunner(pokerSettings(1), 'test-key', sink.emit)
  await runner.run()

  const snapshots = sink.events.filter((e) => e.type === 'snapshot')
  const final = snapshots[snapshots.length - 1]
  assert.equal(final.type, 'snapshot')
  assert.equal(final.snapshot.status, 'error')
  assert.match(final.snapshot.errorText ?? '', /at least 2 models/)
})

test('an eliminated player is announced once, not every later hand', async () => {
  const sink = capture()
  // Everyone shoves, so stacks collapse fast and someone busts with plenty of
  // hands still to come — which is when the repeated announcement showed up.
  mockOpenRouter((prompt) => {
    const line = prompt.split('\n').find((l) => l.startsWith('Legal actions:')) ?? ''
    const shove = line.match(/raise to (?:any amount from \d+ to )?(\d+)/)
    if (shove) {
      return JSON.stringify({ reasoning: 'Shoving.', action: 'raise', amount: Number(shove[1]) })
    }
    if (line.includes('call')) return JSON.stringify({ reasoning: 'Calling it off.', action: 'call' })
    if (line.includes('check')) return JSON.stringify({ reasoning: 'Checking.', action: 'check' })
    return JSON.stringify({ reasoning: 'Folding.', action: 'fold' })
  }, sink)

  const base = defaultSettings()
  const settings = pokerSettings(3, {
    maxRounds: 30,
    poker: { ...base.poker, startingStack: 200, smallBlind: 5, bigBlind: 10 }
  })
  const runner = new MatchRunner(settings, 'test-key', sink.emit)
  await runner.run()

  const eliminations = sink.events
    .filter((e) => e.type === 'log')
    .map((e) => (e as { entry: { text: string } }).entry.text)
    .filter((text) => text.includes('is eliminated.'))

  assert.ok(eliminations.length > 0, 'the scenario should eliminate someone')

  const counts = new Map<string, number>()
  for (const text of eliminations) counts.set(text, (counts.get(text) ?? 0) + 1)
  for (const [text, n] of counts) {
    assert.equal(n, 1, `"${text}" was logged ${n} times`)
  }
})
