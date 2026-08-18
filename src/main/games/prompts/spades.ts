import { cardCode, sameCard, type Card } from '../../../shared/cards.ts'
import type { SpadesPlayer, SpadesRules, SpadesState, SpadesTrick } from '../../../shared/types.ts'
import { BAGS_PER_PENALTY, TRICKS_PER_HAND, TRUMP } from '../spades/engine.ts'
import {
  extractJson,
  NOTATION,
  notJson,
  parseCardCode,
  readReasoning,
  suitWord,
  type ParseOutcome,
  type Prompt
} from './shared.ts'

/**
 * The rules, stated in force.
 *
 * Spades is less standardised than Hearts, not more: how a nil bidder's tricks
 * are counted, whether a set team keeps its bags, and what ten bags costs are
 * all genuine disagreements between tables. A model that guesses differently is
 * playing a different game from the one being dealt, so every one of them is
 * spelled out here rather than assumed.
 */
export function spadesSystemPrompt(rules: SpadesRules): string {
  return [
    'You are playing partnership Spades against two opponents, with one partner.',
    '',
    '**You and your partner win or lose together.** Your partnership has one score.',
    'You may NOT talk to your partner, signal, or agree anything. Everything you know',
    'about their hand you have to infer from their bid and from the cards they play.',
    '',
    'Rules in force at this table:',
    '- Four players, 13 cards each, the whole deck. Partners sit opposite each other.',
    '- **Spades are always trump.** Any spade beats any card of any other suit.',
    '- You must follow the suit led if you hold it. If you are void you may play',
    '  anything, trumps included.',
    '- The highest spade wins the trick; with no spade in it, the highest card of the',
    '  suit led. The winner leads the next trick.',
    '- Spades may not be LED until a spade has been played on an earlier trick',
    '  ("breaking spades"). If spades are all you hold, you may lead one anyway.',
    '',
    'Bidding, before any card is played:',
    `- Each player bids how many of the ${TRICKS_PER_HAND} tricks they expect to take, in turn.`,
    '  Bids do NOT have to add up to 13 — under- and over-bidding are both ordinary.',
    '- Your partnership\'s contract is **your bid plus your partner\'s bid**.',
    '- **Making the contract scores 10 points per trick bid.** Failing it — taking even',
    '  one trick fewer than the two of you bid — scores MINUS 10 per trick bid.',
    '- Every trick over the contract is a "bag": 1 point each, which sounds good and',
    `  is not. **Every ${BAGS_PER_PENALTY} bags your partnership collects costs it 100 points.**`,
    '  Bags carry over from hand to hand. Overbidding slightly is safer than sandbagging.',
    '- A set partnership takes no bags at all; it simply loses 10 a trick bid.',
    '',
    'Nil:',
    '- **A bid of 0 is a NIL bid**: a promise to take NO tricks at all this hand.',
    '  Bringing it home is +100 to your partnership. Taking even one trick is −100.',
    '- A nil adds nothing to the contract, so your partner\'s bid has to stand alone.',
    '- **A trick a nil bidder takes still counts towards the partnership\'s contract**',
    '  as well as breaking the nil.',
    '- If your hand is weak but you cannot honestly promise zero tricks, bid 1, not 0.',
    '- Blind nil is not offered at this table.',
    '',
    `- The match ends when a partnership reaches ${rules.targetScore} points.` +
      (rules.bustScore < 0 ? ` A partnership that falls to ${rules.bustScore} loses at once.` : ''),
    '',
    NOTATION,
    '',
    'Reply with a single JSON object and nothing else. No prose outside it.'
  ].join('\n')
}

/** Everyone's bid and tricks so far — the only thing a partner can be read from. */
function tableBlock(state: SpadesState, player: SpadesPlayer): string[] {
  const partnerIndex = (player.seatIndex + 2) % state.players.length
  const lines = ['', 'At the table:']
  for (const other of state.players) {
    const role =
      other.seatIndex === player.seatIndex
        ? 'you'
        : other.seatIndex === partnerIndex
          ? 'YOUR PARTNER'
          : 'opponent'
    const bid =
      other.bid === null
        ? 'has not bid yet'
        : other.bid === 0
          ? 'bid NIL'
          : `bid ${other.bid}`
    lines.push(`- ${other.name} (${role}): ${bid}, has taken ${other.tricksWon} trick${other.tricksWon === 1 ? '' : 's'}`)
  }
  return lines
}

