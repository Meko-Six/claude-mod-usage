import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Locale, QuotaUsage, QuotaWindow } from '../types'
import { DEFAULT_LOCALE, MESSAGES, localeFromLanguageName, normalizeLocale } from './i18n'

// claude-mod-usage-remaining: Claude context / 5-hour / 7-day usage as used-first bars above the prompt; the 5-hour and 7-day
// bars are the window's clock (one pill per hour / day) with a `now` needle and an amber → red band for allowance spent ahead of schedule

// Bar keys: React key, SVG id prefix and icon table key
const SegmentKey = {
  CONTEXT: 'context',
  FIVE: 'five',
  WEEK: 'week'
} as const
type TSegmentKey = (typeof SegmentKey)[keyof typeof SegmentKey]

// What one bar draws
interface ISegmentInput {
  key: TSegmentKey // bar key
  name: string // screen-reader name, localized
  percent: number // percent used, 0-100
  resetsAt?: number // reset time (epoch ms); the context bar has none
}

// Layout
const SEGMENT_GAP = 2 // columns between bar blocks
const COMPACT_SEGMENT_GAP = 1 // columns between bar blocks in the narrow mode
const MIN_BAR_LEN = 6 // a bar never gets narrower than this many columns
const CELL_PX_ESTIMATE = 7 // rough px per column (the API has no real value); used to inset round caps and size text slots

// Bar
const BAR_HEIGHT = 8 // bar thickness (CSS px)
const EMPTY_COLOR = '#3c3c3c' // unfilled track
// 5-hour and 7-day bars: one pill per hour / day (boundaries on the time axis), a small gap between pills
const FIVE_HOURS = 5
const FIVE_MS = 5 * 3_600_000
const WEEK_DAYS = 7
const WEEK_MS = 7 * 86_400_000
const PILL_GAP_PX = 1 // estimated px (see CELL_PX_ESTIMATE); Desktop columns run ~2x the estimate, so 1 ≈ 4 device px at @2x
const MIN_PILL_PX = 12
const PILL_RADIUS_PX = 2 // corner radius of a pill's inner ends (estimated px); small, so short pills read as segments, not dots
// Below this many columns per bar the 7-day bar loses its pills (7 pills × 12px = 84px = 12 columns), so the row goes compact
const NARROW_BAR_CELLS = (WEEK_DAYS * MIN_PILL_PX) / CELL_PX_ESTIMATE

// Quota bar colours: calm green fill, level alarm only near the end, amber → red band for allowance spent ahead of schedule
const QUOTA_OK_COLOR = '#34c759'
const QUOTA_WARN_COLOR = '#ffb020'
const QUOTA_ALARM_COLOR = '#ff3b30'
const LEVEL_WARN_PERCENT = 90 // used ≥ this: amber fill and icon
const LEVEL_ALARM_PERCENT = 97 // used ≥ this: red fill and icon
const OVERSHOOT_WARN_POINTS = 3 // used − elapsed ≥ this: amber icon
const OVERSHOOT_ALARM_POINTS = 15 // used − elapsed ≥ this: red icon
// `now` needle: a 2px white core on a 4px dark halo, full bar height, drawn last
const NEEDLE_COLOR = '#ffffff'
const NEEDLE_HALO_COLOR = '#1e1e1e'

// Percent label beside the bar: white text with a dark outline, right-aligned in a fixed slot left of the bar
const LABEL_HEIGHT = 16
const LABEL_FILL_COLOR = '#ffffff'
const LABEL_STROKE_COLOR = '#1e1e1e'
// `charPx` sizes the label's SLOT in columns (chars × charPx + 6 → cells); the SVG itself is sized from real glyph widths
const LABEL_STYLES = {
  normal: { fontSize: 12, charPx: 8, stroke: 3 },
  compact: { fontSize: 11, charPx: 7, stroke: 2.5 } // narrow mode: saves a column per block
} as const
// Bold system-font glyphs (measured in Chromium with SF Pro): digits ≈ 0.69em, "%" ≈ 1.04em; rounded up so nothing clips
const LABEL_DIGIT_EM = 0.72
const LABEL_PERCENT_EM = 1.08
type TLabelStyle = keyof typeof LABEL_STYLES

