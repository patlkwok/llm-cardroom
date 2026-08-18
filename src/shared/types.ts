import type { Card, Suit } from './cards.ts'

export type GameKind = 'blackjack' | 'poker' | 'hearts' | 'spades' | 'twentyfour'

/** Every game, in the order the setup panel offers them. */
export const GAME_KINDS: GameKind[] = ['blackjack', 'poker', 'hearts', 'spades', 'twentyfour']

/**
 * What each game needs at the table. A per-game record rather than a pair of
 * ternaries: the UI asked "is this poker?" in a dozen places, which stopped
 * scaling the moment blackjack also seated more than one model.
 */
export interface GameDescriptor {
  label: string
  /** Shortened for the game selector, where four buttons share one row. */
  shortLabel: string
  minPlayers: number
  maxPlayers: number
  /** What one deal is called, for labels like "Stop after N rounds". */
  roundNoun: string
  /**
   * The roster locks at the first deal: no joining or leaving mid-match. Hearts
   * is defined around four hands of thirteen cards, so it opts out of the
   * reconciliation machinery both older games share rather than simply not
   * opting in.
   */
  fixedRoster: boolean
  /** Penalty scoring, where the *smallest* total wins. Hearts alone, so far. */
  lowestWins: boolean
  /** Every seat answers the same deal at once, so the round has no turns. */
  simultaneous: boolean
  /**
   * Fixed partnerships rather than every seat for itself. The UI reads this to
   * show teams; the interesting consequence is that a model has to infer its
   * partner's hand from public information, because partners may not talk.
   */
  partnership: boolean
}

export const GAMES: Record<GameKind, GameDescriptor> = {
  blackjack: {
    label: 'Blackjack',
    shortLabel: 'Blackjack',
    minPlayers: 1,
    maxPlayers: 6,
    roundNoun: 'round',
    fixedRoster: false,
    lowestWins: false,
    simultaneous: false,
    partnership: false
  },
  poker: {
    label: "No-Limit Hold'em",
    shortLabel: "Hold'em",
    minPlayers: 2,
    maxPlayers: 8,
    roundNoun: 'hand',
    fixedRoster: false,
    lowestWins: false,
    simultaneous: false,
    partnership: false
  },
  hearts: {
    label: 'Hearts',
    shortLabel: 'Hearts',
    minPlayers: 4,
    maxPlayers: 4,
    roundNoun: 'hand',
    fixedRoster: true,
    lowestWins: true,
    simultaneous: false,
    partnership: false
  },
  spades: {
    label: 'Spades',
    shortLabel: 'Spades',
    minPlayers: 4,
    maxPlayers: 4,
    roundNoun: 'hand',
    // Partnerships are positional — seats 0 and 2 against 1 and 3 — which only
    // works because the seats never move. A join renumbering the table would
    // silently swap somebody's partner for an opponent mid-match.
    fixedRoster: true,
    lowestWins: false,
    simultaneous: false,
    // The first game here that is not a free-for-all. Partners cannot legally
    // say anything to each other, so a seat has to read its partner's holding
    // out of the bid and the play — a capability axis none of the other four
    // touch at all.
    partnership: true
  },
  twentyfour: {
    label: 'The 24 Puzzle',
    shortLabel: '24',
    minPlayers: 1,
    maxPlayers: 6,
    // Every seat answers every puzzle, and the score is rounds won, so a model
    // that joined at puzzle 12 is not comparable with one that played all of
    // them. Seat whoever is racing before the first deal.
    fixedRoster: true,
    roundNoun: 'puzzle',
    lowestWins: false,
    simultaneous: true,
    partnership: false
  }
}

/**
 * How well the stored API key is actually protected at rest. This differs by
 * OS, and on Linux it differs by whether a desktop keyring is installed, so the
 * UI has to be told rather than assuming "encrypted".
 */
export type KeyStorageKind =
  /** A real credential store: DPAPI, macOS Keychain, or a Linux keyring. */
  | 'os-keychain'
  /** Linux with no keyring: obfuscated with a hardcoded key, not protected. */
  | 'obfuscated'
  /** No encryption available at all; the key is on disk in clear text. */
  | 'plaintext'

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

/**
 * One model's seat at the blackjack table. Several seats share one shoe and one
 * dealer, so every counter that used to live on the table is per player.
 */
