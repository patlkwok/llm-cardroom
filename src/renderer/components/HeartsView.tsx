import type { HeartsPlayer, HeartsState, MatchSettings } from '../../shared/types.ts'
import {
  COMPASS,
  SeatHand,
  SeatPlate,
  Stat,
  TrickCards,
  TrickCentre,
  TrickFlag,
  TrickResult,
  TrickSeat,
  TrickTable,
  type Compass
} from './TrickTable.tsx'

interface Props {
  state: HeartsState
  thinking: Record<string, boolean>
  targetScore: number
}

/** The felt before the first deal, so the seats are visible while setting up. */
export function emptyHeartsState(settings: MatchSettings): HeartsState {
  return {
    kind: 'hearts',
    phase: 'idle',
    handNumber: 0,
    handsPlayed: 0,
    passDirection: 'left',
    players: settings.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      modelId: player.modelId,
      seatIndex: index,
      hand: [],
      totalScore: 0,
      handScore: 0,
      lastHandScore: 0,
      tricksWon: 0,
      moonShots: 0,
      passedCards: [],
      receivedCards: []
    })),
    currentTrick: null,
    lastTrick: null,
    trickNumber: 0,
    leadSeatIndex: 0,
    actingSeatIndex: -1,
    heartsBroken: false,
    queenPlayed: false,
    forcedPlays: 0,
    totalPlays: 0
  }
}

const DIRECTION_LABEL: Record<string, string> = {
  left: 'passing left',
  right: 'passing right',
  across: 'passing across',
  hold: 'hold — no pass'
}

/** What the centre says while the three cards are on their way. */
const PASS_STEP: Record<'out' | 'in', Record<string, string>> = {
  out: {
    left: 'These three are going left…',
    right: 'These three are going right…',
    across: 'These three are going across…',
    hold: 'Nothing is passed this hand.'
  },
  in: {
    left: '…and these three arrived from the right.',
    right: '…and these three arrived from the left.',
    across: '…and these three arrived from across.',
    hold: 'Nothing was passed this hand.'
  }
}

export function HeartsView({ state, thinking, targetScore }: Props): React.JSX.Element {
  const seats = state.players
  // Lowest wins, so the leader is the *smallest* total. Everything about
  // highlighting inverts here relative to every other game in this app.
  const best = seats.length ? Math.min(...seats.map((p) => p.totalScore)) : 0
  const trick = state.currentTrick ?? state.lastTrick
  const trickIsLive = state.currentTrick !== null
  const passing =
    state.phase === 'passing' ||
    state.phase === 'passRevealed' ||
    state.phase === 'passReceived'

  return (
    <div className="felt felt-hearts">
      {/* No felt watermark here: the seats fill the whole felt and are
          translucent, so the brand text showed straight through four hands of
          cards. Only visible in a rendered frame. */}
      <TrickTable>
        {seats.length === 0 && <div className="empty-hand">No models seated yet.</div>}

        {seats.map((seat) => (
          <SeatBox
            key={seat.id}
            seat={seat}
            position={COMPASS[seat.seatIndex] ?? 'south'}
            acting={seat.seatIndex === state.actingSeatIndex}
            leading={seat.seatIndex === state.leadSeatIndex && state.phase === 'playing'}
            thinking={Boolean(thinking[seat.id])}
            isLeader={seat.totalScore === best && state.handsPlayed > 0}
            phase={state.phase}
          />
        ))}

        <TrickCentre
          heading={
            state.phase === 'idle'
              ? 'Waiting to start'
              : passing
                ? `Hand ${state.handNumber} · ${DIRECTION_LABEL[state.passDirection]}`
                : `Trick ${state.trickNumber} of 13`
          }
        >
          <TrickCards
            trick={trick}
            nameOf={(seatIndex) => state.players[seatIndex]?.name ?? ''}
            emptyText={
              state.phase === 'passing'
                ? 'Choosing cards to pass…'
                : state.phase === 'passRevealed'
                  ? PASS_STEP.out[state.passDirection]
                  : state.phase === 'passReceived'
                    ? PASS_STEP.in[state.passDirection]
                    : 'No cards played yet.'
            }
          />

          {/* The trick result gets a full step of its own before the cards are
              swept up, so it is legible rather than a flicker. */}
          {trick?.winnerName && !trickIsLive && (
            <TrickResult winnerName={trick.winnerName}>
              <span className={trick.points > 0 ? 'hearts-took-points' : 'hearts-took-none'}>
                {trick.points > 0
                  ? `+${trick.points} point${trick.points === 1 ? '' : 's'}`
                  : 'no points'}
              </span>
            </TrickResult>
          )}

          <div className="trick-flags">
            <TrickFlag on={state.heartsBroken}>
              ♥ {state.heartsBroken ? 'broken' : 'unbroken'}
            </TrickFlag>
            {/* The queen not breaking hearts is the rule people get wrong, so
                the two facts are shown side by side rather than merged. */}
            <TrickFlag on={state.queenPlayed}>
              ♠Q {state.queenPlayed ? 'played' : 'out there'}
            </TrickFlag>
          </div>

          {state.lastHandSummary && <div className="trick-summary">{state.lastHandSummary}</div>}
        </TrickCentre>
      </TrickTable>

      <div className="bj-stats">
        <Stat label="Hand" value={String(state.handNumber)} title="Hands dealt so far" />
        <Stat
          label="Leader"
          value={leaderText(seats, best, state.handsPlayed)}
          tone="good"
          title="Lowest total score — at hearts, that is who is winning"
        />
        <Stat
          label="Target"
          value={String(targetScore)}
          title="The match ends when anyone reaches this"
        />
        <Stat
          label="Tricks"
          value={`${state.trickNumber} / 13`}
          title="Tricks played in the hand under way"
        />
        <Stat
          label="Free plays"
          value={state.totalPlays > 0 ? `${state.forcedPlays} / ${state.totalPlays}` : '—'}
          title="Plays where only one card was legal, so no model was asked and nothing was charged"
        />
      </div>
    </div>
  )
}