// Reset countdown to the right of the bar: monospace digits
const TIME_FONT_SIZE = 12
const TIME_HEIGHT = 16
const TIME_ASCII_PX = 7.4 // monospace Latin glyph (≈0.6em)
const TIME_WIDE_PX = 12.5 // CJK glyph (≈1em), falls back to the system CJK font
const TIME_OTHER_PX = 9 // other scripts (Devanagari, Bengali, Arabic, Cyrillic) in their fallback font
const TIME_COLOR = '#c8c8c8'
const TIME_FONT = `font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="500"`

// Icons: two-tone line icons, grey outline + an accent colour that follows usage
const ICON_SIZE = 18 // CSS px
const ICON_CELLS = 3 // columns an icon takes (18px ≈ 2.6 columns)
const ICON_LINE_COLOR = '#8a8a8a' // mid grey, visible on dark and light themes
const ICON_FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" font-weight="700"`

// Session state: latest usage and the resolved display language
const usage = atom({ plugin: 'mod-usage-remaining', key: 'usage' } as const, null)
const locale = atom({ plugin: 'mod-usage-remaining', key: 'locale' } as const, DEFAULT_LOCALE)

// Picks one rate-limit window and converts resetsAt to epoch ms
const _pickWindow = (rateLimits: SessionRateLimit[], kind: string): QuotaWindow | undefined => {
  const found = rateLimits.find((limit) => limit.kind === kind)
  if (!found) return undefined

  const resetsAt = found.resetsAt ? Date.parse(found.resetsAt) : NaN
  return Number.isNaN(resetsAt) ? { percent: found.percentUsed } : { percent: found.percentUsed, resetsAt }
}

// The fields session.measure and $.session.usage() share, as this mod's QuotaUsage
const _toQuotaUsage = (context: SessionContextUsage, rateLimits: SessionRateLimit[]): QuotaUsage => ({
  contextPercent: context.percent,
  fiveHour: _pickWindow(rateLimits, 'five_hour'),
  sevenDay: _pickWindow(rateLimits, 'seven_day')
})

// Time left until reset, in the display language's format; empty once it has passed
const _formatRemaining = (resetsAt: number | undefined, nowMs: number, messages: (typeof MESSAGES)[keyof typeof MESSAGES]): string => {
  if (!resetsAt) return ''

  const diff = Math.floor((resetsAt - nowMs) / 1000)
  if (diff <= 0) return ''

  const days = Math.floor(diff / 86400)
  const hours = Math.floor((diff % 86400) / 3600)
  const minutes = Math.floor((diff % 3600) / 60)
  if (days > 0) return messages.daysHours(days, hours)
  if (hours > 0) return messages.hoursMinutes(hours, minutes)
  return messages.minutes(minutes)
}

// Gradient colour at a usage level: green → yellow → red (same stops as the bar)
const _accentColor = (percent: number): string => {
  const pos = Math.min(100, Math.max(0, percent))
  const red = pos <= 50 ? Math.round((pos * 255) / 50) : 255
  const green = pos <= 50 ? 200 : Math.round(200 - ((pos - 50) * 200) / 50)
  const toHex = (value: number) => value.toString(16).padStart(2, '0')
  return `#${toHex(red)}${toHex(green)}00`
}

// Escapes text placed inside SVG markup
const _escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Shared 18×18 shell of the two-tone icons
const _iconSvg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="${ICON_SIZE}" height="${ICON_SIZE}" fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

