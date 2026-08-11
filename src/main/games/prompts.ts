import { cardCode } from '../../shared/cards.ts'
import type {
  BlackjackAction,
  BlackjackRules,
  BlackjackState,
  PokerAction,
  PokerRules,
  PokerSeat
} from '../../shared/types.ts'
import { describeValue, handValue } from './blackjack.ts'
import type { LegalActions } from './poker/engine.ts'
import type { PokerTable } from './poker/engine.ts'

export interface Prompt {
  system: string
  user: string
}

const NOTATION =
  'Card notation is rank followed by suit: "As" = ace of spades, "Td" = ten of diamonds, ' +
  '"9c" = nine of clubs, "2h" = two of hearts. Suits are s=spades, h=hearts, d=diamonds, c=clubs.'

/* -------------------------------------------------------------- blackjack */

export function blackjackSystemPrompt(rules: BlackjackRules): string {
  const lines = [
    'You are a skilled blackjack player seated at a casino table, playing against the dealer.',
    '',
    'House rules:',
    `- ${rules.deckCount}-deck shoe, reshuffled roughly three quarters of the way through.`,
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

export function blackjackUserPrompt(
  state: BlackjackState,
  legal: BlackjackAction[]
): string {
  const hand = state.hands[state.activeHandIndex]
  const upcard = state.dealerCards[0]
  const lines: string[] = []

  lines.push(`Round ${state.roundNumber}. Your bankroll: ${state.bankroll} chips.`)
  lines.push(`Cards left in the shoe: about ${state.shoeRemaining}.`)
  if (state.shoeJustShuffled) lines.push('The shoe was just reshuffled, so no cards have been seen yet.')
  lines.push('')
  lines.push(`Dealer shows: ${cardCode(upcard)}`)

  if (state.hands.length > 1) {
    lines.push('')
    lines.push(`You have split into ${state.hands.length} hands:`)
    state.hands.forEach((h, i) => {
      const marker = i === state.activeHandIndex ? '>' : ' '
      const status = h.status === 'active' ? 'to act' : h.status
      lines.push(`${marker} Hand ${i + 1}: ${h.cards.map(cardCode).join(' ')} (${describeValue(h.cards)}) — bet ${h.bet}, ${status}`)
    })
    lines.push('')
    lines.push(`You are deciding for hand ${state.activeHandIndex + 1}.`)
  } else {
    lines.push(`Your hand: ${hand.cards.map(cardCode).join(' ')} (${describeValue(hand.cards)})`)
    lines.push(`Your bet: ${hand.bet} chips.`)
  }

  const { total, soft } = handValue(hand.cards)
  if (soft && total <= 21) {
    lines.push(`That is a soft ${total}: it cannot bust on the next card.`)
  }

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
  legal: BlackjackAction[],
  rules: BlackjackRules
): Prompt {
  return { system: blackjackSystemPrompt(rules), user: blackjackUserPrompt(state, legal) }
}

/** Asked when the dealer's upcard is an ace, before the dealer peeks. */
export function buildBlackjackInsurancePrompt(
  state: BlackjackState,
  cost: number,
  rules: BlackjackRules
): Prompt {
  const hand = state.hands[0]
  const lines: string[] = []

  lines.push(`Round ${state.roundNumber}. The dealer's upcard is an ace.`)
  lines.push('')
  lines.push(`Your hand: ${hand.cards.map(cardCode).join(' ')} (${describeValue(hand.cards)})`)
  lines.push(`Your stake: ${hand.bet} chips. Bankroll: ${state.bankroll} chips.`)
  lines.push('')
  lines.push(`Insurance costs ${cost} chips, half your stake.`)
  lines.push('It pays 2:1 if the dealer has blackjack, and is lost otherwise.')
  lines.push(`Cards left in the shoe: about ${state.shoeRemaining} of ${rules.deckCount * 52}.`)
  lines.push('')
  lines.push('Do you take insurance?')
  lines.push('')
  lines.push('Reply with a single JSON object and nothing else:')
  lines.push('{"reasoning": "<one short sentence>", "insurance": true or false}')

  return { system: blackjackSystemPrompt(rules), user: lines.join('\n') }
}

export function parseBlackjackInsuranceReply(text: string): ParseOutcome<boolean> {
  const obj = extractJson(text)
  if (!obj) {
    return { ok: false, reasoning: '', problem: 'Your reply was not valid JSON. Reply with only a JSON object.' }
  }
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
  limits: { min: number; max: number },
  rules: BlackjackRules
): Prompt {
  const lines: string[] = []
  lines.push(`You are about to play round ${state.roundNumber + 1}. Decide how much to wager.`)
  lines.push('')
  lines.push(`Bankroll: ${state.bankroll} chips.`)
  lines.push(`Table minimum: ${limits.min}. Most you may wager: ${limits.max} (your whole bankroll).`)

  if (state.roundsPlayed > 0) {
    lines.push('')
    lines.push(
      `So far: ${state.roundsPlayed} rounds, ${state.handsWon} won, ${state.handsLost} lost, ` +
        `${state.handsPushed} pushed, ${state.blackjacks} blackjacks, ${state.busts} busts.`
    )
    lines.push(`Net for the session: ${state.sessionNet >= 0 ? '+' : ''}${state.sessionNet} chips.`)
    if (state.lastRoundNet !== 0) {
      lines.push(`Last round: ${state.lastRoundNet > 0 ? 'won' : 'lost'} ${Math.abs(state.lastRoundNet)}.`)
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
    system: blackjackSystemPrompt(rules),
    user: lines.join('\n')
  }
}

/** Reads a wager out of a model reply, clamped into the legal band. */
export function parseBlackjackBetReply(
  text: string,
  limits: { min: number; max: number }
): ParseOutcome<number> {
  const obj = extractJson(text)
  if (!obj) {
    return { ok: false, reasoning: '', problem: 'Your reply was not valid JSON. Reply with only a JSON object.' }
  }
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

/* ------------------------------------------------------------------ poker */

export function pokerSystemPrompt(
  seat: PokerSeat,
  playerCount: number,
  rules: PokerRules
): string {
  return [
    `You are "${seat.name}", playing No-Limit Texas Hold'em against ${playerCount - 1} other AI players.`,
    `Every player started with ${rules.startingStack} chips. Blinds began at ${rules.smallBlind}/${rules.bigBlind}.`,
    'A player knocked out of chips is eliminated; the last player with chips wins.',
    'Every hand is dealt from a freshly shuffled 52-card deck, so cards seen in',
    'earlier hands tell you nothing about this one.',
    '',
    NOTATION,
    '',
    'Betting notes:',
    '- "raise" means the total number of chips your bet for this street is raised TO, not the extra amount you add.',
    '- You may only "check" when there is nothing to call.',
    '- Going all-in is a raise to your maximum.',
    '',
    'Play to win chips. Consider your hand strength, position, pot odds, stack sizes and how',
    'your opponents have been betting. Bluffing is allowed.',
    '',
    'Reply with a single JSON object and nothing else, in exactly this shape:',
    '{"reasoning": "<one or two short sentences>", "action": "fold" | "check" | "call" | "raise", "amount": <number, only when raising>}'
  ].join('\n')
}

export function positionLabel(table: PokerTable, seatIndex: number): string {
  const s = table.state
  const live = s.seats.filter((seat) => !seat.busted)
  const headsUp = live.length === 2
  const order = (index: number): number => {
    const n = s.seats.length
    return (index - s.buttonIndex + n) % n
  }
  const liveAfterButton = live
    .slice()
    .sort((a, b) => order(a.seatIndex) - order(b.seatIndex))

  const sbIndex = headsUp ? s.buttonIndex : liveAfterButton[1]?.seatIndex
  const bbIndex = headsUp
    ? liveAfterButton[1]?.seatIndex
    : liveAfterButton[2]?.seatIndex

  if (seatIndex === s.buttonIndex) return headsUp ? 'button / small blind' : 'button'
  if (seatIndex === sbIndex) return 'small blind'
  if (seatIndex === bbIndex) return 'big blind'
  return `seat ${order(seatIndex)} after the button`
}

export function pokerUserPrompt(
  table: PokerTable,
  seatIndex: number,
  legal: LegalActions,
  history: string[]
): string {
  const s = table.state
  const seat = s.seats[seatIndex]
  const lines: string[] = []

  lines.push(`Hand ${s.handNumber}, ${s.street}. Blinds ${s.smallBlind}/${s.bigBlind}.`)
  lines.push(`You are in the ${positionLabel(table, seatIndex)}.`)
  lines.push('')
  lines.push(`Your cards: ${seat.cards.map(cardCode).join(' ')}`)
  lines.push(`Board: ${s.board.length ? s.board.map(cardCode).join(' ') : '(no community cards yet)'}`)
  lines.push(`Pot: ${s.pot} chips.`)
  lines.push(`Your stack: ${seat.stack} chips (you have put in ${seat.totalCommitted} this hand).`)
  lines.push('')

  lines.push('Players still in the hand:')
  const ordered = s.seats
    .filter((other) => !other.busted)
    .slice()
    .sort((a, b) => {
      const n = s.seats.length
      return ((a.seatIndex - s.buttonIndex + n) % n) - ((b.seatIndex - s.buttonIndex + n) % n)
    })
  for (const other of ordered) {
    const you = other.seatIndex === seatIndex ? ' (you)' : ''
    const state = other.folded
      ? 'folded'
      : other.allIn
        ? `ALL-IN for ${other.totalCommitted}`
        : `stack ${other.stack}`
    const bet = other.committed > 0 ? `, ${other.committed} in front` : ''
    lines.push(`- ${other.name}${you}: ${state}${bet}`)
  }

  if (history.length) {
    lines.push('')
    lines.push('Action so far this hand:')
    for (const line of history) lines.push(`  ${line}`)
  }

  lines.push('')
  const options: string[] = ['fold']
  if (legal.canCheck) options.push('check')
  if (legal.canCall) {
    options.push(`call ${legal.callAmount}${legal.callIsAllIn ? ' (all-in)' : ''}`)
  }
  if (legal.canRaise) {
    options.push(
      legal.minRaiseTo === legal.maxRaiseTo
        ? `raise to ${legal.maxRaiseTo} (all-in)`
        : `raise to any amount from ${legal.minRaiseTo} to ${legal.maxRaiseTo}`
    )
  }
  lines.push(`Legal actions: ${options.join(', ')}`)

  if (legal.canCall && legal.callAmount > 0) {
    const odds = legal.callAmount / (s.pot + legal.callAmount)
    lines.push(`Calling ${legal.callAmount} into a pot of ${s.pot} needs about ${(odds * 100).toFixed(0)}% equity to break even.`)
  }
  lines.push('')
  lines.push('What is your move?')
  return lines.join('\n')
}

export function buildPokerPrompt(
  table: PokerTable,
  seatIndex: number,
  legal: LegalActions,
  history: string[],
  rules: PokerRules
): Prompt {
  const seat = table.state.seats[seatIndex]
  const playerCount = table.state.seats.filter((s) => !s.busted).length
  return {
    system: pokerSystemPrompt(seat, playerCount, rules),
    user: pokerUserPrompt(table, seatIndex, legal, history)
  }
}

/* ---------------------------------------------------------------- parsing */

export interface ParsedReply {
  reasoning: string
  raw: Record<string, unknown>
}

/**
 * Pulls a JSON object out of a model reply. Handles fenced code blocks and
 * models that wrap their JSON in prose.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const candidates: string[] = []

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  candidates.push(trimmed)

  // Last resort: the widest balanced brace span in the text.
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function readReasoning(obj: Record<string, unknown>): string {
  for (const key of ['reasoning', 'reason', 'thinking', 'thought', 'explanation', 'rationale']) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export interface ParseOutcome<T> {
  ok: boolean
  value?: T
  reasoning: string
  /** Feedback handed back to the model when the reply was unusable. */
  problem?: string
}

export function parseBlackjackReply(
  text: string,
  legal: BlackjackAction[]
): ParseOutcome<BlackjackAction> {
  const obj = extractJson(text)
  if (!obj) {
    return { ok: false, reasoning: '', problem: 'Your reply was not valid JSON. Reply with only a JSON object.' }
  }
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

export function parsePokerReply(text: string, legal: LegalActions): ParseOutcome<PokerAction> {
  const obj = extractJson(text)
  if (!obj) {
    return { ok: false, reasoning: '', problem: 'Your reply was not valid JSON. Reply with only a JSON object.' }
  }
  const reasoning = readReasoning(obj)
  const rawAction = obj.action ?? obj.move ?? obj.decision
  if (typeof rawAction !== 'string') {
    return { ok: false, reasoning, problem: 'Your JSON had no "action" string.' }
  }

  const normalised = rawAction.trim().toLowerCase().replace(/[^a-z-]/g, '')
  let kind: PokerAction['kind'] | null = null
  if (['fold', 'muck'].includes(normalised)) kind = 'fold'
  else if (['check'].includes(normalised)) kind = 'check'
  else if (['call'].includes(normalised)) kind = 'call'
  else if (['raise', 'bet', 'allin', 'all-in', 'shove', 'reraise', 'raiseto'].includes(normalised)) kind = 'raise'

  if (!kind) {
    return { ok: false, reasoning, problem: `"${rawAction}" is not an action. Use fold, check, call or raise.` }
  }

  if (kind === 'check' && !legal.canCheck) {
    // Checking is not on offer, but the intent is clearly "stay in for free".
    return {
      ok: false,
      reasoning,
      problem: `You cannot check: there is ${legal.callAmount} to call. Use "call", "fold", or "raise".`
    }
  }
  if (kind === 'call' && legal.canCheck) {
    return { ok: true, value: { kind: 'check' }, reasoning }
  }

  if (kind === 'raise') {
    if (!legal.canRaise) {
      return {
        ok: false,
        reasoning,
        problem: `You cannot raise; your stack only covers a call. Use "call" or "fold".`
      }
    }
    const amountRaw =
      obj.amount ?? obj.raise_to ?? obj.raiseTo ?? obj.total ?? obj.size ?? obj.bet
    const shove = ['allin', 'all-in', 'shove'].includes(normalised)
    let amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw)

    if (shove && !Number.isFinite(amount)) amount = legal.maxRaiseTo
    if (!Number.isFinite(amount)) {
      return {
        ok: false,
        reasoning,
        problem: `Raising needs a numeric "amount" between ${legal.minRaiseTo} and ${legal.maxRaiseTo} (the total you raise TO).`
      }
    }
    if (amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
      return {
        ok: false,
        reasoning,
        problem: `A raise to ${amount} is not allowed. It must be between ${legal.minRaiseTo} and ${legal.maxRaiseTo}.`
      }
    }
    return { ok: true, value: { kind: 'raise', amount: Math.round(amount) }, reasoning }
  }

  return { ok: true, value: { kind }, reasoning }
}
