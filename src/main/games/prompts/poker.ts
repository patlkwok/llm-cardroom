import { cardCode } from '../../../shared/cards.ts'
import type { PokerAction, PokerRules, PokerSeat } from '../../../shared/types.ts'
import type { LegalActions, PokerTable } from '../poker/engine.ts'
import { extractJson, NOTATION, notJson, readReasoning, type ParseOutcome, type Prompt } from './shared.ts'

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

export function parsePokerReply(text: string, legal: LegalActions): ParseOutcome<PokerAction> {
  const obj = extractJson(text)
  if (!obj) return notJson()
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
