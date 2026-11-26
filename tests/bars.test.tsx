import { test, expect, mock } from 'claude-code/testing'

// Fixed clock so countdowns are predictable
const NOW = Date.parse('2026-10-03T10:00:00Z')
const HOUR = 3600e3
const MINUTE = 60e3
const DAY = 86400e3

// A measurement with the given 5-hour / 7-day windows (null = no data for that window)
type TWindow = { used: number; resetsIn?: number } | null
const measure = (five: TWindow, week: TWindow, contextPercent = 42) =>
  ({
    context: { tokens: contextPercent * 2000, window: 200000, percent: contextPercent },
    rateLimits: [
      five ? { kind: 'five_hour', percentUsed: five.used, ...(five.resetsIn === undefined ? {} : { resetsAt: new Date(NOW + five.resetsIn).toISOString() }) } : null,
      week ? { kind: 'seven_day', percentUsed: week.used, ...(week.resetsIn === undefined ? {} : { resetsAt: new Date(NOW + week.resetsIn).toISOString() }) } : null
    ].filter((one) => one !== null),
    changed: ['context', 'rateLimits']
  }) as any

// context 42%; 5-hour 63.5% used, resets in 2h15m → 55% elapsed; 7-day 88% used, resets in 3d5h → 54% elapsed
const MEASURE = measure({ used: 63.5, resetsIn: 2 * HOUR + 15 * MINUTE }, { used: 88, resetsIn: 3 * DAY + 5 * HOUR })

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any

// Engine stand-ins beneath the plugin: clock, session.measure echo, an empty default drawing
const setup = (on: any) => {
  mock.clock(on, { now: NOW })
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const mount = ($: any, bodyColumns = PROPS.bodyColumns) =>
  $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })

const isIcon = (svg: any) => String(svg.props.source).includes('viewBox="0 0 18 18"')
const isBar = (svg: any) => String(svg.props.source).includes('non-scaling-stroke')
const isTime = (svg: any) => String(svg.props.source).includes('ui-monospace')
const isLabel = (svg: any) => /^\d+%$/.test(String(svg.props.alt))

const barSources = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Svg' })).filter(isBar).map((svg: any) => String(svg.props.source))
const iconSources = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Svg' })).filter(isIcon).map((svg: any) => String(svg.props.source))
const count = (source: string, needle: string) => source.split(needle).length - 1
const tracks = (source: string) => count(source, 'class="pill"')
const needleX = (source: string) => /class="needle" x1="([\d.]+)"/.exec(source)?.[1]

// The bar's x for a 0–1 fraction of the window, with the mod's pill maths (7px per column, 1px pill gap)
const pillX = (fraction: number, pills: number, cells: number): string => {
  const unitsPerPx = 1000 / (cells * 7)
  const gap = pills > 1 ? unitsPerPx : 0
  const share = 1000 / pills
  const scaled = Math.min(1, Math.max(0, fraction)) * pills
  const i = Math.min(pills - 1, Math.floor(scaled))
  const start = i * share + (i === 0 ? 0 : gap / 2)
  const end = (i + 1) * share - (i === pills - 1 ? 0 : gap / 2)
  return (start + (end - start) * (scaled - i)).toFixed(2)
}

const GREEN = '#34c759'
const AMBER = '#ffb020'
const RED = '#ff3b30'

test('desktop draws icon · used percent · bar · countdown per block', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($)
  const svgs: any[] = await ui.findAll({ type: 'Svg' })

  // icon + label + bar per block, plus a countdown where there is one (context has none)
  expect(svgs).toHaveLength(11)
  expect(svgs.map((svg) => svg.props.alt)).toEqual([
    'Context', '42%', 'Context 42%',
    '5-hour limit', '64%', '5-hour limit 64% (2h15m)', '2h15m',
    '7-day limit', '88%', '7-day limit 88% (3d5h)', '3d5h'
  ])

  // Icons: grey outline, 18px. Context accent follows usage (42% yellow-green);
  // quotas follow the risk state: 5h 8.5 points ahead → amber, 7d 34 points ahead → red
  const icons = await iconSources(ui)
  expect(icons[0]!).toContain('fill="#d6c800"')
  expect(icons[1]!).toContain(`fill="${AMBER}"`)
  expect(icons[2]!).toContain(`fill="${RED}"`)
  expect(svgs.filter(isIcon).every((icon) => icon.props.width === 18 && String(icon.props.source).includes('stroke="#8a8a8a"'))).toBe(true)

  // Bars: plain images (no frame), round caps with non-scaling-stroke, 8px tall, never mirrored
  for (const svg of svgs.filter(isBar)) {
    expect(svg.props.isInteractive).toBeUndefined()
    expect(svg.props.height).toBe(8)
    expect(String(svg.props.source)).toContain('stroke-linecap="round"')
    expect(String(svg.props.source)).not.toContain('scale(-1')
  }

  // Percent labels: white text with a dark outline, the bare used percent, 12px in the normal row
  for (const svg of svgs.filter(isLabel)) {
    expect(String(svg.props.source)).toContain('paint-order="stroke"')
    expect(String(svg.props.source)).toContain('font-size="12"')
    expect(String(svg.props.source)).toContain(`>${svg.props.alt}</text>`)
  }

  // Countdowns: monospace
  expect(svgs.filter(isTime).map((svg) => svg.props.alt)).toEqual(['2h15m', '3d5h'])
})

