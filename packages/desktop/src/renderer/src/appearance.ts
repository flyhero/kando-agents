import { setNativeTheme } from './desktop-bridge'
import { usePreferences, type Preferences } from './preferences'

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

// The CSS resolves the tokens: [data-theme] pins a theme, its absence follows the system.
function apply(theme: Preferences['theme']): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
  setNativeTheme(theme)
}

export function startAppearance(): void {
  apply(usePreferences.getState().theme)
  usePreferences.subscribe((next, previous) => {
    if (next.theme !== previous.theme) {
      apply(next.theme)
    }
  })
}

export function isDarkTheme(): boolean {
  return getComputedStyle(document.documentElement).colorScheme === 'dark'
}

// Fires when the effective theme may have changed: a system switch or a new preference.
export function onThemeChange(listener: () => void): () => void {
  systemDark.addEventListener('change', listener)
  const unsubscribe = usePreferences.subscribe((next, previous) => {
    if (next.theme !== previous.theme) {
      listener()
    }
  })
  return () => {
    systemDark.removeEventListener('change', listener)
    unsubscribe()
  }
}