// Icons: context = speech bubble with three dots, 5-hour = stopwatch "5", 7-day = calendar "7"
const _iconSources: Record<TSegmentKey, (accent: string) => string> = {
  context: (accent) =>
    _iconSvg(
      `<path d="M4.5 3h9A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H8.6L5.2 15.6V13h-.7A2.5 2.5 0 0 1 2 10.5v-5A2.5 2.5 0 0 1 4.5 3z" stroke="${ICON_LINE_COLOR}" stroke-width="1.5"/>` +
        `<circle cx="5.8" cy="8" r="1.25" fill="${accent}"/><circle cx="9" cy="8" r="1.25" fill="${accent}"/><circle cx="12.2" cy="8" r="1.25" fill="${accent}"/>`
    ),
  five: (accent) =>
    _iconSvg(
      `<circle cx="9" cy="10.4" r="6.3" stroke="${ICON_LINE_COLOR}" stroke-width="1.5"/>` +
        `<path d="M9 4.1V2.2M7.3 1.6h3.4" stroke="${ICON_LINE_COLOR}" stroke-width="1.5"/>` +
        `<text x="9" y="10.6" text-anchor="middle" dominant-baseline="central" font-size="9" ${ICON_FONT} fill="${accent}">5</text>`
    ),
  week: (accent) =>
    _iconSvg(
      `<rect x="2.25" y="3.5" width="13.5" height="12.75" rx="2.5" stroke="${ICON_LINE_COLOR}" stroke-width="1.5"/>` +
        `<path d="M6 1.75V5M12 1.75V5M2.25 7.25h13.5" stroke="${ICON_LINE_COLOR}" stroke-width="1.5"/>` +
        `<text x="9" y="11.6" text-anchor="middle" dominant-baseline="central" font-size="8.5" ${ICON_FONT} fill="${accent}">7</text>`
    )
}

// Percent label: outlined SVG text (Text has no outline); a fixed width/height keeps it from being stretched.
// Text is anchored at the right edge, inset by half the outline, so it sits tight against the bar. The SVG is as wide
// as the glyphs plus the outline, so the left edge never clips; `cells` (the slot) keeps the column estimate, so at
// exactly 7px per column a compact label may reach a couple of px into the gap before it
const _labelSvg = (label: string, style: TLabelStyle = 'normal'): { source: string; width: number; cells: number } => {
  const { fontSize, charPx, stroke } = LABEL_STYLES[style]
  const glyphPx = [...label].reduce((sum, char) => sum + fontSize * (char === '%' ? LABEL_PERCENT_EM : LABEL_DIGIT_EM), 0)
  const width = Math.ceil(glyphPx + stroke + 1)
  const anchorX = width - stroke / 2 - 0.5
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${LABEL_HEIGHT}" width="${width}" height="${LABEL_HEIGHT}">`,
    `<text x="${anchorX}" y="${LABEL_HEIGHT / 2}" text-anchor="end" dominant-baseline="central" font-size="${fontSize}" ${ICON_FONT}`,
    ` fill="${LABEL_FILL_COLOR}" stroke="${LABEL_STROKE_COLOR}" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke">${_escapeXml(label)}</text>`,
    '</svg>'
  ].join('')
  return { source, width, cells: Math.ceil((label.length * charPx + 6) / CELL_PX_ESTIMATE) }
}

// Glyph width of the countdown text, per script
const _timeGlyphPx = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x80) return TIME_ASCII_PX
  return code >= 0x2e80 ? TIME_WIDE_PX : TIME_OTHER_PX
}