// Expected layout per row width: label slot, gap between blocks, fixed widths (icon · label · countdown + inner gaps),
// bar length, leftover columns absorbed by flexGrow, and the label font size
const LAYOUTS = [
  { columns: 120, labelCells: 5, gap: 2, fixed: [10, 17, 16], bar: 24, leftover: 1, fontSize: 12 },
  // normal row would give 11-column bars (< 12, the 7-day pill minimum) → compact labels and a 1-column gap
  { columns: 80, labelCells: 4, gap: 1, fixed: [9, 16, 15], bar: 12, leftover: 2, fontSize: 11 },
  { columns: 200, labelCells: 5, gap: 2, fixed: [10, 17, 16], bar: 51, leftover: 0, fontSize: 12 }
]

for (const layout of LAYOUTS) {
  test(`desktop ${layout.columns} columns: equal bars, fixed label slot, row fully used`, async ($, on) => {
    setup(on)
    await $.session.measure(MEASURE)
    const ui = await mount($, layout.columns)
    const segments = (await Promise.all(['context', 'five', 'week'].map((key) => ui.find({ key })))) as any[]
    const root: any = await ui.drawn()
    const row = root.props.flexDirection === 'column' ? root.children[0] : root

    expect(row.props.columnGap).toBe(layout.gap)
    expect(segments[0].children).toHaveLength(3)
    expect(segments[1].children).toHaveLength(4)
    expect(segments[2].children).toHaveLength(4)

    for (const [i, seg] of segments.entries()) {
      const [iconBox, labelBox, barBox, slot] = seg.children
      expect(labelBox.props.width).toBe(layout.labelCells)
      expect(labelBox.props.justifyContent).toBe('flex-end')
      expect(barBox.props.width).toBe(layout.bar)
      expect(seg.props.width - barBox.props.width).toBe(layout.fixed[i])
      expect(iconBox.props.width + 1 + labelBox.props.width + 1 + barBox.props.width + (slot ? 1 + slot.props.width : 0)).toBe(seg.props.width)
    }

    const used = segments.reduce((sum, seg) => sum + seg.props.width, 0) + layout.gap * 2
    expect(layout.columns - used).toBe(layout.leftover)

    const labels = (await ui.findAll({ type: 'Svg' })).filter(isLabel)
    expect(labels.every((svg: any) => String(svg.props.source).includes(`font-size="${layout.fontSize}"`))).toBe(true)

    // 5 hour pills and 7 day pills at every one of these widths (no plain-bar fallback at 80 columns)
    const bars = await barSources(ui)
    expect(tracks(bars[0]!)).toBe(1)
    expect(tracks(bars[1]!)).toBe(5)
    expect(tracks(bars[2]!)).toBe(7)
  })
}

test('label SVGs are wide enough for bold digits, the wide "%" and the outline, so the right-anchored text never clips', async ($, on) => {
  setup(on)
  for (const columns of [120, 80]) {
    await $.session.measure(MEASURE)
    const ui = await mount($, columns)
    for (const svg of ((await ui.findAll({ type: 'Svg' })) as any[]).filter(isLabel)) {
      const source = String(svg.props.source)
      const size = Number(/font-size="(\d+)"/.exec(source)![1])
      const stroke = Number(/stroke-width="([\d.]+)"/.exec(source)![1])
      const anchor = Number(/<text x="([\d.]+)"/.exec(source)![1])
      // measured in Chromium: bold digits ≈ 0.69em, "%" ≈ 1.04em
      const glyphs = [...String(svg.props.alt)].reduce((sum, ch) => sum + size * (ch === '%' ? 1.04 : 0.69), 0)
      expect(anchor - glyphs - stroke / 2).toBeGreaterThanOrEqual(0)
      expect(anchor + stroke / 2).toBeLessThanOrEqual(svg.props.width)
    }
  }
})

