import { isRed, rankLabel, suitSymbol, type Card } from '../../shared/cards.ts'

interface Props {
  card?: Card
  /** Renders the patterned back instead of the face. */
  faceDown?: boolean
  size?: 'sm' | 'md' | 'lg'
  dimmed?: boolean
}

export function PlayingCard({ card, faceDown, size = 'md', dimmed }: Props): React.JSX.Element {
  const classes = ['card', `card-${size}`]
  if (dimmed) classes.push('card-dimmed')

  if (faceDown || !card) {
    return <div className={[...classes, 'card-back'].join(' ')} aria-label="face-down card" />
  }

  classes.push(isRed(card) ? 'card-red' : 'card-black')
  const rank = rankLabel(card.rank)
  const suit = suitSymbol(card.suit)

  return (
    <div className={classes.join(' ')} aria-label={`${rank}${suit}`}>
      <span className="card-corner card-corner-tl">
        <span className="card-rank">{rank}</span>
        <span className="card-suit">{suit}</span>
      </span>
      <span className="card-pip">{suit}</span>
      <span className="card-corner card-corner-br">
        <span className="card-rank">{rank}</span>
        <span className="card-suit">{suit}</span>
      </span>
    </div>
  )
}

export function CardRow({
  cards,
  faceDown,
  size = 'md',
  hideAfterFirst
}: {
  cards: Card[]
  faceDown?: boolean
  size?: 'sm' | 'md' | 'lg'
  /** Blackjack dealer: first card up, the rest face down. */
  hideAfterFirst?: boolean
}): React.JSX.Element {
  return (
    <div className="card-row">
      {cards.map((card, index) => (
        <PlayingCard
          key={`${card.rank}${card.suit}-${index}`}
          card={card}
          size={size}
          faceDown={faceDown || (hideAfterFirst && index > 0)}
        />
      ))}
      {cards.length === 0 && <div className="card-placeholder" />}
    </div>
  )
}
