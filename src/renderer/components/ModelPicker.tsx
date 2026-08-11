import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '../../shared/types.ts'

interface Props {
  open: boolean
  title: string
  onPick: (model: ModelInfo) => void
  onClose: () => void
}

function formatPrice(perMillion: number): string {
  if (perMillion === 0) return 'free'
  if (perMillion < 1) return `$${perMillion.toFixed(3)}`
  return `$${perMillion.toFixed(2)}`
}

export function ModelPicker({ open, title, onPick, onClose }: Props): React.JSX.Element | null {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [highlight, setHighlight] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    void load(false)
    // Focus lands in the search box so typing filters immediately.
    setTimeout(() => searchRef.current?.focus(), 40)
  }, [open])

  async function load(force: boolean): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const result = await window.cardroom.listModels(force)
      setModels(result.models)
      if (result.models.length === 0) {
        setError('OpenRouter returned no models.')
      }
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, ''))
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return models
    return models.filter((model) => {
      const haystack = `${model.name} ${model.id}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [models, query])

  useEffect(() => {
    setHighlight(0)
  }, [query])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('.model-row-active')
    node?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  if (!open) return null

  function handleKey(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const model = filtered[highlight]
      if (model) onPick(model)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()} onKeyDown={handleKey}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-search">
          <input
            ref={searchRef}
            value={query}
            placeholder="Search the OpenRouter catalogue…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="ghost-button" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="model-list" ref={listRef}>
          {loading && models.length === 0 && <div className="model-empty">Fetching models…</div>}
          {!loading && filtered.length === 0 && !error && (
            <div className="model-empty">Nothing matches “{query}”.</div>
          )}
          {filtered.slice(0, 400).map((model, index) => (
            <button
              key={model.id}
              className={`model-row${index === highlight ? ' model-row-active' : ''}`}
              onClick={() => onPick(model)}
              onMouseEnter={() => setHighlight(index)}
            >
              <div className="model-main">
                <span className="model-name">{model.name}</span>
                <span className="model-id">{model.id}</span>
              </div>
              <div className="model-meta">
                <span title="Context window">
                  {model.contextLength ? `${Math.round(model.contextLength / 1000)}k ctx` : '—'}
                </span>
                <span title="Price per million tokens (in / out)">
                  {formatPrice(model.promptPrice)} / {formatPrice(model.completionPrice)}
                </span>
              </div>
            </button>
          ))}
        </div>

        <div className="modal-foot">
          <span>
            {filtered.length} of {models.length} models
            {filtered.length > 400 && ' (showing the first 400)'}
          </span>
          <span className="hint">↑↓ to move · Enter to pick · Esc to close</span>
        </div>
      </div>
    </div>
  )
}
