// The Local Font Access API, which Chromium has and the DOM typings do not yet.
declare global {
  interface Window {
    queryLocalFonts?: () => Promise<{ family: string }[]>
  }
}

let families: Promise<string[] | null> | null = null

// The font families installed here, sorted, each once; null where the browser cannot list them.
// Chromium lists them only for a visible page and a user's gesture, so this is asked from a click,
// and a failed ask is not kept, so the next click tries again.
export function systemFontFamilies(): Promise<string[] | null> {
  if (!window.queryLocalFonts) return Promise.resolve(null)
  families ??= window.queryLocalFonts().then(
    (fonts) => [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b)),
    () => {
      families = null
      return null
    }
  )
  return families
}

// A family name as a CSS font-family value: quoted, so names with spaces or digits read right.
export function cssFontFamily(family: string): string {
  return `"${family.trim().replace(/["\\]/g, '\\$&')}"`
}