export interface BlackjackPlayer {
  id: string
  name: string
  modelId: string
  seatIndex: number
  bankroll: number
  /** This round's hands, splits included. Empty when the seat was not dealt in. */
  hands: BlackjackHand[]
  activeHandIndex: number
  /** What insurance would cost this seat this round; 0 when it was not offered. */
  insuranceOffer: number
  /** Chips staked on insurance this round; 0 when declined or not offered. */
  insuranceBet: number
  insuranceOutcome?: 'won' | 'lost' | 'declined'
  /** Net chips across this seat's whole session, and for the round just settled. */
  sessionNet: number
  lastRoundNet: number
  roundsPlayed: number
  handsWon: number
  handsLost: number
  handsPushed: number
  blackjacks: number
  busts: number
  /** Out of chips: can no longer cover the table minimum, so is not dealt in. */
  busted: boolean
}

export interface BlackjackState {
  kind: 'blackjack'
  phase: 'idle' | 'dealing' | 'insurance' | 'player' | 'dealer' | 'settled'
  roundNumber: number
  baseBet: number
  shoeRemaining: number
  shoeJustShuffled: boolean
  players: BlackjackPlayer[]
  /** Seat index of the player to act, or -1 when nobody is acting. */
  activePlayerIndex: number
  dealerCards: Card[]
  dealerHoleHidden: boolean
  /** True once insurance has been offered this round (dealer showing an ace). */
  insuranceOffered: boolean
  roundsPlayed: number
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
  /**
   * Chance of winning the hand from the current board, 0..1, as a televised
   * table shows it. **Spectator only** — it is derived from every player's hole
   * cards, so it must never reach a prompt.
   */
  equity?: number
}

export interface SidePot {
  amount: number
  eligibleSeatIds: string[]
}

