import { cardCode } from '../../../shared/cards.ts'
import type {
  BlackjackAction,
  BlackjackHand,
  BlackjackPlayer,
  BlackjackRules,
  BlackjackState
} from '../../../shared/types.ts'
import { describeValue, handValue } from '../blackjack.ts'
import { extractJson, NOTATION, notJson, readReasoning, type ParseOutcome, type Prompt } from './shared.ts'

export function blackjackSystemPrompt(rules: BlackjackRules, tableSize = 1): string {
  const lines = [
    tableSize > 1
      ? `You are a skilled blackjack player at a casino table with ${tableSize - 1} other ` +
        'players. Everyone plays against the dealer, never against each other.'
      : 'You are a skilled blackjack player seated at a casino table, playing against the dealer.',
    '',
    'House rules:',
    `- ${rules.deckCount}-deck shoe, reshuffled roughly three quarters of the way through.`,
    ...(tableSize > 1
      ? [
          '- Every seat is dealt from the same shoe, and all player cards are dealt FACE UP.',
          "  You are shown the other players' cards; use them to judge what is left in the shoe."
        ]
      : []),
    `- The dealer ${rules.dealerHitsSoft17 ? 'hits' : 'stands on'} soft 17.`,
    `- A natural blackjack pays ${rules.blackjackPayout === 1.5 ? '3:2' : `${rules.blackjackPayout}:1`}.`,
    '- You may double down on your first two cards' +
      (rules.doubleAfterSplit ? ', including after a split.' : ', but not after a split.'),
    `- You may split pairs up to ${rules.maxSplits} times. Split aces get exactly one card each.`,
    rules.offerInsurance
      ? '- When the dealer shows an ace you are offered insurance: a side bet of half your stake that pays 2:1 if the dealer has blackjack.'
      : '- Insurance is not offered.',
    '- Surrender is not offered.',
    '',
    NOTATION,
    '',
    'Think about basic strategy and the cards you have seen, then answer.',
    'Reply with a single JSON object and nothing else, in exactly this shape:',
    '{"reasoning": "<one or two short sentences>", "action": "<your chosen action>"}',
    'The "action" value must be exactly one of the legal actions you are given.'
  ]
  return lines.join('\n')
}

function handSummary(hand: BlackjackHand): string {
  const status = hand.status === 'active' ? 'to act' : hand.status
  return `${hand.cards.map(cardCode).join(' ')} (${describeValue(hand.cards)}) — bet ${hand.bet}, ${status}`
}

/**
 * The other seats' cards. They are dealt face up at a shoe game, and showing
 * them is a deliberate departure from the poker rule that a model sees only its
 * own cards: nobody at blackjack is hiding anything, and what the other seats
 * have burned is the whole reason for running several models on one shoe.
 */
function otherSeats(state: BlackjackState, player: BlackjackPlayer): string[] {
  const others = state.players.filter((p) => p.id !== player.id && p.hands.length > 0)
  if (others.length === 0) return []

  const lines = ['', 'Other players at this table (all cards are dealt face up):']
  for (const other of others) {
    if (other.hands.length === 1) {
      lines.push(`- ${other.name}: ${handSummary(other.hands[0])}`)
    } else {
      lines.push(`- ${other.name}, split into ${other.hands.length} hands:`)
      for (const hand of other.hands) lines.push(`    ${handSummary(hand)}`)
    }
  }
  return lines
}

