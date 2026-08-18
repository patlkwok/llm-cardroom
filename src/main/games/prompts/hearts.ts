import { cardCode, type Card } from '../../../shared/cards.ts'
import type { HeartsPlayer, HeartsRules, HeartsState, HeartsTrick } from '../../../shared/types.ts'
import { cardPoints, sameCard } from '../hearts/engine.ts'
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

const PASS_PHRASE: Record<string, string> = {
  left: 'to the player on your left',
  right: 'to the player on your right',
  across: 'to the player across the table',
  hold: 'nowhere — this is a hold hand'
}

/**
 * The rules, stated in force.
 *
 * Every line here is a variant decision rather than a universal, and a model
 * that guesses differently plays a different game from the one being dealt.
 * The queen-of-spades line matters most: plenty of players believe she breaks
 * hearts, and she does not.
 */
export function heartsSystemPrompt(rules: HeartsRules): string {
  return [
    'You are playing Hearts against three other AI players. Every player is for themselves.',
    '',
    'Rules in force at this table:',
    '- Each heart costs 1 point. The queen of spades costs 13. Everything else is 0.',
    '- **The LOWEST total score wins.** You are trying to take as few points as possible.',
    `- The game ends as soon as any player reaches ${rules.targetScore} points.`,
    '- 13 tricks per hand. You must follow the suit led if you hold any card of it.',
    '  If you are void in that suit you may play anything, subject to the rules below.',
    '- The highest card of the suit led wins the trick, and its winner leads the next.',
    '- Before each hand you pass 3 cards, rotating left, right, across, then hold (no pass).',
    '- The two of clubs always leads the first trick.',
    '- NO POINTS may be played on the first trick: no heart, and not the queen of spades,',
    '  unless points are genuinely all you hold.',
    '- Hearts may not be LED until a heart has been played on some earlier trick',
    '  ("breaking hearts"). If hearts are all you hold, you may lead one anyway.',
    '- **The queen of spades does NOT break hearts.** Only an actual heart being played does.',
    '  Playing the queen leaves hearts unbroken, so hearts still may not be led afterwards.',
    '- Shooting the moon: take ALL 26 points in a hand and you score 0 while every other',
    '  player scores 26. Taking 25 of the 26 is a disaster, so shoot only if you can finish it.',
    '',
    NOTATION,
    '',
    'You are told exactly which cards you may legally play. Choose one of those and no other.',
    '',
    'Reply with a single JSON object and nothing else, in exactly this shape:',
    '{"reasoning": "<one or two short sentences>", "card": "<one card code, e.g. Qs>"}'
  ].join('\n')
}

/** One line per completed trick: who played what, who took it, what it cost. */
function trickHistory(state: HeartsState, tricks: HeartsTrick[]): string[] {
  if (tricks.length === 0) return []
  const name = (seatIndex: number): string => state.players[seatIndex].name
  const lines = ['', 'Tricks so far this hand:']
  for (const trick of tricks) {
    const played = trick.plays.map((p) => `${name(p.seatIndex)} ${cardCode(p.card)}`).join(', ')
    lines.push(
      `  Trick ${trick.number}: ${played} — ${trick.winnerName ?? '?'} takes it` +
        `${trick.points > 0 ? ` (${trick.points} point${trick.points === 1 ? '' : 's'})` : ' (no points)'}`
    )
  }
  return lines
}

function scoreboard(state: HeartsState, player: HeartsPlayer): string[] {
  const lines = ['', 'Scores (lowest wins) — total, then points taken this hand:']
  for (const other of state.players) {
    const you = other.id === player.id ? ' (you)' : ''
    lines.push(`- ${other.name}${you}: ${other.totalScore} total, ${other.handScore} this hand`)
  }
  return lines
}

/**
 * The passing decision — the first anywhere in this app that returns a *set*
 * rather than a single choice.
 */
