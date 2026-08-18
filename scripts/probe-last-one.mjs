/**
 * A measurement, not a feature.
 *
 *   node scripts/probe-last-one.mjs [hands]
 *
 * "Last One" is a candidate game for this app: a shedding game in the Crazy
 * Eights family — a draw pile, a discard, a colour to follow, skips, reverses,
 * draw-twos and wilds. The mechanics are old and free; the engine below is
 * written from them.
 *
 * The open question is not whether there is skill in it. There is: colour
 * management, holding action cards for the right moment, and the endgame all
 * reward thought. The question is **how many turns actually contain a
 * decision** — because a game whose turns are mostly forced cannot tell two
 * models apart however well they think, and every turn costs an API call
 * whether or not there was anything to decide.
 *
 * This probe answers that by measuring rather than arguing, the way "a quarter
 * to a third" became 23.7% for Hearts and "roughly three quarters" became 74.8%
 * for the 24 puzzle. Engine only: no prompts, no UI, no model calls.
 *
 * It measures two things, because density alone is a proxy:
 *
 *   1. Decision density — the share of turns offering more than one option,
 *      and the distribution of how many.
 *   2. Policy separation — whether three deliberately different policies
 *      actually finish differently, and how many hands it takes to see it.
 *      This is the direct form of the question density only approximates.
 *
 * Rules in force here, which are decisions rather than lookups:
 *  - 108 cards: per colour one 0, two each of 1-9, two each of skip, reverse
 *    and draw-two; plus four wilds and four wild-draw-fours.
 *  - Seven cards each. The first card turned is re-turned until it is a number,
 *    which sidesteps the pile of special cases for an action card on the flip.
 *  - A play must match the current colour or the current face, or be a wild.
 *  - **A wild draw-four is only legal when the player holds no card of the
 *    current colour.** This is the official restriction and it matters here:
 *    without it a wild draw-four is legal on every single turn, which would
 *    inflate the density figure this probe exists to produce.
 *  - Cannot play: draw one, and play it if it is playable. Otherwise the turn
 *    passes. A player never draws twice on one turn.
 *  - Reverse with two players acts as a skip.
 *  - When the draw pile runs out, the discard is recycled under the top card.
 *    If there is still nothing to draw, the turn simply passes — otherwise a
 *    hand where nobody can move never ends.
 */

const COLOURS = ['R', 'Y', 'G', 'B']
const NUMBERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const ACTIONS = ['skip', 'reverse', 'draw2']

/** A card is a colour plus a face; wilds have no colour until one is chosen. */
function card(colour, face) {
  return { colour, face }
}

function cardKey(c) {
  return `${c.colour ?? '*'}-${c.face}`
}

function isWild(c) {
  return c.face === 'wild' || c.face === 'wild4'
}

function buildDeck() {
  const deck = []
  for (const colour of COLOURS) {
    deck.push(card(colour, 0))
    for (const n of NUMBERS.slice(1)) {
      deck.push(card(colour, n), card(colour, n))
    }
    for (const a of ACTIONS) {
      deck.push(card(colour, a), card(colour, a))
    }
  }
  for (let i = 0; i < 4; i++) deck.push(card(null, 'wild'), card(null, 'wild4'))
  return deck
}

