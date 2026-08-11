import type { Card } from './cards.ts'

export type GameKind = 'blackjack' | 'poker'

/* ------------------------------------------------------------------ models */

export interface ModelInfo {
  id: string
  name: string
  contextLength: number
  /** USD per 1M tokens, already scaled from OpenRouter's per-token strings. */
  promptPrice: number
  completionPrice: number
  description: string
}

/**
 * How hard the model should think before acting. 'default' sends no reasoning
 * parameter at all, leaving the model's own default in force. Models without
 * reasoning support ignore the parameter.
 */
export type ReasoningEffort = 'default' | 'none' | 'low' | 'medium' | 'high'

export const REASONING_EFFORTS: ReasoningEffort[] = ['default', 'none', 'low', 'medium', 'high']

export interface PlayerConfig {
  id: string
  /** Display name at the table. Defaults to a short form of the model name. */
  name: string
  modelId: string
  modelName: string
  reasoningEffort: ReasoningEffort
}

/* -------------------------------------------------------------- blackjack */

export type BlackjackAction = 'hit' | 'stand' | 'double' | 'split'

export type BlackjackHandStatus =
  | 'active'
  | 'stood'
  | 'busted'
  | 'blackjack'
  | 'doubled'

export type BlackjackOutcome = 'win' | 'lose' | 'push' | 'blackjack'

export interface BlackjackHand {
  id: string
  cards: Card[]
  bet: number
  status: BlackjackHandStatus
  /** Split aces receive exactly one card and may not be hit again. */
  fromSplitAces: boolean
  splitDepth: number
  outcome?: BlackjackOutcome
  /** Net chips won (positive) or lost (negative) on this hand. */
  net?: number
}

export interface BlackjackState {
  phase: 'idle' | 'dealing' | 'insurance' | 'player' | 'dealer' | 'settled'
  roundNumber: number
  bankroll: number
  baseBet: number
  shoeRemaining: number
  shoeJustShuffled: boolean
  hands: BlackjackHand[]
  activeHandIndex: number
  dealerCards: Card[]
  dealerHoleHidden: boolean
  /** True once insurance has been offered this round (dealer showing an ace). */
  insuranceOffered: boolean
  /** Chips staked on insurance this round; 0 when declined or not offered. */
  insuranceBet: number
  insuranceOutcome?: 'won' | 'lost' | 'declined'
  /** Net chips across the whole session, and for the round just settled. */
  sessionNet: number
  lastRoundNet: number
  roundsPlayed: number
  handsWon: number
  handsLost: number
  handsPushed: number
  blackjacks: number
  busts: number
}

export interface BlackjackRules {
  deckCount: number
  /** Dealer hits soft 17 when true (H17); stands on all 17 when false (S17). */
  dealerHitsSoft17: boolean
  blackjackPayout: number
  /** Offer insurance for half the stake when the dealer shows an ace. */
  offerInsurance: boolean
  doubleAfterSplit: boolean
  maxSplits: number
  startingBankroll: number
  /** The flat wager, or the table minimum when the model sizes its own bets. */
  baseBet: number
  /** When true, the model is asked how much to wager before each deal. */
  modelChoosesBet: boolean
}

/* ------------------------------------------------------------------ poker */

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

export type PokerActionKind = 'fold' | 'check' | 'call' | 'raise'

export interface PokerAction {
  kind: PokerActionKind
  /** For `raise`: the total amount this player's bet is raised *to*. */
  amount?: number
}

export interface PokerSeat {
  id: string
  name: string
  modelId: string
  seatIndex: number
  stack: number
  cards: Card[]
  cardsRevealed: boolean
  folded: boolean
  allIn: boolean
  /** Chips committed on the current street. */
  committed: number
  /** Chips committed across the whole hand. */
  totalCommitted: number
  busted: boolean
  lastActionLabel?: string
  /** Set at showdown for seats that showed cards. */
  showdownHand?: string
  wonThisHand: number
}

export interface SidePot {
  amount: number
  eligibleSeatIds: string[]
}

export interface PokerState {
  phase: 'idle' | 'hand' | 'showdown' | 'complete'
  handNumber: number
  street: Street
  board: Card[]
  seats: PokerSeat[]
  buttonIndex: number
  /** Seat index whose turn it is, or -1 between actions. */
  actingSeatIndex: number
  pot: number
  /** Highest per-street commitment any seat has made. */
  currentBet: number
  minRaiseIncrement: number
  smallBlind: number
  bigBlind: number
  sidePots: SidePot[]
  /** Filled in at the end of a hand for the results banner. */
  lastHandSummary?: string
  handsPlayed: number
}

export interface PokerRules {
  startingStack: number
  smallBlind: number
  bigBlind: number
  /** Blinds double every N hands; 0 disables escalation. */
  blindIncreaseEvery: number
}

/* ------------------------------------------------------------- match/events */

export interface MatchSettings {
  game: GameKind
  /** The roster for the currently selected game. */
  players: PlayerConfig[]
  /**
   * Rosters for games that are not selected right now, so switching between
   * Blackjack and Hold'em does not throw away the other table's line-up.
   */
  benched?: Partial<Record<GameKind, PlayerConfig[]>>
  blackjack: BlackjackRules
  poker: PokerRules
  /** Milliseconds to pause between visible steps so a human can follow along. */
  stepDelayMs: number
  /** Stop after this many rounds/hands; 0 runs until stopped or busted. */
  maxRounds: number
}

export type LogLevel = 'info' | 'action' | 'deal' | 'result' | 'error' | 'system'

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  text: string
  playerId?: string
}

export interface DecisionRecord {
  id: number
  ts: number
  playerId: string
  playerName: string
  modelId: string
  /** The model's own explanation, extracted from its JSON reply. */
  reasoning: string
  actionLabel: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  /** Set when the model failed and the table fell back to a default action. */
  fallback?: string
  attempts: number
}

export interface PlayerStats {
  playerId: string
  decisions: number
  fallbacks: number
  errors: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  avgLatencyMs: number
}

export type MatchStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'finished' | 'error'

export interface MatchSnapshot {
  status: MatchStatus
  game: GameKind
  blackjack?: BlackjackState
  poker?: PokerState
  players: PlayerConfig[]
  stats: PlayerStats[]
  /** Set when status is 'error'. */
  errorText?: string
}

export type MatchEvent =
  | { type: 'snapshot'; snapshot: MatchSnapshot }
  | { type: 'log'; entry: LogEntry }
  | { type: 'decision'; record: DecisionRecord }
  /** Emitted the moment a model is asked to act, so the UI can show a spinner. */
  | { type: 'thinking'; playerId: string; playerName: string; active: boolean }

/* ------------------------------------------------------------------ config */

export interface AppConfig {
  apiKey: string
  lastSettings: MatchSettings | null
}

export const DEFAULT_BLACKJACK_RULES: BlackjackRules = {
  deckCount: 6,
  dealerHitsSoft17: false,
  blackjackPayout: 1.5,
  offerInsurance: true,
  doubleAfterSplit: true,
  maxSplits: 3,
  startingBankroll: 1000,
  baseBet: 25,
  modelChoosesBet: false
}

export const DEFAULT_POKER_RULES: PokerRules = {
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  blindIncreaseEvery: 0
}

export function defaultSettings(): MatchSettings {
  return {
    game: 'blackjack',
    players: [],
    benched: {},
    blackjack: { ...DEFAULT_BLACKJACK_RULES },
    poker: { ...DEFAULT_POKER_RULES },
    stepDelayMs: 900,
    maxRounds: 0
  }
}