/** Both partnerships' running position, bags included, because bags bite later. */
function scoreBlock(state: SpadesState, player: SpadesPlayer): string[] {
  const lines = ['', 'Match score:']
  for (const team of state.teams) {
    const yours = team.index === player.teamIndex ? ' — YOUR partnership' : ''
    const names = team.seatIndices.map((i) => state.players[i].name).join(' & ')
    const toPenalty = BAGS_PER_PENALTY - team.bags
    lines.push(
      `- ${team.name} (${names}): ${team.score} points, ${team.bags} bag${team.bags === 1 ? '' : 's'}` +
        `${yours}. ${toPenalty} more bag${toPenalty === 1 ? '' : 's'} would cost 100 points.`
    )
  }
  return lines
}

export function buildSpadesBidPrompt(
  state: SpadesState,
  player: SpadesPlayer,
  rules: SpadesRules
): Prompt {
  const lines: string[] = []
  const partner = state.players[(player.seatIndex + 2) % state.players.length]

  lines.push(`Hand ${state.handNumber}. Bidding.`)
  lines.push('')
  lines.push(`Your hand (${player.hand.length} cards): ${player.hand.map(cardCode).join(' ')}`)
  lines.push(`Spades held: ${player.hand.filter((c) => c.suit === TRUMP).length}`)
  lines.push(...tableBlock(state, player))

  // Bidding order is the whole information structure of this decision: a seat
  // bidding last knows its partner's bid, a seat bidding first does not. Say
  // which case this is rather than leaving it to be worked out.
  const before = state.players.filter((p) => p.bid !== null).length
  if (partner.bid === null) {
    lines.push('')
    lines.push(
      `Your partner ${partner.name} has NOT bid yet, so you are committing first. ` +
        'Whatever you bid, they have to build the contract on top of it.'
    )
  } else {
    lines.push('')
    lines.push(
      `Your partner ${partner.name} bid ${partner.bid === 0 ? 'NIL' : partner.bid}. ` +
        (partner.bid === 0
          ? 'They are trying to take nothing at all — the contract rests entirely on your bid, ' +
            'and you will want high cards to cover them.'
          : `Your bid is added to theirs, so bidding N makes the contract ${partner.bid} + N.`)
    )
  }
  lines.push(`${before} of ${state.players.length} players have bid so far.`)

  lines.push(...scoreBlock(state, player))
  lines.push('')
  lines.push(`How many tricks do you bid? A whole number from 0 to ${TRICKS_PER_HAND}.`)
  lines.push('Remember that 0 means NIL — a promise to take no tricks, worth ±100.')
  lines.push('')
  lines.push('Reply with a single JSON object and nothing else:')
  lines.push('{"reasoning": "<one or two short sentences>", "bid": <number>}')

  return { system: spadesSystemPrompt(rules), user: lines.join('\n') }
}

/** Reads a whole number of tricks, 0..13. Zero is nil and is accepted as such. */
export function parseSpadesBidReply(text: string): ParseOutcome<number> {
  const obj = extractJson(text)
  if (!obj) return notJson()
  const reasoning = readReasoning(obj)

  const raw = obj.bid ?? obj.tricks ?? obj.contract ?? obj.call
  // A model writing "nil" instead of 0 has said exactly what it means, and
  // rejecting it would spend a retry on a spelling.
  if (typeof raw === 'string' && /^nil$/i.test(raw.trim())) {
    return { ok: true, value: 0, reasoning }
  }
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(value)) {
    return { ok: false, reasoning, problem: 'Your JSON needs a "bid" number, such as 3 (or 0 for nil).' }
  }
  if (!Number.isInteger(value) || value < 0 || value > TRICKS_PER_HAND) {
    return {
      ok: false,
      reasoning,
      problem: `A bid is a whole number of tricks from 0 to ${TRICKS_PER_HAND}; you said ${raw}.`
    }
  }
  return { ok: true, value, reasoning }
}

/** One line per completed trick: who played what, and who took it. */
function trickHistory(state: SpadesState, tricks: SpadesTrick[]): string[] {
  if (tricks.length === 0) return []
  const name = (seatIndex: number): string => state.players[seatIndex].name
  const lines = ['', 'Tricks so far this hand:']
  for (const trick of tricks) {
    const played = trick.plays.map((p) => `${name(p.seatIndex)} ${cardCode(p.card)}`).join(', ')
    lines.push(`  Trick ${trick.number}: ${played} — ${trick.winnerName ?? '?'} takes it`)
  }
  return lines
}