// Reset countdown: monospace SVG text (Text cannot choose a font), fixed size so it is not stretched.
// Right-to-left scripts are laid out RTL from the right edge, otherwise digits and units swap places
const _timeSvg = (text: string, rtl = false): { source: string; width: number; cells: number } => {
  const textPx = [...text].reduce((sum, char) => sum + _timeGlyphPx(char), 0)
  const width = Math.ceil(textPx + 2)
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${TIME_HEIGHT}" width="${width}" height="${TIME_HEIGHT}">`,
    rtl
      ? `<text x="${width - 1}" y="${TIME_HEIGHT / 2}" direction="rtl" unicode-bidi="embed" dominant-baseline="central" font-size="${TIME_FONT_SIZE}" ${TIME_FONT} fill="${TIME_COLOR}">${_escapeXml(text)}</text>`
      : `<text x="1" y="${TIME_HEIGHT / 2}" dominant-baseline="central" font-size="${TIME_FONT_SIZE}" ${TIME_FONT} fill="${TIME_COLOR}">${_escapeXml(text)}</text>`,
    '</svg>'
  ].join('')
  return { source, width, cells: Math.ceil(width / CELL_PX_ESTIMATE) }
}

// The bar fills left → right with USED. Drawn as a plain image (an isInteractive frame paints a white background on
// Desktop, showing past the round ends). The image is stretched horizontally to the column width, so:
//   - the bar's shape is a mask: one rounded rectangle per pill (small corners, so short pills read as segments, not
//     dots), plus a round cap at each outer end of the whole bar. The caps are round-capped lines with non-scaling-stroke,
//     so they stay circular however far the image is stretched; the corner radius is set in estimated px;
//   - track, fill and band are plain rectangles drawn through that mask, so they follow the pills and skip the gaps;
//   - the needle is a non-scaling stroke, so its width is exact px.
// Context: one pill, filled with a green → yellow → red gradient across the whole bar (green at 0%, red at 100%).
// 5-hour / 7-day: the track is the window's clock, split into `segments` pills (one per hour / day). The pills are only
// boundaries on the axis: the fill is still allowance used and can stop mid-pill. With `elapsedPercent`:
//   - a `now` needle marks elapsed time (never the fill tip), drawn last so nothing covers it;
//   - fill past `now` is allowance spent ahead of schedule, drawn as an amber → red band from `now` to the fill tip.
//   Fill short of `now` is headroom and stays calm green.
interface IBarOptions {
  segments?: number
  elapsedPercent?: number
}

const _clampPercent = (value: number): number => Math.min(100, Math.max(0, value))
const _clampUnit = (value: number): number => Math.min(1, Math.max(0, value))

// Base fill of a quota bar: calm green, a level alarm only near the end
const _levelColor = (usedPercent: number): string =>
  usedPercent >= LEVEL_ALARM_PERCENT ? QUOTA_ALARM_COLOR : usedPercent >= LEVEL_WARN_PERCENT ? QUOTA_WARN_COLOR : QUOTA_OK_COLOR

// Quota icon accent from the risk state: how far use runs ahead of the clock, or how close it is to the limit
const _riskColor = (usedPercent: number, elapsedPercent: number | undefined): string => {
  const overshoot = elapsedPercent === undefined ? 0 : usedPercent - elapsedPercent
  if (overshoot >= OVERSHOOT_ALARM_POINTS || usedPercent >= LEVEL_ALARM_PERCENT) return QUOTA_ALARM_COLOR
  if (overshoot >= OVERSHOOT_WARN_POINTS || usedPercent >= LEVEL_WARN_PERCENT) return QUOTA_WARN_COLOR
  return QUOTA_OK_COLOR
}