export function buildHeartsPassPrompt(
  state: HeartsState,
  player: HeartsPlayer,
  rules: HeartsRules
): Prompt {
  const lines: string[] = []
  lines.push(`Hand ${state.handNumber}. You are passing 3 cards ${PASS_PHRASE[state.passDirection]}.`)
  lines.push('')
  lines.push(`Your hand (13 cards): ${player.hand.map(cardCode).join(' ')}`)
  lines.push(...scoreboard(state, player))
  lines.push('')
  lines.push('You will receive 3 cards back from another player before play starts.')
  lines.push('High spades are dangerous while you still hold the queen of spades;')
  lines.push('being void in a suit lets you discard points into it later.')
  lines.push('')
  lines.push('Which 3 cards do you pass?')
  lines.push('')
  lines.push('Reply with a single JSON object and nothing else:')
  lines.push('{"reasoning": "<one short sentence>", "pass": ["<card>", "<card>", "<card>"]}')

  return { system: heartsSystemPrompt(rules), user: lines.join('\n') }
}

/** Reads exactly three distinct cards, all of which the seat actually holds. */
export function parseHeartsPassReply(text: string, hand: Card[]): ParseOutcome<Card[]> {
  const obj = extractJson(text)
  if (!obj) return notJson()
  const reasoning = readReasoning(obj)

  const raw = obj.pass ?? obj.cards ?? obj.discard ?? obj.selection
  if (!Array.isArray(raw)) {
    return { ok: false, reasoning, problem: 'Your JSON needs a "pass" array of exactly 3 card codes.' }
  }
  if (raw.length !== 3) {
    return {
      ok: false,
      reasoning,
      problem: `A pass is exactly 3 cards; you gave ${raw.length}.`
    }
  }

  const chosen: Card[] = []
  const remaining = [...hand]
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { ok: false, reasoning, problem: 'Each entry in "pass" must be a card code like "Qs".' }
    }
    const card = parseCardCode(entry)
    if (!card) {
      return { ok: false, reasoning, problem: `"${entry}" is not a card code. Use forms like "Qs", "Td", "2c".` }
    }
    const at = remaining.findIndex((held) => sameCard(held, card))
    if (at === -1) {
      // Covers both "not in your hand" and "named the same card twice".
      return {
        ok: false,
        reasoning,
        problem: `You do not hold ${cardCode(card)} (or you named it twice). Your hand is: ${hand.map(cardCode).join(' ')}.`
      }
    }
    remaining.splice(at, 1)
    chosen.push(card)
  }
  return { ok: true, value: chosen, reasoning }
}

export function buildHeartsPlayPrompt(
  state: HeartsState,
  player: HeartsPlayer,
  legal: Card[],
  tricks: HeartsTrick[],
  rules: HeartsRules
): Prompt {
  const trick = state.currentTrick
  const leading = !trick || trick.plays.length === 0
  const lines: string[] = []

  lines.push(`Hand ${state.handNumber}, trick ${state.trickNumber} of 13.`)
  lines.push(`Your hand: ${player.hand.map(cardCode).join(' ')}`)
  lines.push('')

  if (leading) {
    lines.push('You are on lead — the trick is yours to open.')
  } else {
    const played = trick.plays
      .map((p) => `${state.players[p.seatIndex].name} played ${cardCode(p.card)}`)
      .join(', ')
    lines.push(`This trick so far (${suitWord(trick.leadSuit)} led): ${played}.`)
    const carried = trick.points
    lines.push(
      carried > 0
        ? `There ${carried === 1 ? 'is' : 'are'} already ${carried} point${carried === 1 ? '' : 's'} in this trick.`
        : 'No points in this trick yet.'
    )
  }

  // Both facts drive real decisions, and neither can be inferred from the hand.
  lines.push(
    state.heartsBroken
      ? 'Hearts have been broken, so hearts may be led.'
      : 'Hearts have NOT been broken yet, so hearts may not be led.'
  )
  lines.push(
    state.queenPlayed
      ? 'The queen of spades has already been played.'
      : 'The queen of spades is still out there.'
  )

  lines.push(...trickHistory(state, tricks))
  lines.push(...scoreboard(state, player))

  lines.push('')
  lines.push(`Legal plays: ${legal.map(cardCode).join(', ')}`)
  const costly = legal.filter((c) => cardPoints(c) > 0)
  if (costly.length > 0) {
    lines.push(
      'Of those, these carry points: ' +
        costly.map((c) => `${cardCode(c)} = ${cardPoints(c)}`).join(', ') + '.'
    )
  }
  lines.push('')
  lines.push('Which card do you play?')

  return { system: heartsSystemPrompt(rules), user: lines.join('\n') }
}

export function parseHeartsPlayReply(text: string, legal: Card[]): ParseOutcome<Card> {
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
