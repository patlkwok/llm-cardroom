import type {
  GameKind,
  LogLevel,
  PlayerConfig,
  TableState
} from '../../shared/types.ts'
import type { AgentResult } from './agent.ts'
import type { ParseOutcome, Prompt } from './prompts/shared.ts'

/**
 * The bit of a game table the roster code needs. Both games that seat and unseat
 * models do it at a round boundary on identical terms, so they share one
 * implementation rather than two that can drift apart.
 *
 * A fixed-roster game (Hearts) simply never asks for one.
 */
export interface RosterTable {
  /** Read fresh on every call: seating changes as the reconciliation runs. */
  seats: () => Array<{ id: string; name: string; chips: number }>
  capacity: number
  buyIn: number
  add: (player: PlayerConfig, buyIn: number) => void
  remove: (id: string) => boolean
}

/** Settings the operator may change while a match is running. */
export interface LiveSettings {
  stepDelayMs: number
  showEquity: boolean
  maxRounds: number
  blackjackBaseBet: number
  modelChoosesBet: boolean
}

/**
 * Everything a game driver needs from the runner. The runner owns the clock,
 * the pause gate, the network, the stats and the event stream; a driver owns
 * only the rules of its own game.
 */
export interface DriverContext {
  readonly isStopping: boolean
  readonly live: LiveSettings
  /** The models currently at the table, which can change between rounds. */
  readonly roster: PlayerConfig[]

  log(level: LogLevel, text: string, playerId?: string): void
  /** Waits out the visible step delay, returning early if the match stops. */
  beat(multiplier?: number): Promise<void>
  /** Blocks while the match is paused. */
  gate(): Promise<void>
  pushSnapshot(): void
  pause(): void

  /** The live configuration for a seat, which may differ from the settings. */
  configFor(playerId: string): PlayerConfig | undefined
  ensureStats(playerId: string): void
  /** Applies a queued roster change. Only ever safe between rounds. */
  reconcileRoster(table: RosterTable): void

  /**
   * One decision, with the spinner, the retry logging and the fatal-error check
   * already wired up. Every call site used to repeat all three.
   */
  ask<T>(request: AskRequest<T>): Promise<AgentResult<T>>

  recordDecision(player: PlayerConfig, actionLabel: string, result: AgentResult<unknown>): void
}

export interface AskRequest<T> {
  player: PlayerConfig
  prompt: Prompt
  parse: (text: string) => ParseOutcome<T>
  /** Used when every attempt fails, so the table can always keep moving. */
  fallback: T
  /**
   * Whether an account error (401/402/403) should throw straight out of `ask`.
   * True everywhere except a simultaneous round, where a throw would be
   * swallowed by `Promise.allSettled` — there the caller scans the results for
   * `fatalReason` and rethrows once every answer is in.
   */
  failFast?: boolean
}

/**
 * One game, driven a round at a time.
 *
 * Deliberately small: both original run loops already had exactly this shape,
 * and keeping it at four members is what stops the runner regrowing a method
 * per game. Anything a driver needs from outside comes through `DriverContext`.
 */
export interface GameDriver {
  readonly kind: GameKind

  /** Seats the roster and logs the opening line. Throws on an illegal table. */
  start(): void

  /**
   * Plays exactly one round or hand, roster reconciliation included, and says
   * whether the match should carry on. Returning 'ended' is how a game reports
   * its own end condition — a broke table, a lone survivor, a target score.
   */
  playRound(): Promise<'played' | 'ended'>

  /** Rounds completed, which is what "stop after N" counts. */
  readonly roundsPlayed: number

  /** The snapshot slot. The runner clones it; the driver need not. */
  readonly state: TableState

  /** The closing line, if the game has one. Called once, however the match ends. */
  finish(): void
}