export function blackjackUserPrompt(
  state: BlackjackState,
  player: BlackjackPlayer,
  legal: BlackjackAction[]
): string {
  const hand = player.hands[player.activeHandIndex]
  const upcard = state.dealerCards[0]
  const lines: string[] = []

  lines.push(`Round ${state.roundNumber}. Your bankroll: ${player.bankroll} chips.`)
  lines.push(`Cards left in the shoe: about ${state.shoeRemaining}.`)
  if (state.shoeJustShuffled) lines.push('The shoe was just reshuffled, so no cards have been seen yet.')
  lines.push('')
  lines.push(`Dealer shows: ${cardCode(upcard)}`)

  if (player.hands.length > 1) {
    lines.push('')
    lines.push(`You have split into ${player.hands.length} hands:`)
    player.hands.forEach((h, i) => {
      const marker = i === player.activeHandIndex ? '>' : ' '
      lines.push(`${marker} Hand ${i + 1}: ${handSummary(h)}`)
    })
    lines.push('')
    lines.push(`You are deciding for hand ${player.activeHandIndex + 1}.`)
  } else {
    lines.push(`Your hand: ${hand.cards.map(cardCode).join(' ')} (${describeValue(hand.cards)})`)
    lines.push(`Your bet: ${hand.bet} chips.`)
  }

  const { total, soft } = handValue(hand.cards)
  if (soft && total <= 21) {
    lines.push(`That is a soft ${total}: it cannot bust on the next card.`)
  }

  lines.push(...otherSeats(state, player))

  lines.push('')
  lines.push(`Legal actions: ${legal.join(', ')}`)
  if (legal.includes('double')) {
    lines.push(`Doubling costs another ${hand.bet} chips and gives you exactly one more card.`)
  }
  if (legal.includes('split')) {
    lines.push(`Splitting costs another ${hand.bet} chips and turns your pair into two hands.`)
  }
  lines.push('')
  lines.push('What is your move?')
  return lines.join('\n')
}

export function buildBlackjackPrompt(
  state: BlackjackState,
  player: BlackjackPlayer,
  legal: BlackjackAction[],
  rules: BlackjackRules
): Prompt {
  return {
    system: blackjackSystemPrompt(rules, state.players.length),
    user: blackjackUserPrompt(state, player, legal)
  }
}

/** Asked when the dealer's upcard is an ace, before the dealer peeks. */
export function buildBlackjackInsurancePrompt(
  state: BlackjackState,
  player: BlackjackPlayer,
  cost: number,
  rules: BlackjackRules
): Prompt {
  const hand = player.hands[0]
  const lines: string[] = []

  lines.push(`Round ${state.roundNumber}. The dealer's upcard is an ace.`)
  lines.push('')
  lines.push(`Your hand: ${hand.cards.map(cardCode).join(' ')} (${describeValue(hand.cards)})`)
  lines.push(`Your stake: ${hand.bet} chips. Bankroll: ${player.bankroll} chips.`)
  // The face-up table matters most here: every ten already out is one that
  // cannot be under the ace.
  lines.push(...otherSeats(state, player))
  lines.push('')
  lines.push(`Insurance costs ${cost} chips, half your stake.`)
  lines.push('It pays 2:1 if the dealer has blackjack, and is lost otherwise.')
  lines.push(`Cards left in the shoe: about ${state.shoeRemaining} of ${rules.deckCount * 52}.`)
  lines.push('')
  lines.push('Do you take insurance?')
  lines.push('')
  lines.push('Reply with a single JSON object and nothing else:')
  lines.push('{"reasoning": "<one short sentence>", "insurance": true or false}')

  return { system: blackjackSystemPrompt(rules, state.players.length), user: lines.join('\n') }
}

export function parseBlackjackInsuranceReply(text: string): ParseOutcome<boolean> {
  const obj = extractJson(text)
  if (!obj) return notJson()
  const reasoning = readReasoning(obj)
  const raw = obj.insurance ?? obj.take_insurance ?? obj.takeInsurance ?? obj.answer ?? obj.action

  if (typeof raw === 'boolean') return { ok: true, value: raw, reasoning }
  if (typeof raw === 'string') {
    const word = raw.trim().toLowerCase().replace(/[^a-z]/g, '')
    if (['yes', 'true', 'take', 'takeinsurance', 'insure', 'insurance', 'y'].includes(word)) {
      return { ok: true, value: true, reasoning }
    }
    if (['no', 'false', 'decline', 'declineinsurance', 'skip', 'pass', 'n', 'none'].includes(word)) {
      return { ok: true, value: false, reasoning }
    }
  }
  return {
    ok: false,
    reasoning,
    problem: 'Your JSON needs an "insurance" field set to true or false.'
  }
}

