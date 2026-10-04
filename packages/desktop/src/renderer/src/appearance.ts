import { setNativeTheme } from './desktop-bridge'
import { usePreferences, type Preferences } from './preferences'

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

// The CSS resolves the tokens: [data-theme] pins a theme, its absence follows the system, and
// [data-palette] picks the set of colours.
function apply(theme: Preferences['theme'], palette: Preferences['palette']): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
  document.documentElement.dataset.palette = palette
  setNativeTheme(theme)
}

export function startAppearance(): void {
  const { theme, palette } = usePreferences.getState()
  apply(theme, palette)
  usePreferences.subscribe((next, previous) => {
    if (next.theme !== previous.theme || next.palette !== previous.palette) {
      apply(next.theme, next.palette)
    }
  })
}

export function isDarkTheme(): boolean {
  return getComputedStyle(document.documentElement).colorScheme === 'dark'
}

// Fires when the colours may have changed: a system switch, or a new theme or palette.
export function onThemeChange(listener: () => void): () => void {
  systemDark.addEventListener('change', listener)
  const unsubscribe = usePreferences.subscribe((next, previous) => {
    if (next.theme !== previous.theme || next.palette !== previous.palette) {
      listener()
    }
  })
  return () => {
    systemDark.removeEventListener('change', listener)
    unsubscribe()
  }
}
