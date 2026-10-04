// The palettes the interface comes in. Each is a block of tokens in styles.css under
// [data-palette]; this is the list the settings offer and the preference is checked against.
export const PALETTES = ['terracotta', 'indigo', 'nord', 'paper', 'catppuccin'] as const
export type Palette = (typeof PALETTES)[number]

// Each palette's name, and where its colours come from, for the settings.
export const PALETTE_LABEL: Record<Palette, { name: string; origin: string }> = {
  terracotta: { name: '赤陶', origin: 'Kando 的默认，中性灰阶配赤陶色' },
  indigo: { name: '靛蓝', origin: '取自 Linear：冷灰和一点靛蓝' },
  nord: { name: '极夜', origin: '取自 Nord：极地的蓝灰和霜色' },
  paper: { name: '宣纸', origin: '取自 Notion 和阅读器的暖纸色，配古铜' },
  catppuccin: { name: '猫爪', origin: '取自 Catppuccin：Latte 与 Mocha，配淡紫' }
}