/** Asked before the deal when the model sizes its own wagers. */
export function buildBlackjackBetPrompt(
  state: BlackjackState,
  player: BlackjackPlayer,
  limits: { min: number; max: number },
  rules: BlackjackRules
): Prompt {
  const lines: string[] = []
  lines.push(`You are about to play round ${state.roundNumber + 1}. Decide how much to wager.`)
  lines.push('')
  lines.push(`Bankroll: ${player.bankroll} chips.`)
  lines.push(`Table minimum: ${limits.min}. Most you may wager: ${limits.max} (your whole bankroll).`)

  if (player.roundsPlayed > 0) {
    lines.push('')
    lines.push(
      `So far: ${player.roundsPlayed} rounds, ${player.handsWon} won, ${player.handsLost} lost, ` +
        `${player.handsPushed} pushed, ${player.blackjacks} blackjacks, ${player.busts} busts.`
    )
    lines.push(`Net for the session: ${player.sessionNet >= 0 ? '+' : ''}${player.sessionNet} chips.`)
    if (player.lastRoundNet !== 0) {
      lines.push(`Last round: ${player.lastRoundNet > 0 ? 'won' : 'lost'} ${Math.abs(player.lastRoundNet)}.`)
    }
  }

  lines.push('')
  lines.push(`Cards left in the shoe: about ${state.shoeRemaining} of ${rules.deckCount * 52}.`)
  if (state.shoeJustShuffled) lines.push('The shoe was just reshuffled.')

  lines.push('')
  lines.push('Bust your bankroll and the session is over, so size the bet to survive a losing streak.')
  lines.push('')
  lines.push('Reply with a single JSON object and nothing else:')
  lines.push('{"reasoning": "<one short sentence>", "bet": <whole number of chips>}')

  return {
    system: blackjackSystemPrompt(rules, state.players.length),
    user: lines.join('\n')
  }
}

/** Reads a wager out of a model reply, clamped into the legal band. */
export function parseBlackjackBetReply(
  text: string,
  limits: { min: number; max: number }
): ParseOutcome<number> {
  const obj = extractJson(text)
  if (!obj) return notJson()
  const reasoning = readReasoning(obj)
  const raw = obj.bet ?? obj.wager ?? obj.amount ?? obj.stake
  const value = typeof raw === 'number' ? raw : Number(raw)

  if (!Number.isFinite(value)) {
    return {
      ok: false,
      reasoning,
      problem: `Your JSON needs a numeric "bet" between ${limits.min} and ${limits.max}.`
    }
  }
  const clamped = Math.max(limits.min, Math.min(Math.round(value), limits.max))
  return { ok: true, value: clamped, reasoning }
}

export function parseBlackjackReply(
  text: string,
  legal: BlackjackAction[]
): ParseOutcome<BlackjackAction> {
  const obj = extractJson(text)
  if (!obj) return notJson()
  const reasoning = readReasoning(obj)
  const rawAction = obj.action ?? obj.move ?? obj.decision
  if (typeof rawAction !== 'string') {
    return { ok: false, reasoning, problem: 'Your JSON had no "action" string.' }
  }

  const normalised = rawAction.trim().toLowerCase().replace(/[^a-z]/g, '')
  const aliases: Record<string, BlackjackAction> = {
    hit: 'hit', draw: 'hit', hitme: 'hit',
    stand: 'stand', stay: 'stand', stick: 'stand', pass: 'stand',
    double: 'double', doubledown: 'double', dd: 'double',
    split: 'split', splitpair: 'split'
  }
  const action = aliases[normalised]
  if (!action) {
    return { ok: false, reasoning, problem: `"${rawAction}" is not an action. Choose one of: ${legal.join(', ')}.` }
  }
  if (!legal.includes(action)) {
    return { ok: false, reasoning, problem: `"${action}" is not legal right now. Choose one of: ${legal.join(', ')}.` }
  }
  return { ok: true, value: action, reasoning }
}