test('the percent is a sibling slot left of the bar, not an overlay', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($)
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some((box: any) => box.props.position === 'absolute' || box.props.position === 'relative')).toBe(false)

  const five: any = await ui.find({ key: 'five' })
  expect(five.children[1].children).toHaveLength(1)
  expect(five.children[1].children[0].props.alt).toBe('64%')
  expect(five.children[2].children).toHaveLength(1)
  expect(five.children[2].children[0].props.alt).toBe('5-hour limit 64% (2h15m)')
})

test('the needle marks elapsed time, not the fill tip; the band runs from the needle to the tip', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($)
  const [, five, week] = await barSources(ui)

  // 5-hour: 55% elapsed, 63.5% used; bar 24 columns, 5 pills
  expect(needleX(five!)).toBe(pillX(0.55, 5, 24))
  expect(needleX(five!)).not.toBe(pillX(0.635, 5, 24))
  expect(five!).toContain(`id="band-five" gradientUnits="userSpaceOnUse" x1="${pillX(0.55, 5, 24)}" y1="0" x2="${pillX(0.635, 5, 24)}"`)

  // Needle: 4px dark halo then 2px white core, full height, butt caps, drawn after everything else
  expect(five!).toContain('class="needle-halo"')
  expect(five!).toContain('stroke="#1e1e1e" stroke-width="4" stroke-linecap="butt"')
  expect(five!).toContain('stroke="#ffffff" stroke-width="2" stroke-linecap="butt"')
  expect(five!).toMatch(/class="needle" x1="[\d.]+" y1="0" x2="[\d.]+" y2="8"/)
  expect(five!.indexOf('class="needle-halo"')).toBeGreaterThan(five!.lastIndexOf('class="band"'))
  expect(five!.indexOf('class="needle"')).toBeGreaterThan(five!.indexOf('class="needle-halo"'))

  // 7-day: 77h of 168h left → 54.2% elapsed
  expect(needleX(week!)).toBe(pillX(1 - 77 / 168, 7, 24))
})

test('2% used with 95% elapsed: needle near reset, green headroom, no warm colour', async ($, on) => {
  setup(on)
  // the screenshot's row: 7-day 67% used with 13h45m left keeps three blocks, so the bars are 24 columns
  await $.session.measure(measure({ used: 2, resetsIn: 15 * MINUTE }, { used: 67, resetsIn: 13 * HOUR + 45 * MINUTE }, 9))
  const ui = await mount($)
  const [, five] = await barSources(ui)

  expect(needleX(five!)).toBe(pillX(0.95, 5, 24))
  expect(Number(needleX(five!))).toBeGreaterThan(900)
  expect(five!).not.toContain('class="band"')
  expect(five!).not.toContain(AMBER)
  expect(five!).not.toContain(RED)
  expect((await iconSources(ui))[1]!).toContain(`fill="${GREEN}"`)
})

test('headroom (used ≤ elapsed) draws no warm band: 10% used at 20% elapsed, 67% used at 92% elapsed', async ($, on) => {
  setup(on)
  await $.session.measure(measure({ used: 10, resetsIn: 4 * HOUR }, { used: 67, resetsIn: 13 * HOUR + 45 * MINUTE }))
  const ui = await mount($)
  const [, five, week] = await barSources(ui)

  for (const bar of [five!, week!]) {
    expect(bar).not.toContain('class="band"')
    expect(bar).not.toContain(AMBER)
    expect(bar).not.toContain(RED)
    expect(bar).toContain(`class="fill"`)
    expect(bar).toContain(`fill="${GREEN}"`)
    expect(bar).toContain('class="needle"')
  }
  expect(needleX(five!)).toBe(pillX(0.2, 5, 24))

  const icons = await iconSources(ui)
  expect(icons[1]!).toContain(`fill="${GREEN}"`)
  expect(icons[2]!).toContain(`fill="${GREEN}"`)
})