export function buildSpadesPlayPrompt(
  state: SpadesState,
  player: SpadesPlayer,
  legal: Card[],
  tricks: SpadesTrick[],
  rules: SpadesRules
): Prompt {
  const trick = state.currentTrick
  const leading = !trick || trick.plays.length === 0
  const team = state.teams[player.teamIndex]
  const partner = state.players[(player.seatIndex + 2) % state.players.length]
  const lines: string[] = []

  lines.push(`Hand ${state.handNumber}, trick ${state.trickNumber} of ${TRICKS_PER_HAND}.`)
  lines.push(`Your hand: ${player.hand.map(cardCode).join(' ')}`)
  lines.push('')

  if (leading) {
    lines.push('You are on lead — the trick is yours to open.')
  } else {
    const played = trick.plays
      .map((p) => {
        const who = state.players[p.seatIndex]
        const tag =
          who.seatIndex === partner.seatIndex ? ' [your partner]' : ' [opponent]'
        return `${who.name}${tag} played ${cardCode(p.card)}`
      })
      .join(', ')
    lines.push(`This trick so far (${suitWord(trick.leadSuit)} led): ${played}.`)

    // Who is currently taking it is derivable from the cards, but it is the
    // single fact this decision turns on — whether the trick is already your
    // partner's — so it is stated rather than left to be worked out under a
    // token budget.
    const best = bestSoFar(trick)
    if (best) {
      const who = state.players[best.seatIndex]
      const whose =
        who.seatIndex === player.seatIndex
          ? 'you are'
          : who.seatIndex === partner.seatIndex
            ? `your PARTNER ${who.name} is`
            : `opponent ${who.name} is`
      lines.push(`${whose} winning it at the moment, with ${cardCode(best.card)}.`)
    }
  }

  lines.push('')
  lines.push(
    state.spadesBroken
      ? 'Spades have been broken, so spades may be led.'
      : 'Spades have NOT been broken yet, so spades may not be led.'
  )

  lines.push(...tableBlock(state, player))

  // The contract arithmetic. Every term of it is already above, but a model
  // spending its budget re-deriving "how many more do we need" is spending it
  // on the wrong thing — the same argument as quoting pot odds at poker.
  lines.push('')
  const nilPartner = partner.bid === 0
  const needed = team.contract - team.tricksWon
  // The trick being played right now counts as still to play.
  const remaining = TRICKS_PER_HAND - state.trickNumber + 1
  lines.push(
    `Your partnership bid ${team.contract} and has taken ${team.tricksWon}. ` +
      (needed > 0
        ? `You need ${needed} more from the ${remaining} still to play.`
        : needed === 0
          ? 'The contract is exactly made — every further trick is a bag.'
          : `The contract is made with ${-needed} over; those are bags.`)
  )
  if (player.bid === 0) {
    lines.push(
      `**You bid NIL.** You must take NO tricks. Taking this one costs your ` +
        'partnership 100 points, so play under the cards on the table if you can.'
    )
  }
  if (nilPartner) {
    lines.push(
      `**Your partner ${partner.name} bid NIL** and has taken ${partner.tricksWon} so far. ` +
        (partner.tricksWon === 0
          ? 'Their nil is still alive; anything you can take is a trick they cannot be forced into.'
          : 'Their nil is already broken.')
    )
  }

  lines.push(...trickHistory(state, tricks))
  lines.push(...scoreBlock(state, player))

  lines.push('')
  lines.push(`Legal plays: ${legal.map(cardCode).join(', ')}`)
  lines.push('')
  lines.push('Which card do you play?')
  lines.push('')
  lines.push('Reply with a single JSON object and nothing else:')
  lines.push('{"reasoning": "<one or two short sentences>", "card": "<one card code, e.g. Qs>"}')

  return { system: spadesSystemPrompt(rules), user: lines.join('\n') }
}

/** Who is taking the trick as it currently stands. Undefined before the lead. */
function bestSoFar(trick: SpadesTrick): SpadesTrick['plays'][number] | undefined {
  if (trick.plays.length === 0) return undefined
  const trumped = trick.plays.some((p) => p.card.suit === TRUMP)
  const suit = trumped ? TRUMP : trick.leadSuit
  let best: SpadesTrick['plays'][number] | undefined
  for (const play of trick.plays) {
    if (play.card.suit !== suit) continue
    if (!best || play.card.rank > best.card.rank) best = play
  }
  return best
}

export function parseSpadesPlayReply(text: string, legal: Card[]): ParseOutcome<Card> {
  const obj = extractJson(text)
  if (!obj) return notJson()
  const reasoning = readReasoning(obj)

  const raw = obj.card ?? obj.play ?? obj.action ?? obj.move
  if (typeof raw !== 'string') {
    return { ok: false, reasoning, problem: 'Your JSON needs a "card" string, such as "Qs".' }
  }
  const card = parseCardCode(raw)
  if (!card) {
    return {
      ok: false,
      reasoning,
      problem: `"${raw}" is not a card code. Choose one of: ${legal.map(cardCode).join(', ')}.`
    }
  }
  if (!legal.some((c) => sameCard(c, card))) {
    return {
      ok: false,
      reasoning,
      problem: `${cardCode(card)} is not a legal play right now. Choose one of: ${legal.map(cardCode).join(', ')}.`
    }
  }
  return { ok: true, value: card, reasoning }
}
