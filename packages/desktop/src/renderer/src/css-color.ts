// A colour as getComputedStyle gives it, with another alpha: "rgb(1, 2, 3)" and
// "rgba(1, 2, 3, 0.5)" both become "rgba(1, 2, 3, <alpha>)". Anything else is returned as it came,
// since there is nothing safe to do with it.
export function withAlpha(color: string, alpha: number): string {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/.exec(color.trim())
  if (!match) return color
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`
}