export interface PokerState {
  kind: 'poker'
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

/* --------------------------------------------------- trick-taking, shared */

/**
 * One card going down. Shared by every trick-taking game here: the shape was
 * identical in each, and `trickWinner` in `tricks/core.ts` is written against
 * it rather than against any one game's version.
 */
export interface TrickPlay {
  seatIndex: number
  seatId: string
  card: Card
}

/** What every trick has, before a game adds its own scoring to it. */
export interface TrickBase {
  /** 1-based, so it reads the same in the log and the prompt. */
  number: number
  leadSuit: Suit
  plays: TrickPlay[]
  /** Set once four cards are down. */
  winnerSeatIndex?: number
  winnerName?: string
}

/* ----------------------------------------------------------------- hearts */

/** Where this hand's three cards go. Rotates, and every fourth hand is a hold. */
export type PassDirection = 'left' | 'right' | 'across' | 'hold'

export interface HeartsTrick extends TrickBase {
  /** Penalty points carried by the four cards. */
  points: number
}

export interface HeartsPlayer {
  id: string
  name: string
  modelId: string
  seatIndex: number
  /**
   * Cards still held. The spectator sees every hand, exactly as at poker — and
   * exactly as at poker, a model's prompt only ever renders its own.
   */
  hand: Card[]
  /** Running match total. **Lowest wins**, unlike every other game here. */
  totalScore: number
  /** Penalty points taken so far this hand, and in the hand just scored. */
  handScore: number
  lastHandScore: number
  tricksWon: number
  /** Hands where this seat took all 26. */
  moonShots: number
  /** This hand's exchange, for the spectator. Empty on a hold hand. */
  passedCards: Card[]
  receivedCards: Card[]
}

export interface HeartsState {
  kind: 'hearts'
  /**
   * The exchange is three phases, not one. `passing` collects each seat's
   * choice; `passRevealed` shows the three cards leaving each hand while they
   * are *still held*; `passReceived` shows the three that arrived. Doing it in
   * a single step meant twelve cards changed hands between two frames and the
   * operator never saw the pass happen at all.
   */
  phase:
    | 'idle'
    | 'passing'
    | 'passRevealed'
    | 'passReceived'
    | 'playing'
    | 'handComplete'
    | 'complete'
  handNumber: number
  handsPlayed: number
  passDirection: PassDirection
  players: HeartsPlayer[]
  /** The trick being played, or null between tricks. */
  currentTrick: HeartsTrick | null
  /** Kept on the felt after it is gathered, so the operator can read it. */
  lastTrick: HeartsTrick | null
  /** 1-based; 13 tricks to a hand, always. */
  trickNumber: number
  leadSeatIndex: number
  /** Seat whose turn it is, or -1 between plays. */
  actingSeatIndex: number
  /** A heart has actually been played, so hearts may now be led. */
  heartsBroken: boolean
  /** Whether the queen of spades has gone. She does *not* break hearts. */
  queenPlayed: boolean
  lastHandSummary?: string
  winnerName?: string
  /**
   * Plays made without asking a model, because only one card was legal. Worth
   * counting: it is how much of a trick-taking match comes free.
   */
  forcedPlays: number
  /** Total plays made, forced ones included, for the forced-play rate. */
  totalPlays: number
}

export interface HeartsRules {
  /** The match ends once any seat reaches this. Traditionally 100. */
  targetScore: number
}

/* ----------------------------------------------------------------- spades */

export interface SpadesTrick extends TrickBase {}

/**
 * One seat. Its partner is the seat two to its left, always — partnerships are
 * positional, which is only safe because the roster is fixed for the match.
 */
export interface SpadesPlayer {
  id: string
  name: string
  modelId: string
  seatIndex: number
  /** 0 for seats 0 and 2, 1 for seats 1 and 3. */
  teamIndex: number
  /**
   * Cards still held. The spectator sees all four hands; a model's prompt only
   * ever renders its own — including its partner's, which is the whole point of
   * the game. Partners may not talk, so a partner's holding has to be inferred.
   */
  hand: Card[]
  /** Tricks this seat contracted for, or null before it has bid. 0 is nil. */
  bid: number | null
  /** Tricks taken this hand, and in the hand just scored. */
  tricksWon: number
  lastHandTricks: number
  /** Nil bids made and nil bids brought home, across the match. */
  nilsBid: number
  nilsMade: number
}

/** A partnership. Everything that scores lives here rather than on the seat. */
export interface SpadesTeam {
  index: number
  /** "North–South" / "East–West": the compass positions the felt already draws. */
  name: string
  seatIndices: number[]
  score: number
  /**
   * Overtricks carried forward. Every 10 costs 100 points and drops the count
   * by 10 — the first score in this app that persists *between* hands as a
   * penalty rather than as a total.
   */
  bags: number
  /** This hand's contract: both partners' bids added up. A nil adds nothing. */
  contract: number
  tricksWon: number
  lastHandDelta: number
}

export interface SpadesState {
  kind: 'spades'
  phase: 'idle' | 'bidding' | 'playing' | 'handComplete' | 'complete'
  handNumber: number
  handsPlayed: number
  players: SpadesPlayer[]
  /** Exactly two, indexed by `teamIndex`. */
  teams: SpadesTeam[]
  /** Rotates one seat left each hand; the seat to its left leads trick one. */
  dealerIndex: number
  /** Seat owed a bid, or -1 once every seat has bid. */
  biddingSeatIndex: number
  currentTrick: SpadesTrick | null
  /** Kept on the felt after it is gathered, so the operator can read it. */
  lastTrick: SpadesTrick | null
  /** 1-based; 13 tricks to a hand, always. */
  trickNumber: number
  leadSeatIndex: number
  /** Seat whose turn it is, or -1 between plays. */
  actingSeatIndex: number
  /** A spade has been played, so spades may now be led. */
  spadesBroken: boolean
  lastHandSummary?: string
  winnerName?: string
  /** Plays made without asking a model, because only one card was legal. */
  forcedPlays: number
  /** Total plays made, forced ones included, for the forced-play rate. */
  totalPlays: number
}

export interface SpadesRules {
  /** The match ends once a partnership reaches this. Traditionally 500. */
  targetScore: number
  /**
   * A partnership this far under loses immediately; 0 disables the floor. It
   * exists to stop a hopeless match grinding on at four API calls a trick.
   */
  bustScore: number
  /**
   * Whether a trick taken by a nil bidder counts towards their partner's
   * contract as well as breaking the nil.
   *
   * True is the core rule and the default. False is the house rule where the
   * nil bidder's tricks become bags only, so the partner's bid has to be made
   * unaided — which makes nil considerably riskier. It is a setting rather
   * than a decision because tables really do play both, and whichever is in
   * force is stated in the system prompt so no model has to guess.
   */
  nilTricksCountToContract: boolean
}

/* ------------------------------------------------------------ 24 puzzle */

export type TwentyFourVerdict =
  /** Made 24, or correctly reported that the deal cannot. */
  | 'correct'
  /** A well-formed expression that does not make 24, or a wrong "no solution". */
  | 'wrong'
  /** Unparseable, used the wrong cards, or divided by zero. */
  | 'invalid'
  /** The model never answered at all. */
  | 'none'

export interface TwentyFourResult {
  playerId: string
  playerName: string
  /** The expression given, or null when the model claimed no solution. */
  expression: string | null
  verdict: TwentyFourVerdict
  /** What the expression actually came to, exactly — e.g. "22" or "71/3". */
  valueLabel?: string
  /** Why an invalid answer was rejected. */
  problem?: string
  /**
   * How long the model took to answer, in milliseconds. This is the *answering*
   * attempt only: retry time is excluded, so a rate-limited model does not lose
   * the round for reasons that have nothing to do with the puzzle.
   */
  elapsedMs: number
  /** 1 = fastest correct answer, 2 = next, and so on. 0 when not correct. */
  rank: number
  won: boolean
}

export interface TwentyFourPlayer {
  id: string
  name: string
  modelId: string
  seatIndex: number
  /** Rounds won, which is what the match is played for. */
  score: number
  solved: number
  /** Solvable deals this seat failed to solve. */
  missed: number
  wrong: number
  invalid: number
  roundsPlayed: number
  /**
   * Answering times for every round this seat actually replied to, right or
   * wrong. Rounds where it never answered are excluded — there is no duration
   * to record — but a wrong answer is still an answer and still counts.
   *
   * This is deliberate. Timing only the correct answers would flatter a model
   * that gives up quickly whenever a puzzle is hard, and the pair of numbers is
   * meant to disagree: a seat that instantly says "no solution" every round
   * should show a fast median *and* a poor solve rate. `correctLatencies`
   * carries the other reading for anyone who wants it.
   */
  latencies: number[]
  /** Answering times for correct answers only: "when it solves, how long?". */
  correctLatencies: number[]
  lastResult?: TwentyFourResult
}

export interface TwentyFourState {
  kind: 'twentyfour'
  phase: 'idle' | 'dealing' | 'answering' | 'settled' | 'complete'
  roundNumber: number
  roundsPlayed: number
  cards: Card[]
  /** Whether the deal can actually be made into 24. Unsolvable deals are dealt
   * on purpose: "no solution" is a legal answer, and it is the only version of
   * the game that catches a model bluffing an expression that does not
   * evaluate. */
  solvable: boolean
  /**
   * One worked answer, or null when there is none. **Spectator only** — like
   * poker equity, it must never reach a prompt.
   */
  solution: string | null
  players: TwentyFourPlayer[]
  /** This round's answers, in finishing order. */
  results: TwentyFourResult[]
  lastRoundSummary?: string
  winnerName?: string
}

export interface TwentyFourRules {
  /** First seat to this many round wins takes the match; 0 runs until stopped. */
  targetScore: number
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
  hearts: HeartsRules
  spades: SpadesRules
  twentyfour: TwentyFourRules
  /** Milliseconds to pause between visible steps so a human can follow along. */
  stepDelayMs: number
  /**
   * Show each poker seat's live win probability, the way a televised table
   * does. Costs no money — it is CPU, not an API call — but it is real work:
   * a few hundred milliseconds per board change, which dominates at a very
   * fast pace. Spectator-only; it never reaches a prompt.
   */
  showEquity: boolean
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

/**
 * Whatever is on the felt, discriminated by `kind`. This used to be one optional
 * field per game on the snapshot, which at four games would have been four
 * optional fields where exactly one is ever set — and nothing in the type
 * stopped a caller reading the wrong one.
 */
export type TableState =
  | BlackjackState
  | PokerState
  | HeartsState
  | SpadesState
  | TwentyFourState

export interface MatchSnapshot {
  status: MatchStatus
  game: GameKind
  /** Null before the first deal, and only then. */
  table: TableState | null
  players: PlayerConfig[]
  stats: PlayerStats[]
  /** Set when status is 'error'. */
  errorText?: string
}

/**
 * The table state, but only if it belongs to the game asked for. Saves every
 * caller writing the same `table?.kind === 'poker' ? table : undefined` dance,
 * and makes reading the wrong game's state impossible rather than merely
 * unlikely.
 */
export function tableOf<K extends GameKind>(
  snapshot: MatchSnapshot | null | undefined,
  kind: K
): Extract<TableState, { kind: K }> | undefined {
  const table = snapshot?.table
  return table?.kind === kind ? (table as Extract<TableState, { kind: K }>) : undefined
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

export const DEFAULT_HEARTS_RULES: HeartsRules = {
  targetScore: 100
}

export const DEFAULT_SPADES_RULES: SpadesRules = {
  targetScore: 500,
  bustScore: -200,
  nilTricksCountToContract: true
}

export const DEFAULT_TWENTYFOUR_RULES: TwentyFourRules = {
  targetScore: 10
}

export function defaultSettings(): MatchSettings {
  return {
    game: 'blackjack',
    players: [],
    benched: {},
    blackjack: { ...DEFAULT_BLACKJACK_RULES },
    poker: { ...DEFAULT_POKER_RULES },
    hearts: { ...DEFAULT_HEARTS_RULES },
    spades: { ...DEFAULT_SPADES_RULES },
    twentyfour: { ...DEFAULT_TWENTYFOUR_RULES },
    stepDelayMs: 900,
    showEquity: true,
    maxRounds: 0
  }
}
