import {
  tableOf,
  type GameKind,
  type MatchSettings,
  type MatchSnapshot,
  type TableState
} from '../../shared/types.ts'
import { BlackjackView, emptyBlackjackState } from './BlackjackView.tsx'
import { HeartsView, emptyHeartsState } from './HeartsView.tsx'
import { PokerView, emptyPokerState } from './PokerView.tsx'
import { TwentyFourView, emptyTwentyFourState } from './TwentyFourView.tsx'

export interface GameViewProps {
  snapshot: MatchSnapshot | null
  settings: MatchSettings
  thinking: Record<string, boolean>
}

type GameView = (props: GameViewProps) => React.JSX.Element

/**
 * Which felt to draw. Keyed off the game rather than branched on it, so a new
 * game is one entry here rather than another arm of a ternary in App.
 */
export const GAME_VIEWS: Partial<Record<GameKind, GameView>> = {
  blackjack: ({ snapshot, settings, thinking }) => (
    <BlackjackView
      state={tableOf(snapshot, 'blackjack') ?? emptyBlackjackState(settings)}
      thinking={thinking}
      rules={settings.blackjack}
    />
  ),
  poker: ({ snapshot, settings, thinking }) => (
    <PokerView
      state={tableOf(snapshot, 'poker') ?? emptyPokerState(settings)}
      thinking={thinking}
    />
  ),
  hearts: ({ snapshot, settings, thinking }) => (
    <HeartsView
      state={tableOf(snapshot, 'hearts') ?? emptyHeartsState(settings)}
      thinking={thinking}
      targetScore={settings.hearts.targetScore}
    />
  ),
  twentyfour: ({ snapshot, settings, thinking }) => (
    <TwentyFourView
      state={tableOf(snapshot, 'twentyfour') ?? emptyTwentyFourState(settings)}
      thinking={thinking}
      targetScore={settings.twentyfour.targetScore}
    />
  )
}

/** What the status bar counts, whatever this game calls its rounds. */
export function roundNumberOf(table: TableState | null | undefined): number {
  if (!table) return 0
  switch (table.kind) {
    case 'blackjack':
      return table.roundNumber
    case 'poker':
      return table.handNumber
    case 'hearts':
      return table.handNumber
    case 'twentyfour':
      return table.roundNumber
  }
}

/** The seats actually dealt in, whose setup is therefore frozen. */
export function seatedIdsOf(table: TableState | null | undefined): string[] {
  if (!table) return []
  switch (table.kind) {
    case 'blackjack':
      return table.players.map((player) => player.id)
    case 'poker':
      return table.seats.map((seat) => seat.id)
    case 'hearts':
      return table.players.map((player) => player.id)
    case 'twentyfour':
      return table.players.map((player) => player.id)
  }
}
