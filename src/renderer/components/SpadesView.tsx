import type {
  MatchSettings,
  SpadesPlayer,
  SpadesRules,
  SpadesState,
  SpadesTeam
} from '../../shared/types.ts'
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
  state: SpadesState
  thinking: Record<string, boolean>
  rules: SpadesRules
}

const TEAM_NAMES = ['North–South', 'East–West']

/** The felt before the first deal, so the seats are visible while setting up. */
export function emptySpadesState(settings: MatchSettings): SpadesState {
  const players = settings.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    modelId: player.modelId,
    seatIndex: index,
    teamIndex: index % 2,
    hand: [],
    bid: null,
    blindNil: false,
    tricksWon: 0,
    lastHandTricks: 0,
    nilsBid: 0,
    nilsMade: 0
  }))
  return {
    kind: 'spades',
    phase: 'idle',
    handNumber: 0,
    handsPlayed: 0,
    players,
    teams: [0, 1].map((index) => ({
      index,
      name: TEAM_NAMES[index],
      seatIndices: players.filter((p) => p.teamIndex === index).map((p) => p.seatIndex),
      score: 0,
      bags: 0,
      contract: 0,
      tricksWon: 0,
      lastHandDelta: 0
    })),
    dealerIndex: -1,
    biddingSeatIndex: -1,
    currentTrick: null,
    lastTrick: null,
    trickNumber: 0,
    leadSeatIndex: 0,
    actingSeatIndex: -1,
    spadesBroken: false,
    forcedPlays: 0,
    totalPlays: 0
  }
}