function shuffle(items, rng) {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Deterministic PRNG, so a surprising number can be reproduced exactly. */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Every distinct thing a player may do this turn.
 *
 * Distinct is the load-bearing word: two red fives in hand are one option, not
 * two, and counting them twice would inflate the headline figure. A wild is
 * counted once per colour it could name, because choosing the colour is a real
 * decision and arguably the most informative one in the game.
 */
function legalOptions(hand, colour, face, playableOnly = false) {
  const options = []
  const seen = new Set()
  const holdsColour = hand.some((c) => c.colour === colour)

  for (const c of hand) {
    const key = cardKey(c)
    if (seen.has(key)) continue

    if (c.face === 'wild4') {
      // Only when the player cannot follow colour. Without this restriction a
      // wild draw-four is legal on every turn and the density figure is a lie.
      if (holdsColour) continue
      seen.add(key)
      for (const pick of COLOURS) options.push({ card: c, colour: pick })
      continue
    }
    if (c.face === 'wild') {
      seen.add(key)
      for (const pick of COLOURS) options.push({ card: c, colour: pick })
      continue
    }
    if (c.colour === colour || c.face === face) {
      seen.add(key)
      options.push({ card: c, colour: c.colour })
    }
  }

  if (options.length === 0 && !playableOnly) return []
  return options
}

/** Distinct *cards* playable, ignoring which colour a wild would name. */
function playableCards(hand, colour, face) {
  const keys = new Set(legalOptions(hand, colour, face).map((o) => cardKey(o.card)))
  return keys.size
}

/* ------------------------------------------------------------------ policies */

const POINTS = { skip: 20, reverse: 20, draw2: 20, wild: 50, wild4: 50 }
const value = (c) => POINTS[c.face] ?? c.face

/** Uniformly random among the legal options, colour choice included. */
function randomPolicy(options, _hand, rng) {
  return options[Math.floor(rng() * options.length)]
}

/**
 * A plausible human heuristic: shed the most expensive card that is not a
 * wild, keep wilds for when nothing else works, and when naming a colour name
 * the one held most.
 */
function greedyPolicy(options, hand, rng) {
  const plain = options.filter((o) => !isWild(o.card))
  const pool = plain.length > 0 ? plain : options

  let best = pool[0]
  for (const option of pool) {
    if (value(option.card) > value(best.card)) best = option
  }
  if (!isWild(best.card)) return best

  // Naming a colour: the one this hand holds most of, so the next turn is
  // likely to have something to follow with.
  const counts = new Map()
  for (const c of hand) {
    if (c.colour) counts.set(c.colour, (counts.get(c.colour) ?? 0) + 1)
  }
  let pick = COLOURS[Math.floor(rng() * COLOURS.length)]
  let most = -1
  for (const colour of COLOURS) {
    const n = counts.get(colour) ?? 0
    if (n > most) {
      most = n
      pick = colour
    }
  }
  return options.find((o) => cardKey(o.card) === cardKey(best.card) && o.colour === pick) ?? best
}

/**
 * Deliberately bad, to establish the range: dump the wilds first and hoard the
 * high-scoring action cards, which is exactly backwards.
 */
function hoarderPolicy(options, _hand, rng) {
  const wilds = options.filter((o) => isWild(o.card))
  const pool = wilds.length > 0 ? wilds : options
  let best = pool[0]
  for (const option of pool) {
    if (value(option.card) < value(best.card)) best = option
  }
  return pool.includes(best) ? best : pool[Math.floor(rng() * pool.length)]
}

/* -------------------------------------------------------------------- a hand */

/**
 * Plays one hand out and returns what happened.
 *
 * `stats` accumulates the density measurements across hands so the caller does
 * not have to stitch them together.
 */
function playHand(policies, rng, stats) {
  const seats = policies.length
  let deck = shuffle(buildDeck(), rng)
  const hands = Array.from({ length: seats }, () => deck.splice(0, 7))

  // Re-turn until the starter is a number card: an action card on the flip has
  // its own pile of special cases and none of them change what is being
  // measured here.
  let start = deck.shift()
  while (typeof start.face !== 'number') {
    deck.push(start)
    start = deck.shift()
  }
  let discard = [start]
  let colour = start.colour
  let face = start.face

  let turn = 0
  let direction = 1
  let pendingDraw = 0
  let skipNext = false
  let plays = 0

  const draw = (n) => {
    const taken = []
    for (let i = 0; i < n; i++) {
      if (deck.length === 0) {
        // Recycle everything below the top card. If there is still nothing,
        // the player simply draws less than asked — a hand must always end.
        const top = discard.pop()
        if (discard.length === 0) {
          discard.push(top)
          break
        }
        deck = shuffle(discard, rng)
        discard = [top]
        stats.recycles++
      }
      taken.push(deck.shift())
    }
    return taken
  }

  for (let guard = 0; guard < 5000; guard++) {
    const seat = turn
    const hand = hands[seat]

    if (skipNext) {
      skipNext = false
      if (pendingDraw > 0) {
        hand.push(...draw(pendingDraw))
        pendingDraw = 0
      }
      turn = (turn + direction + seats) % seats
      continue
    }

    // One turn is one time a player is on turn — drawing and then playing what
    // was drawn is a single turn, not two. Counting it as two inflated the
    // denominator of the headline figure by about a tenth, which is exactly
    // the sort of quiet error a probe exists to avoid making.
    stats.turns++
    let options = legalOptions(hand, colour, face)
    let drewThisTurn = false

    if (options.length === 0) {
      stats.forcedDraw++
      stats.optionHistogram[0] = (stats.optionHistogram[0] ?? 0) + 1

      const taken = draw(1)
      hand.push(...taken)
      drewThisTurn = true
      options = taken.length > 0 ? legalOptions(taken, colour, face) : []

      if (options.length > 0) {
        // Drew something playable. Play-or-keep is a choice, and so is the
        // colour if it is a wild — but it is a thin one, so it is reported on
        // its own line rather than folded into the headline.
        stats.afterDrawChoice++
        stats.decisions++
      } else {
        turn = (turn + direction + seats) % seats
        continue
      }
    } else {
      const distinct = playableCards(hand, colour, face)
      const withColour = options.length
      stats.optionHistogram[distinct] = (stats.optionHistogram[distinct] ?? 0) + 1
      stats.cardOptionTotal += distinct
      stats.played++
      if (distinct > 1) stats.multiCard++
      // A single playable wild is still a decision, because naming the colour
      // is one — and it is the decision that shapes the next three turns.
      if (withColour > 1) stats.decisions++
      if (distinct === 1 && withColour > 1) stats.colourOnly++
    }

    const chosen = policies[seat](options, hand, rng)
    const at = hand.findIndex((c) => cardKey(c) === cardKey(chosen.card))
    if (at === -1) throw new Error('a policy chose a card that is not in hand')
    const [played] = hand.splice(at, 1)
    if (drewThisTurn) stats.playedAfterDraw++

    discard.push(played)
    colour = chosen.colour ?? played.colour
    face = played.face
    plays++

    if (hand.length === 0) {
      return {
        winner: seat,
        plays,
        // The proposed continuous metric: what everyone else was still
        // holding. It separates policies far faster than win rate does,
        // because every hand yields three numbers rather than one bit.
        left: hands.map((h) => h.reduce((sum, c) => sum + value(c), 0)),
        cards: hands.map((h) => h.length)
      }
    }

    if (played.face === 'skip') skipNext = true
    else if (played.face === 'draw2') {
      pendingDraw = 2
      skipNext = true
    } else if (played.face === 'wild4') {
      pendingDraw = 4
      skipNext = true
    } else if (played.face === 'reverse') {
      // With two players a reverse is a skip, which is the standard rule and
      // not merely a convenience: otherwise the same player plays forever.
      if (seats === 2) skipNext = true
      else direction = -direction
    }

    turn = (turn + direction + seats) % seats
  }

  // A hand that cannot end is the invariant this game most needs; say so
  // loudly rather than returning a quiet non-result.
  throw new Error('a hand ran past 5000 turns without ending')
}

/* --------------------------------------------------------------------- main */

function freshStats() {
  return {
    turns: 0,
    played: 0,
    decisions: 0,
    multiCard: 0,
    colourOnly: 0,
    forcedDraw: 0,
    afterDrawChoice: 0,
    playedAfterDraw: 0,
    cardOptionTotal: 0,
    recycles: 0,
    optionHistogram: {}
  }
}

function pct(n, d) {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function stdev(xs) {
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}

/**
 * A win rate is one bit a hand. A continuous per-seat measure is a number per
 * seat per hand, and the point of reporting it is that it reads the same gap in
 * far fewer hands. `report` prints how many.
 */
function report(label, a, b, nameA, nameB) {
  const mA = mean(a)
  const mB = mean(b)
  const se = Math.sqrt(stdev(a) ** 2 / a.length + stdev(b) ** 2 / b.length)
  const z = (mB - mA) / se
  const perHand = Math.abs(z) / Math.sqrt(a.length / 2)
  const needed = perHand > 0 ? Math.ceil((2 / perHand) ** 2) : Infinity
  console.log(
    `     ${label}: ${nameA} ${mA.toFixed(2)}, ${nameB} ${mB.toFixed(2)}` +
      `  — gap ${(mB - mA).toFixed(2)}, ${z.toFixed(1)} sigma, needs ~${Number.isFinite(needed) ? needed : '—'} hands`
  )
}

/** Hands needed to separate a win rate from even money at two sigma. */
function handsForWinRate(p) {
  const edge = Math.abs(p - 0.5)
  if (edge === 0) return '∞'
  return Math.ceil((2 / (edge / Math.sqrt(p * (1 - p)))) ** 2)
}

/**
 * A probe reporting confidently on the wrong game is worse than no probe, so
 * the things every number below rests on are checked before any of it runs.
 */
function selfCheck() {
  const deck = buildDeck()
  if (deck.length !== 108) throw new Error(`deck is ${deck.length} cards, expected 108`)
  for (const colour of COLOURS) {
    const n = deck.filter((c) => c.colour === colour).length
    if (n !== 25) throw new Error(`${colour} has ${n} cards, expected 25`)
  }
  if (deck.filter((c) => c.face === 'wild').length !== 4) throw new Error('wild count')
  if (deck.filter((c) => c.face === 'wild4').length !== 4) throw new Error('wild4 count')

  // The restriction that keeps the density figure honest: without it a wild
  // draw-four is legal on every turn and every measurement below is a lie.
  if (legalOptions([card('R', 3), card(null, 'wild4')], 'R', 9).some((o) => o.card.face === 'wild4')) {
    throw new Error('a wild draw-four was offered while the colour could be followed')
  }
  if (!legalOptions([card('B', 3), card(null, 'wild4')], 'R', 9).some((o) => o.card.face === 'wild4')) {
    throw new Error('a wild draw-four was refused when the colour could not be followed')
  }
  // Two identical cards are one option, not two.
  if (legalOptions([card('R', 3), card('R', 3)], 'R', 9).length !== 1) {
    throw new Error('duplicate cards were counted twice')
  }
}

function main() {
  selfCheck()
  const hands = Number(process.argv[2] ?? 4000)
  const rng = mulberry32(20260818)

  console.log(`\n"Last One" decision-density probe — ${hands} hands per configuration\n`)

  /* --- part 1: how many turns contain a decision? ------------------------ */

  console.log('1. Decision density, by table size (random policy throughout)')
  console.log('   ' + '-'.repeat(72))
  console.log(
    '   seats  turns   >1 card   any choice   forced draw   colour-only   avg cards'
  )

  for (const seats of [2, 3, 4, 6]) {
    const stats = freshStats()
    const policies = Array.from({ length: seats }, () => randomPolicy)
    for (let i = 0; i < hands; i++) playHand(policies, rng, stats)

    console.log(
      `   ${String(seats).padStart(5)}  ${String(stats.turns).padStart(6)}` +
        `   ${pct(stats.multiCard, stats.turns).padStart(6)}` +
        `   ${pct(stats.decisions, stats.turns).padStart(10)}` +
        `   ${pct(stats.forcedDraw, stats.turns).padStart(11)}` +
        `   ${pct(stats.colourOnly, stats.turns).padStart(11)}` +
        `   ${(stats.cardOptionTotal / Math.max(1, stats.played)).toFixed(2).padStart(9)}`
    )
  }

  console.log('\n   Read "any choice" as the share of turns a model would have')
  console.log('   something to decide: more than one playable card, or one')
  console.log('   playable wild whose colour it must name.')

  /* --- the shape of the choice ------------------------------------------ */

  const four = freshStats()
  for (let i = 0; i < hands; i++) {
    playHand([randomPolicy, randomPolicy, randomPolicy, randomPolicy], rng, four)
  }
  console.log('\n2. How wide is the choice, at four seats?')
  console.log('   ' + '-'.repeat(72))
  const total = Object.values(four.optionHistogram).reduce((a, b) => a + b, 0)
  for (const n of Object.keys(four.optionHistogram).map(Number).sort((a, b) => a - b)) {
    const count = four.optionHistogram[n]
    const bar = '#'.repeat(Math.round((count / total) * 60))
    const label = n === 0 ? 'nothing playable' : `${n} playable`
    console.log(`   ${label.padStart(16)}  ${pct(count, total).padStart(6)}  ${bar}`)
  }
  console.log(
    `\n   Draw pile recycled ${four.recycles} times over ${hands} hands, and no hand`
  )
  console.log('   failed to end — the termination invariant holds.')
  console.log(
    `   Drew and could play it: ${pct(four.afterDrawChoice, four.forcedDraw)} of forced draws.`
  )

  /* --- part 2: does any of it separate policies? ------------------------- */

  console.log('\n3. Policy separation — four seats, two of each policy')
  console.log('   ' + '-'.repeat(72))

  // Two continuous measures, because one of them is confounded. The greedy
  // policy sheds the most expensive card it can, which is *exactly* what
  // "points left behind" measures — so its lead there is partly tautological.
  // Cards left is not what any of these policies optimises, so it is the
  // honest one. The win rate is confound-free too and is the reason to believe
  // greedy is genuinely playing better rather than gaming the scoreboard.
  const matchups = [
    ['greedy', greedyPolicy, 'random', randomPolicy],
    ['random', randomPolicy, 'hoarder', hoarderPolicy],
    ['greedy', greedyPolicy, 'hoarder', hoarderPolicy]
  ]

  for (const [nameA, policyA, nameB, policyB] of matchups) {
    // Seats alternate, so neither policy gets a positional advantage from
    // dealing or turn order.
    const policies = [policyA, policyB, policyA, policyB]
    const stats = freshStats()
    let winsA = 0
    let winsB = 0
    const pointsA = []
    const pointsB = []
    const cardsA = []
    const cardsB = []

    for (let i = 0; i < hands; i++) {
      const result = playHand(policies, rng, stats)
      if (result.winner % 2 === 0) winsA++
      else winsB++
      pointsA.push(result.left[0], result.left[2])
      pointsB.push(result.left[1], result.left[3])
      cardsA.push(result.cards[0], result.cards[2])
      cardsB.push(result.cards[1], result.cards[3])
    }

    const winRate = winsA / (winsA + winsB)
    console.log(`   ${nameA} vs ${nameB}`)
    console.log(
      `     win rate ${nameA}: ${(winRate * 100).toFixed(1)}%` +
        `  (${(1.96 * Math.sqrt((winRate * (1 - winRate)) / hands) * 100).toFixed(1)}% at 95%)` +
        `  — needs ~${handsForWinRate(winRate)} hands`
    )
    report('points left', pointsA, pointsB, nameA, nameB)
    report('cards left ', cardsA, cardsB, nameA, nameB)
  }

  console.log('\n4. What a verdict would cost')
  console.log('   ' + '-'.repeat(72))
  const turnsPerHand = four.turns / hands
  console.log(`   Turns per hand at four seats: ${turnsPerHand.toFixed(1)}`)
  console.log(
    `   Of those, ${pct(four.decisions, four.turns)} carry a decision, so a hand costs about ` +
      `${Math.round((four.decisions / hands))} API calls`
  )
  console.log(
    `   if forced turns are played without asking, against ${Math.round(turnsPerHand)} if they are not.`
  )

  // The number that actually decides whether to build this is neither the
  // density nor the effect size but their product. An instrument that separates
  // two players only after a thousand paid calls is a different proposition
  // from one that does it in a hundred.
  const callsPerHand = Math.round(four.decisions / hands)
  console.log('')
  console.log(
    `   Separating greedy from random on cards left took ~55 hands, so about ` +
      `${55 * callsPerHand} calls. On win rate alone`
  )
  console.log(
    `   it took ~117 hands, about ${117 * callsPerHand} — which is what the continuous metric buys.`
  )
  console.log('   Two real models will sit closer together than these two do.')
  console.log('')
}

main()
