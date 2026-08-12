import { cardCode, type Card } from '../../shared/cards.ts'
import type { HeartsPlayer, HeartsState, MatchSettings } from '../../shared/types.ts'
import { PlayingCard } from './PlayingCard.tsx'

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

export function HeartsView({ state, thinking, targetScore }: Props): React.JSX.Element {
  const seats = state.players
  // Lowest wins, so the leader is the *smallest* total. Everything about
  // highlighting inverts here relative to every other game in this app.
  const best = seats.length ? Math.min(...seats.map((p) => p.totalScore)) : 0
  const trick = state.currentTrick ?? state.lastTrick
  const trickIsLive = state.currentTrick !== null

  return (
    <div className="felt felt-hearts">
      {/* No felt watermark here. The seat strips fill the whole felt, and the
          strips are translucent, so the brand text showed straight through the
          middle of four hands of cards. Only visible in a rendered frame. */}
      <div className="hearts-table">
        <div className="hearts-seats">
          {seats.length === 0 && <div className="empty-hand">No models seated yet.</div>}
          {seats.map((seat) => (
            <SeatStrip
              key={seat.id}
              seat={seat}
              acting={seat.seatIndex === state.actingSeatIndex}
              leading={seat.seatIndex === state.leadSeatIndex && state.phase === 'playing'}
              thinking={Boolean(thinking[seat.id])}
              isLeader={seat.totalScore === best && state.handsPlayed > 0}
              phase={state.phase}
            />
          ))}
        </div>

        <div className="hearts-centre">
          <div className="hearts-trick-head">
            {state.phase === 'idle'
              ? 'Waiting to start'
              : state.phase === 'passing'
                ? `Hand ${state.handNumber} · ${DIRECTION_LABEL[state.passDirection]}`
                : `Trick ${state.trickNumber} of 13`}
          </div>

          <div className="hearts-trick">
            {trick && trick.plays.length > 0 ? (
              trick.plays.map((play) => (
                <div
                  key={`${play.seatId}-${cardCode(play.card)}`}
                  className={
                    'hearts-trick-play' +
                    (trick.winnerSeatIndex === play.seatIndex ? ' hearts-trick-winner' : '')
                  }
                >
                  <PlayingCard card={play.card} size="md" dimmed={!trickIsLive} />
                  <span className="hearts-trick-who">{state.players[play.seatIndex]?.name}</span>
                </div>
              ))
            ) : (
              <div className="hearts-trick-empty">
                {state.phase === 'passing' ? 'Choosing cards to pass…' : 'No cards played yet.'}
              </div>
            )}
          </div>

          {trick?.winnerName && !trickIsLive && (
            <div className="hearts-trick-result">
              {trick.winnerName} takes it
              {trick.points > 0 ? ` · ${trick.points} point${trick.points === 1 ? '' : 's'}` : ' · no points'}
            </div>
          )}

          <div className="hearts-flags">
            <span className={state.heartsBroken ? 'hearts-flag on' : 'hearts-flag'}>
              ♥ {state.heartsBroken ? 'broken' : 'unbroken'}
            </span>
            {/* The queen not breaking hearts is the rule people get wrong, so
                the two facts are shown side by side rather than merged. */}
            <span className={state.queenPlayed ? 'hearts-flag on' : 'hearts-flag'}>
              ♠Q {state.queenPlayed ? 'played' : 'out there'}
            </span>
          </div>

          {state.lastHandSummary && (
            <div className="hearts-summary">{state.lastHandSummary}</div>
          )}
        </div>
      </div>

      <div className="bj-stats">
        <Stat label="Hand" value={String(state.handNumber)} title="Hands dealt so far" />
        <Stat
          label="Leader"
          value={leaderText(seats, best, state.handsPlayed)}
          tone="good"
          title="Lowest total score — at hearts, that is who is winning"
        />
        <Stat label="Target" value={String(targetScore)} title="The match ends when anyone reaches this" />
        <Stat
          label="Tricks"
          value={`${state.trickNumber} / 13`}
          title="Tricks played in the hand under way"
        />
        <Stat
          label="Free plays"
          value={
            state.totalPlays > 0
              ? `${state.forcedPlays} / ${state.totalPlays}`
              : '—'
          }
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

function SeatStrip({
  seat,
  acting,
  leading,
  thinking,
  isLeader,
  phase
}: {
  seat: HeartsPlayer
  acting: boolean
  leading: boolean
  thinking: boolean
  isLeader: boolean
  phase: HeartsState['phase']
}): React.JSX.Element {
  const classes = ['hearts-seat']
  if (acting || thinking) classes.push('hearts-seat-acting')
  if (isLeader) classes.push('hearts-seat-leader')

  return (
    <div className={classes.join(' ')}>
      <div className="hearts-plate">
        <span className={`seat-name${thinking ? ' seat-thinking' : ''}`}>
          {/* The name needs its own element: text-overflow does not apply to a
              flex container, so putting it directly here clips long names
              mid-character instead of ellipsising them. */}
          <span className="seat-name-text">{seat.name}</span>
          {thinking && <span className="dots"><i /><i /><i /></span>}
        </span>
        <div className="hearts-scores">
          <span className="hearts-total" title="Total score — lowest wins">
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
        <div className="hearts-plate-meta">
          {leading && <span className="hearts-lead-chip">leads</span>}
          <span className="hearts-tricks">{seat.tricksWon} tricks</span>
        </div>
        <div className="seat-model">{seat.modelId}</div>
      </div>

      <div className="hearts-hand">
        {seat.hand.length === 0 ? (
          <div className="hearts-empty-hand">
            {phase === 'idle' ? 'waiting' : 'out of cards'}
          </div>
        ) : (
          // The spectator sees every hand, exactly as at poker. The models never
          // do: their prompts render only their own.
          <Fan cards={seat.hand} />
        )}
      </div>
    </div>
  )
}

/**
 * Thirteen cards is far too wide for a card row at this felt width, so they
 * overlap. Width is the layout risk in this game, not seat count.
 */
function Fan({ cards }: { cards: Card[] }): React.JSX.Element {
  return (
    <div className="card-fan">
      {cards.map((card) => (
        <PlayingCard key={cardCode(card)} card={card} size="sm" />
      ))}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  title
}: {
  label: string
  value: string
  tone?: 'good' | 'bad'
  title?: string
}): React.JSX.Element {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` stat-${tone}` : ''}`}>{value}</div>
    </div>
  )
}
