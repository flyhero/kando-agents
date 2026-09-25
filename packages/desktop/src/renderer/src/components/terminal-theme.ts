import type { ITheme } from '@xterm/xterm'
import { isDarkTheme } from '../appearance'

type AnsiPalette = Pick<
  ITheme,
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
>

// Warm hues to sit with the app's dark surfaces.
const DARK_ANSI: AnsiPalette = {
  black: '#4a4843',
  red: '#ef6b62',
  green: '#6bbf7a',
  yellow: '#e0b44c',
  blue: '#6ea3f5',
  magenta: '#c690e8',
  cyan: '#5cc4c4',
  white: '#d6d4cc',
  // CLIs print secondary text in bright black, so it must stay readable (≈4.8:1).
  brightBlack: '#8a8679',
  brightRed: '#ff8a80',
  brightGreen: '#8fd99b',
  brightYellow: '#f2cd6d',
  brightBlue: '#93bbff',
  brightMagenta: '#dcb0f5',
  brightCyan: '#82dcdc',
  brightWhite: '#f5f4ef'
}

// Darker hues that stay readable on white. "White" becomes gray: CLIs print it
// expecting a dark background, and true white would vanish here.
const LIGHT_ANSI: AnsiPalette = {
  black: '#1f1e1b',
  red: '#b3261e',
  green: '#2f7a3f',
  yellow: '#8a6a00',
  blue: '#2f5fc4',
  magenta: '#8a3fb3',
  cyan: '#1c7a7a',
  white: '#6f6b61',
  brightBlack: '#6f6b61',
  brightRed: '#d0433a',
  brightGreen: '#3b8a4f',
  brightYellow: '#a37f00',
  brightBlue: '#3f74de',
  brightMagenta: '#a052cc',
  brightCyan: '#248f8f',
  brightWhite: '#8a8578'
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Chrome colors come from the app's CSS tokens, so the terminal reads as part of the page.
export function terminalTheme(): ITheme {
  return {
    background: token('--surface'),
    foreground: token('--text'),
    cursor: token('--accent'),
    cursorAccent: token('--surface'),
    selectionBackground: token('--focus'),
    scrollbarSliderBackground: `${token('--text-muted')}55`,
    scrollbarSliderHoverBackground: `${token('--text-muted')}88`,
    scrollbarSliderActiveBackground: `${token('--text-muted')}aa`,
    ...(isDarkTheme() ? DARK_ANSI : LIGHT_ANSI)
  }
}
