/** The form controls every game's rules panel is built from. */

export function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </label>
  )
}

/**
 * Spinner arrows step from `min`, not from zero, so callers should keep `min`
 * a multiple of `step` — otherwise a min of 1 with a step of 5 yields 1, 6, 11.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  suffix
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  suffix?: string
}): React.JSX.Element {
  return (
    <>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
      {suffix && <span className="field-suffix">{suffix}</span>}
    </>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}
