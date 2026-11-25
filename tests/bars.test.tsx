import { test, expect, mock } from 'claude-code/testing'

// Fixed clock so countdowns are predictable
const NOW = Date.parse('2026-10-03T10:00:00Z')

// One measurement: context 42%, 5-hour 63.5% (resets in 2h15m), 7-day 88% (resets in 3d5h)
const MEASURE = {
  context: { tokens: 84000, window: 200000, percent: 42 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 63.5, resetsAt: new Date(NOW + 2 * 3600e3 + 15 * 60e3).toISOString() },
    { kind: 'seven_day', percentUsed: 88, resetsAt: new Date(NOW + 3 * 86400e3 + 5 * 3600e3).toISOString() }
  ],
  changed: ['context', 'rateLimits']
} as any

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

const isIcon = (svg: any) => String(svg.props.source).includes('viewBox="0 0 18 18"')
const isBar = (svg: any) => String(svg.props.source).includes('non-scaling-stroke')
const isTime = (svg: any) => String(svg.props.source).includes('ui-monospace')

test('desktop draws three bars with icons, outlined percents and countdowns', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const svgs = await ui.findAll({ type: 'Svg' })

  // icon + bar + percent per block, plus a countdown where there is one (context has none)
  expect(svgs).toHaveLength(11)
  expect(svgs.map((svg) => svg.props.alt)).toEqual([
    'Context', 'Context 58%', '58%',
    '5-hour limit', '5-hour limit 37% (2h15m)', '37%', '2h15m',
    '7-day limit', '7-day limit 12% (3d5h)', '12%', '3d5h'
  ])

  // Icons: grey outline, accent follows usage (42% yellow-green, 63.5% orange, 88% red-orange), 18px
  const icons = svgs.filter(isIcon)
  expect(String(icons[0]!.props.source)).toContain('fill="#d6c800"')
  expect(String(icons[1]!.props.source)).toContain('fill="#ff9200"')
  expect(String(icons[2]!.props.source)).toContain('fill="#ff3000"')
  expect(icons.every((icon) => icon.props.width === 18 && String(icon.props.source).includes('stroke="#8a8a8a"'))).toBe(true)

  // Bars: plain images (no frame), round caps with non-scaling-stroke
  for (const svg of svgs.filter(isBar)) {
    expect(svg.props.isInteractive).toBeUndefined()
    expect(String(svg.props.source)).toContain('stroke-linecap="round"')
  }

  // Percent labels: white text with a dark outline
  for (const svg of svgs.filter((one) => /^\d+%$/.test(String(one.props.alt)))) {
    expect(String(svg.props.source)).toContain('paint-order="stroke"')
    expect(String(svg.props.source)).toContain(`>${svg.props.alt}</text>`)
  }

  // Countdowns: monospace
  expect(svgs.filter(isTime).map((svg) => svg.props.alt)).toEqual(['2h15m', '3d5h'])
})

for (const columns of [80, 120, 200]) {
  test(`desktop ${columns} columns: equal bars, blocks sized by content, row fully used`, async ($, on) => {
    setup(on)
    await $.session.measure(MEASURE)
    const ui = await $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: columns } })
    const segments = (await Promise.all(['context', 'five', 'week'].map((key) => ui.find({ key })))) as any[]
    const segmentWidths = segments.map((seg) => seg.props.width as number)

    expect(new Set(segments.map((seg) => seg.children[1].props.width)).size).toBe(1)
    const used = segmentWidths.reduce((a, b) => a + b, 0) + 2 * 2
    expect(used).toBeLessThanOrEqual(columns)
    expect(columns - used).toBeLessThan(3)
    for (const seg of segments) {
      const [iconBox, barBox, slot] = seg.children
      expect(iconBox.props.width + 1 + barBox.props.width + (slot ? 1 + slot.props.width : 0)).toBe(seg.props.width)
    }
    expect(segments[0].children).toHaveLength(2)
  })
}

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

test('5-hour and 7-day bars are split into hour / day pills with an even-pace marker; context stays plain', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const bars = (await ui.findAll({ type: 'Svg' })).filter(isBar).map((svg) => String(svg.props.source))
  const tracks = (source: string) => source.split('stroke="#3c3c3c"').length - 1

  // context: one track, no pace marker
  expect(tracks(bars[0]!)).toBe(1)
  expect(bars[0]!).not.toContain('class="pace"')

  // 5-hour: 5 pills; 36.5% left fills the first pill and most of the second; pace marker present
  const five = bars[1]!
  expect(tracks(five)).toBe(5)
  expect(five.split('url(#grad-five)').length - 1).toBe(2)
  expect(five).toContain('class="pace"')

  // 7-day: 7 pills; 12% left fills only the first pill (partly); resets in 3d5h → pace at 77h/168h of the bar
  const week = bars[2]!
  expect(tracks(week)).toBe(7)
  expect(week.split('url(#grad-week)').length - 1).toBe(1)
  expect(week).toContain('class="pace"')
})

test('7-day bar falls back to one plain bar when too narrow for pills', async ($, on) => {
  setup(on)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ plugin: 'mod-usage-remaining', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 30 } })
  const week = String((await ui.findAll({ type: 'Svg' })).filter(isBar)[2]!.props.source)
  expect(week.split('stroke="#3c3c3c"').length - 1).toBe(1)
  expect(week).toContain('class="pace"')
})