test('used ahead of elapsed draws an amber → red band from now to the fill tip, through the pill mask', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($)
  const [, five, week] = await barSources(ui)

  // 5-hour: green fill from the start to 63.5%, band from now (55%) to the tip; both clipped to the pills by the mask
  expect(five!).toContain('<g mask="url(#pills-five)">')
  expect(count(five!, 'class="fill"')).toBe(1)
  expect(count(five!, 'class="band"')).toBe(1)
  expect(five!).toContain(`class="band" x="${pillX(0.55, 5, 24)}"`)
  expect(five!).toContain('fill="url(#band-five)"')
  expect(five!).toContain(`<stop offset="0" stop-color="${AMBER}"/><stop offset="1" stop-color="${RED}"/>`)
  // base fill stays calm green below 90% used
  expect(five!).toContain(`class="fill" x="0.00" y="0" width="${pillX(0.635, 5, 24)}"`)
  expect(five!).toContain(`fill="${GREEN}"`)

  // 7-day: band from now (54%) to 88%
  expect(count(week!, 'class="band"')).toBe(1)
  expect(week!).toContain(`class="band" x="${pillX(1 - 77 / 168, 7, 24)}"`)
})

test('pills are short rounded segments, not dots, at 80 columns; the bar keeps round outer ends', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($, 80)
  const week = (await barSources(ui))[2]!
  const pills = [...week.matchAll(/class="pill" x="[\d.]+" y="0" width="([\d.]+)" height="8" rx="([\d.]+)" ry="2"/g)]
  expect(pills).toHaveLength(7)
  // bar 12 columns ≈ 84px: inner pills ≈ 11px wide with 2px corners, wider than the 8px bar is tall
  const pxPerUnit = (12 * 7) / 1000
  for (const pill of pills.slice(1, -1)) {
    expect(Number(pill[1]) * pxPerUnit).toBeGreaterThan(10)
    expect(Math.abs(Number(pill[2]) * pxPerUnit - 2)).toBeLessThan(0.05)
  }
  // two round-capped, non-scaling outer caps in the mask
  expect(count(week, 'stroke="#fff" stroke-width="8" stroke-linecap="round" vector-effect="non-scaling-stroke"')).toBe(2)
})

test('near the limit the fill and icon alarm: 99% used is red, 92% used is amber', async ($, on) => {
  setup(on)
  // both barely ahead of the clock (overshoot < 3 points), so only the level decides
  await $.session.measure(measure({ used: 99, resetsIn: 10 * MINUTE }, { used: 92, resetsIn: 13 * HOUR + 45 * MINUTE }))
  const ui = await mount($)
  const [, five, week] = await barSources(ui)
  const icons = await iconSources(ui)

  expect(five!).toMatch(new RegExp(`class="fill"[^>]*fill="${RED}"`))
  expect(icons[1]!).toContain(`fill="${RED}"`)
  expect(week!).toMatch(new RegExp(`class="fill"[^>]*fill="${AMBER}"`))
  expect(icons[2]!).toContain(`fill="${AMBER}"`)
})

test('context is one green → yellow → red gradient pill with no needle or band', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($)
  const [context] = await barSources(ui)

  expect(tracks(context!)).toBe(1)
  expect(context!).toContain('fill="url(#grad-context)"')
  expect(context!.indexOf('#00c800')).toBeLessThan(context!.indexOf('#ffc800'))
  expect(context!.indexOf('#ffc800')).toBeLessThan(context!.indexOf('#ff0000'))
  expect(context!).not.toContain('needle')
  expect(context!).not.toContain('class="band"')
})

test('64 columns: compact row still fits, but the 7-day bar is too short for pills and falls back to a plain bar', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($, 64)
  const root: any = await ui.drawn()
  const row = root.props.flexDirection === 'column' && root.children[0].props.flexDirection ? root.children[0] : root
  expect(row.props.flexDirection).toBe('row')
  expect(row.props.columnGap).toBe(1)
  const week = (await barSources(ui))[2]!
  expect(tracks(week)).toBe(1)
  expect(week).toContain('class="needle"')
})

test('30 columns: blocks stack one per row with aligned bars, countdowns and pills kept, nothing overflows', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($, 30)
  const root: any = await ui.drawn()
  const rows = root.children[0]
  expect(rows.props.flexDirection).toBe('column')
  expect(rows.props.width).toBe(30)

  const segments = (await Promise.all(['context', 'five', 'week'].map((key) => ui.find({ key })))) as any[]
  // widest fixed part is the 5-hour block (17) → every bar gets 30 − 17 = 13 columns; normal 12px labels, slot 5
  const fixed = [10, 17, 16]
  for (const [i, seg] of segments.entries()) {
    const [, labelBox, barBox] = seg.children
    expect(seg.props.flexGrow).toBe(0)
    expect(labelBox.props.width).toBe(5)
    expect(barBox.props.width).toBe(13)
    expect(seg.props.width).toBe(fixed[i]! + 13)
    expect(seg.props.width).toBeLessThanOrEqual(30)
  }

  const svgs: any[] = await ui.findAll({ type: 'Svg' })
  expect(svgs.filter(isTime).map((svg) => svg.props.alt)).toEqual(['2h15m', '3d5h'])
  expect(svgs.filter(isLabel).every((svg) => String(svg.props.source).includes('font-size="12"'))).toBe(true)
  const bars = await barSources(ui)
  expect(tracks(bars[1]!)).toBe(5)
  expect(tracks(bars[2]!)).toBe(7)
})

