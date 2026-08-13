import type { GameKind, MatchSettings } from '../../../shared/types.ts'
import { Field, NumberInput, Toggle } from './controls.tsx'

export interface RulesPanelProps {
  settings: MatchSettings
  /** Merges a partial into the settings; the parent owns the state. */
  patch: (partial: Partial<MatchSettings>) => void
  /** A match is under way, so anything that would invalidate the table is fixed. */
  locked: boolean
  running: boolean
  playerCount: number
}

type RulesPanel = (props: RulesPanelProps) => React.JSX.Element

function BlackjackRules({ settings, patch, locked, running, playerCount }: RulesPanelProps): React.JSX.Element {
  const bj = settings.blackjack
  return (
    <>
      <Field label="Starting bankroll">
        <NumberInput
          value={bj.startingBankroll}
          min={100}
          step={100}
          disabled={locked}
          onChange={(startingBankroll) => patch({ blackjack: { ...bj, startingBankroll } })}
        />
      </Field>
      {/* Editable mid-match: a new stake applies from the next round. */}
      <Field label={bj.modelChoosesBet ? 'Table minimum' : 'Bet per hand'}>
        <NumberInput
          value={bj.baseBet}
          min={5}
          step={5}
          onChange={(baseBet) => patch({ blackjack: { ...bj, baseBet } })}
        />
      </Field>
      <Toggle
        label="Model chooses its own bet"
        checked={bj.modelChoosesBet}
        onChange={(modelChoosesBet) => patch({ blackjack: { ...bj, modelChoosesBet } })}
      />
      {bj.modelChoosesBet && (
        <p className="panel-hint">
          Before each deal the model is shown its bankroll and record, then picks
          a wager between the table minimum and its whole bankroll.
        </p>
      )}
      {running && (
        <p className="panel-hint">
          Stake changes take effect on the next round, not the hand in play.
        </p>
      )}
      <Field label="Decks in shoe">
        <NumberInput
          value={bj.deckCount}
          min={1}
          max={8}
          disabled={locked}
          onChange={(deckCount) => patch({ blackjack: { ...bj, deckCount } })}
        />
      </Field>
      {playerCount > 1 && (
        <p className="panel-hint">
          All {playerCount} seats are dealt from that one shoe, and each model is
          shown the others' cards. A real shoe game is face up, and it is what
          makes counting the cards possible.
        </p>
      )}
      <Toggle
        label="Offer insurance on dealer ace"
        checked={bj.offerInsurance}
        disabled={locked}
        onChange={(offerInsurance) => patch({ blackjack: { ...bj, offerInsurance } })}
      />
      <Toggle
        label="Dealer hits soft 17"
        checked={bj.dealerHitsSoft17}
        disabled={locked}
        onChange={(dealerHitsSoft17) => patch({ blackjack: { ...bj, dealerHitsSoft17 } })}
      />
      <Toggle
        label="Double after split"
        checked={bj.doubleAfterSplit}
        disabled={locked}
        onChange={(doubleAfterSplit) => patch({ blackjack: { ...bj, doubleAfterSplit } })}
      />
    </>
  )
}

function PokerRules({ settings, patch, locked }: RulesPanelProps): React.JSX.Element {
  const poker = settings.poker
  return (
    <>
      <Field label="Starting stack">
        <NumberInput
          value={poker.startingStack}
          min={100}
          step={100}
          disabled={locked}
          onChange={(startingStack) => patch({ poker: { ...poker, startingStack } })}
        />
      </Field>
      <Field label="Small blind">
        <NumberInput
          value={poker.smallBlind}
          min={1}
          disabled={locked}
          onChange={(smallBlind) => patch({ poker: { ...poker, smallBlind } })}
        />
      </Field>
      <Field label="Big blind">
        <NumberInput
          value={poker.bigBlind}
          min={2}
          disabled={locked}
          onChange={(bigBlind) => patch({ poker: { ...poker, bigBlind } })}
        />
      </Field>
      <Field label="Double blinds every">
        <NumberInput
          value={poker.blindIncreaseEvery}
          min={0}
          disabled={locked}
          suffix="hands (0 = never)"
          onChange={(blindIncreaseEvery) => patch({ poker: { ...poker, blindIncreaseEvery } })}
        />
      </Field>
      <p className="panel-hint">
        You see every hole card, like a televised table. Each model still sees
        only its own.
      </p>
    </>
  )
}

function HeartsRules({ settings, patch, locked }: RulesPanelProps): React.JSX.Element {
  const hearts = settings.hearts
  return (
    <>
      <Field label="Game ends at">
        <NumberInput
          value={hearts.targetScore}
          min={25}
          step={25}
          disabled={locked}
          suffix="points"
          onChange={(targetScore) => patch({ hearts: { ...hearts, targetScore } })}
        />
      </Field>
      {/* Every one of these is a decision, not a lookup: variants genuinely
          disagree, and a model that guesses one plays a different game from the
          one being dealt. They are stated in force in the system prompt too. */}
      <p className="panel-hint">
        Hearts score 1 each and the queen of spades 13. <strong>Lowest total
        wins.</strong> Pass three left, right, across, then hold. The two of
        clubs leads, no points fall on the first trick, and the queen of spades
        does <em>not</em> break hearts — only a heart does.
      </p>
      <p className="panel-hint">
        Shooting the moon — taking all 26 — scores 26 to everybody else instead.
      </p>
      <p className="panel-hint">
        Exactly four models, fixed for the match: no joining or leaving. When
        only one card is legal it is played without asking a model, which is
        free and cannot be answered illegally.
      </p>
    </>
  )
}

function TwentyFourRules({ settings, patch, locked, playerCount }: RulesPanelProps): React.JSX.Element {
  const rules = settings.twentyfour
  return (
    <>
      <Field label="First to">
        <NumberInput
          value={rules.targetScore}
          min={0}
          disabled={locked}
          suffix="wins (0 = no limit)"
          onChange={(targetScore) => patch({ twentyfour: { ...rules, targetScore } })}
        />
      </Field>
      <p className="panel-hint">
        Four cards, combined with + − × ÷ and brackets to make 24. Aces are 1,
        jacks 11, queens 12, kings 13. Every card is used exactly once and
        division is exact, not rounded.
      </p>
      <p className="panel-hint">
        Unsolvable deals are dealt on purpose — <strong>"no solution" is a legal
        answer</strong>, and grading it is the only way to catch a model
        inventing an expression that does not evaluate.
      </p>
      {/* Cost is the thing that surprises people here. The comparison this used
          to draw — "none of poker's cheap hands" — meant nothing to anyone
          reading the 24 panel; say the actual consequence instead. */}
      <p className={playerCount > 3 ? 'panel-warn' : 'panel-hint'}>
        Every seat answers every puzzle at once, so a round always costs{' '}
        {playerCount || 'one'} {playerCount === 1 ? 'call' : 'calls'} — nobody
        drops out part way and there is no cheap round. Keep "stop after
        puzzles" set.
      </p>
      <p className="panel-hint">
        The round goes to the fastest correct answer, timed on the model's own
        answering attempt — a retry after rate limiting is not counted against
        it. Solve rate and median time are the numbers worth reading.
      </p>
    </>
  )
}

export const RULES_PANELS: Record<GameKind, RulesPanel> = {
  blackjack: BlackjackRules,
  poker: PokerRules,
  hearts: HeartsRules,
  twentyfour: TwentyFourRules
}