export function SpadesView({ state, thinking, rules }: Props): React.JSX.Element {
  const seats = state.players
  const trick = state.currentTrick ?? state.lastTrick
  const trickIsLive = state.currentTrick !== null
  const bidding = state.phase === 'bidding' || state.phase === 'blindBidding'
  const blindBidding = state.phase === 'blindBidding'
  // Highest total wins here, the ordinary way round — Hearts is the odd one out.
  const best = state.teams.length ? Math.max(...state.teams.map((t) => t.score)) : 0
  const leadingTeams = state.teams.filter((t) => t.score === best).map((t) => t.index)

  return (
    <div className="felt felt-spades">
      <TrickTable>
        {seats.length === 0 && <div className="empty-hand">No models seated yet.</div>}

        {/* Partners sit opposite: seats 0 and 2 are North–South, 1 and 3 are
            East–West. The compass the shared table already draws *is* the
            partnership structure, so it needs no legend — only a tint. */}
        {seats.map((seat) => (
          <SeatBox
            key={seat.id}
            seat={seat}
            position={COMPASS[seat.seatIndex] ?? 'south'}
            acting={seat.seatIndex === state.actingSeatIndex}
            bidding={bidding && seat.seatIndex === state.biddingSeatIndex}
            leading={seat.seatIndex === state.leadSeatIndex && state.phase === 'playing'}
            dealer={seat.seatIndex === state.dealerIndex}
            thinking={Boolean(thinking[seat.id])}
            isLeader={state.handsPlayed > 0 && leadingTeams.includes(seat.teamIndex)}
            phase={state.phase}
          />
        ))}

        <TrickCentre
          heading={
            state.phase === 'idle'
              ? 'Waiting to start'
              : bidding
                ? `Hand ${state.handNumber} · ${blindBidding ? 'blind nil offer' : 'bidding'}`
                : `Trick ${state.trickNumber} of 13`
          }
        >
          <TrickCards
            trick={trick}
            nameOf={(seatIndex) => state.players[seatIndex]?.name ?? ''}
            emptyText={
              blindBidding
                ? 'Blind nil offered — nobody has seen their cards…'
                : bidding
                  ? 'Bidding…'
                  : 'No cards played yet.'
            }
          />

          {/* The trick result gets a step of its own before the cards are swept
              up, so it is legible rather than a flicker. */}
          {trick?.winnerName && !trickIsLive && trick.winnerSeatIndex !== undefined && (
            <TrickResult winnerName={trick.winnerName}>
              <span className={`sp-took sp-team-${state.players[trick.winnerSeatIndex].teamIndex}`}>
                for {state.teams[state.players[trick.winnerSeatIndex].teamIndex]?.name}
              </span>
            </TrickResult>
          )}

          <div className="trick-flags">
            <TrickFlag on={state.spadesBroken}>
              ♠ {state.spadesBroken ? 'broken' : 'unbroken'}
            </TrickFlag>
          </div>

          {/* The two partnerships, side by side. Contract against tricks taken
              is the number the whole hand turns on, so it sits in the middle
              rather than in the stats bar. */}
          <div className="sp-teams">
            {state.teams.map((team) => (
              <TeamCard
                key={team.index}
                team={team}
                live={state.phase === 'playing' || state.phase === 'handComplete'}
                leading={state.handsPlayed > 0 && leadingTeams.includes(team.index)}
              />
            ))}
          </div>

          {state.lastHandSummary && <div className="trick-summary">{state.lastHandSummary}</div>}
        </TrickCentre>
      </TrickTable>

      <div className="bj-stats">
        <Stat label="Hand" value={String(state.handNumber)} title="Hands dealt so far" />
        <Stat
          label="Leader"
          value={leaderText(state.teams, best, state.handsPlayed)}
          tone="good"
          title="Highest partnership score — the match ends when one reaches the target"
        />
        <Stat
          label="Target"
          value={String(rules.targetScore)}
          title={
            rules.bustScore < 0
              ? `The match ends when a partnership reaches this, or falls to ${rules.bustScore}`
              : 'The match ends when a partnership reaches this'
          }
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

function leaderText(teams: SpadesTeam[], best: number, handsPlayed: number): string {
  if (teams.length === 0 || handsPlayed === 0) return '—'
  const leaders = teams.filter((t) => t.score === best)
  return leaders.length === 1 ? `${leaders[0].name} ${best}` : `level on ${best}`
}

function TeamCard({
  team,
  live,
  leading
}: {
  team: SpadesTeam
  /** Cards are out, so contract-against-tricks is the number that matters. */
  live: boolean
  leading: boolean
}): React.JSX.Element {
  const short = team.name === 'North–South' ? 'N–S' : 'E–W'
  // Bags are a slow-burning penalty, so they get louder as ten approaches.
  const bagTone = team.bags >= 8 ? ' sp-bags-warn' : ''
  return (
    <div className={`sp-team sp-team-${team.index}${leading ? ' sp-team-leading' : ''}`}>
      <span className="sp-team-name">{short}</span>
      <span className={`sp-team-score${leading ? ' score-lead' : ''}`} title={`${team.name} total`}>
        {team.score}
      </span>
      {live && (
        <span
          className="sp-team-contract"
          title="Tricks taken against the partnership's contract"
        >
          {team.tricksWon}/{team.contract}
        </span>
      )}
      {/* Spelled out, not an emoji. A bag glyph rendered as an unreadable box
          in the captured frame on this machine, and "0<box>" beside another
          number reads as nothing at all. Pluralised from the real value, so it
          never says "1 bags". */}
      <span className={`sp-team-bags${bagTone}`} title="Bags carried — every 10 costs 100 points">
        {team.bags} {team.bags === 1 ? 'bag' : 'bags'}
      </span>
    </div>
  )
}

function SeatBox({
  seat,
  position,
  acting,
  bidding,
  leading,
  dealer,
  thinking,
  isLeader,
  phase
}: {
  seat: SpadesPlayer
  position: Compass
  acting: boolean
  bidding: boolean
  leading: boolean
  dealer: boolean
  thinking: boolean
  isLeader: boolean
  phase: SpadesState['phase']
}): React.JSX.Element {
  const isNil = seat.bid === 0
  // A live nil is the most fragile thing on the table, so say whether it is
  // still alive rather than only that it was bid.
  const nilBroken = isNil && seat.tricksWon > 0

  return (
    <TrickSeat position={position} acting={acting || bidding || thinking} leader={isLeader}>
      <div className={`sp-seat-team sp-team-${seat.teamIndex}`}>
        <SeatPlate name={seat.name} modelId={seat.modelId} thinking={thinking}>
          <div className="trick-scores">
            {seat.bid === null ? (
              <span className="sp-bid sp-bid-none" title="Has not bid yet">
                —
              </span>
            ) : isNil ? (
              <span
                className={
                  (nilBroken ? 'sp-bid sp-nil-broken' : 'sp-bid sp-nil') +
                  (seat.blindNil ? ' sp-blind' : '')
                }
                title={
                  seat.blindNil
                    ? nilBroken
                      ? 'Blind nil — declared unseen, and already broken: −200'
                      : 'Blind nil: declared before seeing a card, for +200'
                    : nilBroken
                      ? 'Nil bid, and already broken — −100'
                      : 'Nil bid: no tricks at all, for +100'
                }
              >
                {seat.blindNil ? (nilBroken ? 'BLIND ✕' : 'BLIND NIL') : nilBroken ? 'NIL ✕' : 'NIL'}
              </span>
            ) : (
              <span className="sp-bid" title="Tricks bid">
                bid {seat.bid}
              </span>
            )}
            <span className="sp-tricks" title="Tricks taken this hand">
              {seat.tricksWon} taken
            </span>
          </div>
          <div className="trick-plate-meta">
            {dealer && <span className="sp-dealer-chip" title="Deals this hand">D</span>}
            {leading && <span className="trick-lead-chip">leads</span>}
            {seat.nilsMade > 0 && (
              <span className="sp-nil-count" title="Nils brought home this match">
                ♠{seat.nilsMade}
              </span>
            )}
          </div>
        </SeatPlate>
      </div>

      <SeatHand
        cards={seat.hand}
        position={position}
        emptyText={phase === 'idle' ? 'waiting' : 'out of cards'}
      />
    </TrickSeat>
  )
}