const _barSvg = (key: TSegmentKey, usedPercent: number, barCells: number, options: IBarOptions = {}): string => {
  const used = _clampPercent(usedPercent) / 100
  const elapsed = key === SegmentKey.CONTEXT || options.elapsedPercent === undefined ? undefined : _clampPercent(options.elapsedPercent) / 100
  const barPx = barCells * CELL_PX_ESTIMATE
  const unitsPerPx = 1000 / barPx
  const cap = (BAR_HEIGHT / 2) * unitsPerPx // half the bar height, in x units
  const f = (value: number) => value.toFixed(2)

  // Pills: each owns an equal share of the width, minus half a gap on each inner side.
  // Too narrow for readable pills → one plain bar. (px per pill is computed directly so 84px / 7 is exactly 12.)
  let count = Math.max(1, Math.floor(options.segments ?? 1))
  if (count > 1 && barPx / count < MIN_PILL_PX) count = 1
  const gap = count > 1 ? PILL_GAP_PX * unitsPerPx : 0
  const share = 1000 / count
  const pills = Array.from({ length: count }, (_, i) => ({
    start: i * share + (i === 0 ? 0 : gap / 2),
    end: (i + 1) * share - (i === count - 1 ? 0 : gap / 2)
  }))

  // Maps a 0–1 fraction of the whole bar to an x inside the pills (fills skip the gaps)
  const xAt = (fraction: number): number => {
    const scaled = _clampUnit(fraction) * count
    const index = Math.min(count - 1, Math.floor(scaled))
    const pill = pills[index]!
    return pill.start + (pill.end - pill.start) * (scaled - index)
  }

  const tipX = xAt(used)
  const nowX = elapsed === undefined ? undefined : xAt(elapsed)
  const hasBand = elapsed !== undefined && nowX !== undefined && used > elapsed

  // Pill shape mask. Inner pill ends are rounded rectangles; the bar's outer ends are inset by `cap` and finished by a
  // round-capped stroke, so the whole bar keeps its stadium silhouette
  const radiusX = f(PILL_RADIUS_PX * unitsPerPx)
  const mask = pills.map(({ start, end }, i) => {
    const left = i === 0 ? start + cap : start
    const right = i === count - 1 ? end - cap : end
    return `<rect class="pill" x="${f(left)}" y="0" width="${f(Math.max(0, right - left))}" height="${BAR_HEIGHT}" rx="${radiusX}" ry="${PILL_RADIUS_PX}" fill="#fff"/>`
  })
  const outerCap = (x: number) =>
    `<line x1="${f(x)}" y1="${BAR_HEIGHT / 2}" x2="${f(x + 0.01)}" y2="${BAR_HEIGHT / 2}" stroke="#fff" stroke-width="${BAR_HEIGHT}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
  mask.push(outerCap(cap), outerCap(1000 - cap - 0.01))

  const defs: string[] = [`<mask id="pills-${key}" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="${BAR_HEIGHT}">`, ...mask, '</mask>']
  if (key === SegmentKey.CONTEXT) {
    defs.push(
      `<linearGradient id="grad-context" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1000" y2="0">`,
      '<stop offset="0" stop-color="#00c800"/><stop offset="0.5" stop-color="#ffc800"/><stop offset="1" stop-color="#ff0000"/>',
      '</linearGradient>'
    )
  }
  if (hasBand) {
    // Anchored from the global `now` to the global fill tip, so the band reddens with how far ahead use runs
    defs.push(
      `<linearGradient id="band-${key}" gradientUnits="userSpaceOnUse" x1="${f(nowX)}" y1="0" x2="${f(tipX)}" y2="0">`,
      `<stop offset="0" stop-color="${QUOTA_WARN_COLOR}"/><stop offset="1" stop-color="${QUOTA_ALARM_COLOR}"/>`,
      '</linearGradient>'
    )
  }

  const fillColor = key === SegmentKey.CONTEXT ? 'url(#grad-context)' : _levelColor(used * 100)
  const rect = (cls: string, x1: number, x2: number, fill: string) =>
    `<rect class="${cls}" x="${f(x1)}" y="0" width="${f(Math.max(0, x2 - x1))}" height="${BAR_HEIGHT}" fill="${fill}"/>`
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${BAR_HEIGHT}" preserveAspectRatio="none" width="4000" height="${BAR_HEIGHT}">`,
    '<defs>',
    ...defs,
    '</defs>',
    `<g mask="url(#pills-${key})">`,
    rect('track', 0, 1000, EMPTY_COLOR)
  ]
  if (used > 0) parts.push(rect('fill', 0, tipX, fillColor))
  if (hasBand) parts.push(rect('band', nowX, tipX, `url(#band-${key})`))
  parts.push('</g>')

  // `now` needle: 4px dark halo, then the 2px white core, full height, drawn last (kept clear of the image's edges)
  if (nowX !== undefined) {
    const haloHalf = 2 * unitsPerPx
    const x = f(Math.min(1000 - haloHalf, Math.max(haloHalf, nowX)))
    const needle = (cls: string, stroke: string, strokeWidth: number) =>
      `<line class="${cls}" x1="${x}" y1="0" x2="${x}" y2="${BAR_HEIGHT}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="butt" vector-effect="non-scaling-stroke"/>`
    parts.push(needle('needle-halo', NEEDLE_HALO_COLOR, 4), needle('needle', NEEDLE_COLOR, 2))
  }
  parts.push('</svg>')
  return parts.join('')
}

