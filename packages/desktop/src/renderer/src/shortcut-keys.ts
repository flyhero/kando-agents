// macOS uses ⌘ where Windows and Linux use Ctrl.
export const IS_MAC = navigator.platform.startsWith('Mac')

export const PRIMARY_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl+'

export function hasPrimaryModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey
}