function leaderText(seats: HeartsPlayer[], best: number, handsPlayed: number): string {
  if (seats.length === 0 || handsPlayed === 0) return '—'
  const leaders = seats.filter((p) => p.totalScore === best)
  return leaders.length === 1 ? `${leaders[0].name} ${best}` : `tied on ${best}`
}

function SeatBox({
  seat,
  position,
  acting,
  leading,
  thinking,
  isLeader,
  phase
}: {
  seat: HeartsPlayer
  position: Compass
  acting: boolean
  leading: boolean
  thinking: boolean
  isLeader: boolean
  phase: HeartsState['phase']
}): React.JSX.Element {
  return (
    <TrickSeat position={position} acting={acting || thinking} leader={isLeader}>
      <SeatPlate name={seat.name} modelId={seat.modelId} thinking={thinking}>
        <div className="trick-scores">
          {/* `score-lead` is the shared "this seat is winning" colour, put on
              whichever number the game actually reads. Lowest wins here. */}
          <span className="hearts-total score-lead" title="Total score — lowest wins">
            {seat.totalScore}
          </span>
          {seat.handScore > 0 && (
            <span className="hearts-hand-score" title="Points taken this hand">
              +{seat.handScore}
            </span>
          )}
          {seat.moonShots > 0 && (
            <span className="hearts-moon" title="Hands where this seat took all 26">
              ☾{seat.moonShots > 1 ? seat.moonShots : ''}
            </span>
          )}
        </div>
        <div className="trick-plate-meta">
          {leading && <span className="trick-lead-chip">leads</span>}
          <span className="trick-tricks">{seat.tricksWon} tricks</span>
        </div>
      </SeatPlate>

      <SeatHand
        cards={seat.hand}
        position={position}
        emptyText={phase === 'idle' ? 'waiting' : 'out of cards'}
        // Both steps lean their three cards towards the middle of the table;
        // the ring colour is what tells them apart, gold out and green in.
        marked={
          phase === 'passRevealed'
            ? seat.passedCards
            : phase === 'passReceived'
              ? seat.receivedCards
              : []
        }
        marking={phase === 'passRevealed' ? 'out' : 'in'}
      />
    </TrickSeat>
  )
}