// Share of the window already gone by (0–100); undefined when the reset time is missing, invalid or past
const _elapsedPercent = (resetsAt: number | undefined, nowMs: number, windowMs: number): number | undefined => {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= nowMs) return undefined
  return _clampPercent(100 - ((resetsAt - nowMs) / windowMs) * 100)
}

// Resolves the display language: user option → Claude Code setting → LC_ALL / LC_MESSAGES / LANG → macOS → English
const _resolveLocale = async ($: EngineInterface, option: string | undefined): Promise<Locale> => {
  // 1. explicit choice in the plugin's config menu
  const chosen = option && option !== 'auto' ? normalizeLocale(option) : null
  if (chosen) return chosen

  // 2. Claude Code's own `language` setting
  const settings = await $.settings.read().catch(() => ({}) as Record<string, unknown>)
  const settingName = typeof settings.language === 'string' ? settings.language : undefined
  const fromSetting = localeFromLanguageName(settingName)
  if (fromSetting) return fromSetting

  // 3. POSIX locale variables, most specific first
  const envCandidates = [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')]
  const fromEnv = envCandidates.map(normalizeLocale).find((locale) => locale !== null)
  if (fromEnv) return fromEnv

  // 4. macOS system language (apps launched from Finder usually have no LANG)
  const appleLanguages = await $.process
    .run(['/usr/bin/defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 5_000 })
    .catch(() => null)
  const firstAppleLanguage = appleLanguages?.exitCode === 0 ? /"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)"?/.exec(appleLanguages.stdout)?.[1] : undefined
  const fromMac = normalizeLocale(firstAppleLanguage)
  if (fromMac) return fromMac

  return DEFAULT_LOCALE
}

export const register: Register = (on, options) => {
  const languageOption = typeof options.language === 'string' ? options.language : 'auto'

  // On start (and every hot reload): resolve the display language, read the current figures,
  // and redraw once a minute so the reset countdown moves
  on('session.start', async ($, e, next) => {
    const resolvedLocale = await _resolveLocale($, languageOption)
    await update($, locale, () => resolvedLocale)

    const initial = await $.session.usage()
    await update($, usage, () => _toQuotaUsage(initial.context, initial.rateLimits))

    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  // The engine pushes new figures after each turn and whenever a limit moves a whole point
  on('session.measure', async ($, e, next) => {
    await update($, usage, () => _toQuotaUsage(e.context, e.rateLimits))
    return next(e)
  })

  // Draws the bars above the prompt. The terminal already has a status line, so it is left to the engine there
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)

    const current = await read($, usage)
    if (!current) return next(e)

    const messages = MESSAGES[await read($, locale)] ?? MESSAGES[DEFAULT_LOCALE]
    const nowMs = await $.clock.now()
    const { Box, Svg } = $.ui.resolve(e)

    // Bars that have data
    const segmentCandidates: (ISegmentInput | null)[] = [
      current.contextPercent === undefined ? null : { key: SegmentKey.CONTEXT, name: messages.context, percent: current.contextPercent },
      current.fiveHour ? { key: SegmentKey.FIVE, name: messages.fiveHour, percent: current.fiveHour.percent, resetsAt: current.fiveHour.resetsAt } : null,
      current.sevenDay ? { key: SegmentKey.WEEK, name: messages.sevenDay, percent: current.sevenDay.percent, resetsAt: current.sevenDay.resetsAt } : null
    ]
    const segmentInputs = segmentCandidates.filter((segment) => segment !== null)
    if (segmentInputs.length === 0) return next(e)

    // Per bar: used (clamped), its bare percent label, elapsed share of the window, and the reset countdown
    const useds = segmentInputs.map((segment) => _clampPercent(segment.percent))
    const percentLabels = useds.map((used) => `${Math.round(used)}%`)
    const elapseds = segmentInputs.map(({ key, resetsAt }) =>
      key === SegmentKey.WEEK ? _elapsedPercent(resetsAt, nowMs, WEEK_MS) : key === SegmentKey.FIVE ? _elapsedPercent(resetsAt, nowMs, FIVE_MS) : undefined
    )
    const remainings = segmentInputs.map((segment) => _formatRemaining(segment.resetsAt, nowMs, messages))
    const timeSvgs = remainings.map((remaining) => (remaining ? _timeSvg(remaining, messages.rtl) : null))

    // Layout in one label style. Each block = icon · label slot · bar · countdown, with a 1-column gap between them;
    // the label slot is the widest of the labels, the same for every block, so the bars stay equal.
    // In a row: equal-length bars fill the row: what is left after block gaps and fixed widths is split evenly between the
    // bars; every block also grows by the same flexGrow, absorbing the remainder and real glyph widths, so bars stay equal.
    // Stacked (one block per row): every bar gets the width left beside the widest fixed part, so the bars line up and
    // the countdowns start in one column. `showBar` / `showTime` drop the bar / countdown for the narrowest widths
    const layoutFor = (style: TLabelStyle, { stacked = false, showBar = true, showTime = true } = {}) => {
      const labelSvgs = percentLabels.map((label) => _labelSvg(label, style))
      const labelCells = Math.max(...labelSvgs.map((svg) => svg.cells))
      const segmentGap = stacked ? 0 : style === 'compact' ? COMPACT_SEGMENT_GAP : SEGMENT_GAP
      const fixedWidths = timeSvgs.map(
        (timeSvg) => ICON_CELLS + 1 + labelCells + (showBar ? 1 : 0) + (showTime && timeSvg ? 1 + timeSvg.cells : 0)
      )
      const totalGap = segmentGap * (segmentInputs.length - 1)
      const totalFixed = fixedWidths.reduce((sum, width) => sum + width, 0)
      const room = stacked
        ? e.props.bodyColumns - Math.max(...fixedWidths)
        : Math.floor((e.props.bodyColumns - totalGap - totalFixed) / segmentInputs.length)
      const barLen = showBar ? Math.max(MIN_BAR_LEN, room) : 0
      const fits = room >= (showBar ? MIN_BAR_LEN : 0)
      return { labelSvgs, labelCells, segmentGap, fixedWidths, barLen, fits, stacked, showBar, showTime }
    }
    // Narrow mode: if the normal row leaves the bars too short for the 7-day pills, use compact labels and a 1-column gap
    // (if that is still too short for pills, the bar's own plain-bar fallback applies). If the compact row cannot give
    // every bar its minimum at all, the blocks are stacked one per row (normal labels when the bars still fit the 7-day
    // pills, compact otherwise) rather than overflowing the row; a band taller than maxRows scrolls.
    // Narrower still, the stacked blocks drop the bar (the icon's risk colour and the percent remain), then the countdown;
    // when not even icon · percent fits, nothing is drawn
    const pickLayout = () => {
      const normal = layoutFor('normal')
      if (normal.barLen >= NARROW_BAR_CELLS) return normal
      const compact = layoutFor('compact')
      if (compact.fits) return compact
      const stackedNormal = layoutFor('normal', { stacked: true })
      if (stackedNormal.barLen >= NARROW_BAR_CELLS) return stackedNormal
      const tighter = [
        layoutFor('compact', { stacked: true }),
        layoutFor('compact', { stacked: true, showBar: false }),
        layoutFor('compact', { stacked: true, showBar: false, showTime: false })
      ]
      return tighter.find((layout) => layout.fits) ?? null
    }
    const layout = pickLayout()
    if (!layout) return next(e)
    const { labelSvgs, labelCells, segmentGap, fixedWidths, barLen, stacked, showBar, showTime } = layout

    // One block: icon (context: accent follows usage; quotas: risk state) · used percent · bar · time left until reset
    const renderSegment = ({ key, name }: ISegmentInput, index: number) => {
      const used = useds[index] ?? 0
      const elapsedPercent = elapseds[index]
      // 5-hour and 7-day bars: one pill per hour / day plus the `now` needle; context stays a plain bar
      const barOptions: IBarOptions =
        key === SegmentKey.WEEK ? { segments: WEEK_DAYS, elapsedPercent } : key === SegmentKey.FIVE ? { segments: FIVE_HOURS, elapsedPercent } : {}
      const accent = key === SegmentKey.CONTEXT ? _accentColor(used) : _riskColor(used, elapsedPercent)
      const percentLabel = percentLabels[index] ?? ''
      const percentSvg = labelSvgs[index]!
      const remaining = remainings[index] ?? ''
      const timeSvg = showTime ? (timeSvgs[index] ?? null) : null
      const segmentWidth = (fixedWidths[index] ?? 0) + barLen
      const alt = remaining ? `${name} ${percentLabel} (${remaining})` : `${name} ${percentLabel}`

      return (
        <Box key={key} flexDirection="row" alignItems="center" gap={1} width={segmentWidth} flexGrow={stacked ? 0 : 1} flexShrink={stacked ? 0 : 1}>
          <Box width={ICON_CELLS} flexShrink={0} justifyContent="center">
            <Svg source={_iconSources[key](accent)} alt={showBar ? name : alt} width={ICON_SIZE} height={ICON_SIZE} />
          </Box>
          <Box width={labelCells} flexShrink={0} justifyContent="flex-end">
            <Svg source={percentSvg.source} alt={percentLabel} width={percentSvg.width} height={LABEL_HEIGHT} />
          </Box>
          {showBar ? (
            <Box flexDirection="column" justifyContent="center" width={barLen} flexGrow={1} flexShrink={1}>
              <Svg source={_barSvg(key, used, barLen, barOptions)} alt={alt} height={BAR_HEIGHT} />
            </Box>
          ) : null}
          {timeSvg ? (
            <Box width={timeSvg.cells} flexShrink={0} justifyContent="center">
              <Svg source={timeSvg.source} alt={remaining} width={timeSvg.width} height={TIME_HEIGHT} />
            </Box>
          ) : null}
        </Box>
      )
    }

    // One row, no wrapping; or, when the row cannot fit, one block per row
    const segments = segmentInputs.map(renderSegment)
    const barsRow = stacked ? (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {segments}
      </Box>
    ) : (
      <Box flexDirection="row" flexWrap="nowrap" columnGap={segmentGap} width={e.props.bodyColumns}>
        {segments}
      </Box>
    )

    // Play well with other band mods: whatever the mods beneath draw is stacked under the bars instead of replaced
    const below = await next(e)
    if (below.type === 'engine') return barsRow
    return (
      <Box flexDirection="column">
        {barsRow}
        {below}
      </Box>
    )
  })
}
