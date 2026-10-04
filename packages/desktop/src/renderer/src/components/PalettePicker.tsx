import { PALETTES, PALETTE_LABEL, type Palette } from '../palettes'
import { setPreference, usePreferences } from '../preferences'

// A palette as a card split down the middle, its light side and its dark side: the canvas, a
// surface on it, the accent and a line of text, drawn in that palette's own tokens.
function Swatch({ palette }: { palette: Palette }) {
  return (
    <span className="palette-swatch" data-palette={palette} aria-hidden="true">
      {(['light', 'dark'] as const).map((scheme) => (
        <span key={scheme} className="palette-swatch-half" data-scheme={scheme}>
          <span className="palette-swatch-card">
            <i className="palette-swatch-dot" />
            <i className="palette-swatch-line" />
          </span>
        </span>
      ))}
    </span>
  )
}

export function PalettePicker({ labelId }: { labelId: string }) {
  const palette = usePreferences((s) => s.palette)
  return (
    <div className="palette-picker" role="radiogroup" aria-labelledby={labelId}>
      {PALETTES.map((each) => (
        <button
          key={each}
          type="button"
          role="radio"
          aria-checked={each === palette}
          className="palette-option"
          aria-label={`${PALETTE_LABEL[each].name}：${PALETTE_LABEL[each].origin}`}
          title={PALETTE_LABEL[each].origin}
          onClick={() => setPreference('palette', each)}
        >
          <Swatch palette={each} />
          <span className="palette-name">{PALETTE_LABEL[each].name}</span>
        </button>
      ))}
    </div>
  )
}