const narrowWidths = async (ui: any) =>
  ((await Promise.all(['context', 'five', 'week'].map((key) => ui.find({ key })))) as any[]).map((seg) => seg.props.width as number)

test('22 columns: stacked compact blocks keep 6-column plain bars and countdowns', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($, 22)
  const bars = await barSources(ui)
  expect(bars).toHaveLength(3)
  expect(bars.every((bar) => tracks(bar) === 1)).toBe(true)
  expect((await ui.findAll({ type: 'Svg' })).filter(isTime)).toHaveLength(2)
  expect((await narrowWidths(ui)).every((width) => width <= 22)).toBe(true)
})

test('20 columns: stacked blocks drop the bar, keep icon risk colour, percent and countdown; nothing overflows', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($, 20)
  const svgs: any[] = await ui.findAll({ type: 'Svg' })
  expect(svgs.filter(isBar)).toHaveLength(0)
  // with the bar gone, its full name moves to the icon
  expect(svgs.map((svg) => svg.props.alt)).toEqual([
    'Context 42%', '42%',
    '5-hour limit 64% (2h15m)', '64%', '2h15m',
    '7-day limit 88% (3d5h)', '88%', '3d5h'
  ])
  const icons = await iconSources(ui)
  expect(icons[1]!).toContain(`fill="${AMBER}"`)
  expect(icons[2]!).toContain(`fill="${RED}"`)
  // icon 3 · compact label 4 · countdown: 8 / 15 / 14 columns
  expect(await narrowWidths(ui)).toEqual([8, 15, 14])
})

test('12 columns: icon and percent only; below 8 columns nothing is drawn', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await mount($, 12)
  const svgs: any[] = await ui.findAll({ type: 'Svg' })
  expect(svgs.map((svg) => svg.props.alt)).toEqual(['Context 42%', '42%', '5-hour limit 64% (2h15m)', '64%', '7-day limit 88% (3d5h)', '88%'])
  expect(await narrowWidths(ui)).toEqual([8, 8, 8])

  const tiny = await mount($, 7)
  expect(await tiny.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('a missing or past reset time draws no needle, band or countdown; a missing window is omitted', async ($, on) => {
  setup(on)
  await $.session.measure(measure({ used: 63.5 }, null))
  const ui = await mount($)
  expect(await ui.find({ key: 'week' })).toBeUndefined()
  const svgs: any[] = await ui.findAll({ type: 'Svg' })
  expect(svgs.map((svg) => svg.props.alt)).toEqual(['Context', '42%', 'Context 42%', '5-hour limit', '64%', '5-hour limit 64%'])
  const five = (await barSources(ui))[1]!
  expect(five).not.toContain('needle')
  expect(five).not.toContain('class="band"')

  await $.session.measure(measure({ used: 63.5, resetsIn: -5 * MINUTE }, null))
  const past = (await barSources(ui))[1]!
  expect(past).not.toContain('needle')
  expect((await ui.findAll({ type: 'Svg' })).filter(isTime)).toHaveLength(0)
})

test('terminal is left to the engine (the status line already shows usage)', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('nothing is drawn before the first measurement', async ($, on) => {
  setup(on)
  const ui = await $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
})

test('content drawn by mods beneath is stacked under the bars', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('ui.render', ($: any, e: any) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="below-mod">
        <Text>below mod</Text>
      </Box>
    )
  })
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const root: any = await ui.drawn()

  expect(root.props.flexDirection).toBe('column')
  expect(root.children).toHaveLength(2)
  expect(root.children[0].props.width).toBe(PROPS.bodyColumns)
  expect(root.children[1].key ?? root.children[1].props?.key).toBe('below-mod')
  const texts = (await ui.findAll({ type: 'Text' })).map((one: any) => one.text).join('')
  expect(texts).toContain('below mod')
})
