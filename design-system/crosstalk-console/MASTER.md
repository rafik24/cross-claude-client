# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Crosstalk Console
**Generated:** 2026-09-13 20:30:04
**Category:** Operations console (real-time fleet coordination)
**Design Dials:** Variance 3/10 (Centered / Minimal) | Motion 2/10 (Subtle) | Density 9/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#1E293B` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#334155` | `--color-secondary` |
| On Secondary | `#FFFFFF` | `--color-on-secondary` |
| Accent/CTA | `#22C55E` | `--color-accent` |
| On Accent/CTA | `#0F172A` | `--color-on-accent` |
| Background | `#0F172A` | `--color-background` |
| Foreground | `#F8FAFC` | `--color-foreground` |
| Card | `#1B2336` | `--color-card` |
| Card Foreground | `#F8FAFC` | `--color-card-foreground` |
| Muted | `#272F42` | `--color-muted` |
| Muted Foreground | `#94A3B8` | `--color-muted-foreground` |
| Border | `#475569` | `--color-border` |
| Destructive | `#EF4444` | `--color-destructive` |
| On Destructive | `#000000` | `--color-on-destructive` |
| Ring | `#FFFFFF` | `--color-ring` |

**Color Notes:** Dark tech + status green

### Typography

*Corrected by hand: the generator mis-paired a luxury serif (Cinzel / Josefin Sans). The console is a dense
ops dashboard that must work offline with no web fonts, so it uses the skill's "Dashboard Data" pairing
(mono for data, sans for labels) mapped onto system font stacks.*

- **Data font (mono):** `ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace` — ids, times,
  channels, states, counts, anything the eye scans as a column. **Never bold.** Line-height 1.3.
- **Label / body font (sans):** `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` — labels,
  message bodies, descriptions. Weights 400 and 600 only. Line-height 1.45.
- **Fixed type scale (no in-betweens):** 12 px (meta, badges), 13 px (data rows, message bodies), 14 px
  (section titles, composer). Nothing below 12 px. Uppercase eyebrow labels get `letter-spacing: .06em`.
- **Numbers:** `font-variant-numeric: tabular-nums` on every column of digits.
- **No web fonts.** The file must be fully offline; do not `@import` Google Fonts.

### Spacing Variables

*Density: 9/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

### Semantic status tokens (console-specific, added by hand)

The accent and the status colours are **separate systems**. The generator's green accent is kept as the
*healthy/online* status colour; interactive elements use a cooler accent so "online" and "clickable" never
read as the same thing.

| Token | Hex | Meaning |
|---|---|---|
| `--accent` | `#60A5FA` | interactive: links, selected channel, primary button, focus ring |
| `--ok` | `#22C55E` | online, merged, acked |
| `--info` | `#38BDF8` | `status` messages, claimed |
| `--warn` | `#F59E0B` | `request` messages, stale, "new since you looked" |
| `--work` | `#FB923C` | implementing |
| `--hand` | `#C084FC` | `handoff` messages, in-review |
| `--deploy` | `#2DD4BF` | deployed |
| `--bad` | `#F87171` | blocked, disconnected, unacked-handoff attention |
| `--quiet` | `#94A3B8` | `done`, queued, abandoned, offline |

Every status colour is paired with a glyph (inline SVG) or a text label — never colour alone.

## Component Specs (console-specific, replaces the generated generic specs)

- **Top bar** 40 px tall, `--color-card` ground, 1 px `--color-border` bottom. Wordmark 14 px sans 600.
  A single **status chip** (dot · leader host · epoch · rev · transport) replaces the raw connect form once
  connected; click expands the form inline. Right side: bell (notifications), settings, identity.
- **Attention strip** (unacked handoffs) sits directly under the top bar, `--bad` left stripe, one row per
  handoff: age (mono, tabular) · from → to · #channel · excerpt · actions. Hidden when empty.
- **Rails** left 260 px (fleet: participants grouped by host, then channels), right 380 px (work board).
  Section headers: 12 px uppercase eyebrow, count on the right, inline window control ("≤ 15 m").
- **Rows** (participant, channel, work item, message): 28–32 px tall, 8 px inner padding, 4 px radius,
  no border; hover `--color-muted`; selected 2 px `--accent` left stripe + `--color-muted` ground.
  No cards inside rails — border/shadow are spent only on the popover and the composer.
- **Message row**: 56 px time gutter (mono 12 px `--quiet`) · sender (sans 600 13 px) · type badge (mono 12 px
  uppercase, tinted ground at 14% alpha, text in the type colour) · body (sans 13 px). Consecutive
  messages from the same sender in the same channel collapse to a body-only row.
- **Badges / chips**: 20 px tall, 0 6 px padding, 4 px radius, `white-space: nowrap`, never wrap.
- **Buttons**: primary `--accent` ground / `#0B1220` text, 28 px tall, 0 12 px padding, 6 px radius, 600.
  Secondary: transparent, 1 px `--color-border`, `--color-foreground` text. Hover: brightness 1.08, no lift.
- **Inputs**: 28 px tall, `--color-muted` ground, 1 px `--color-border`, 6 px radius, 13 px; focus ring
  2 px `--accent` at 2 px offset.
- **Popover / autocomplete**: `--color-card` ground, 1 px `--color-border`, 8 px radius, `--shadow-lg`.
- **Focus**: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` everywhere.

## Style Guidelines

**Style:** Minimalism & Swiss Style

**Keywords:** Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential

**Best For:** Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools

**Key Effects:** Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading

### Page Pattern

*Note: the generator matched a landing-page pattern. Only its telemetry rules apply to the console: label data as live only when backed by a current source, show update time and a stale state, and offer pause controls for the live feed.*

**Pattern Name:** Real-Time / Operations Landing

- **Conversion Strategy:** Offer a demo or sandbox and show trust signals. Label telemetry as live only when backed by a current source, with update time and stale state. Provide pause/hide or update-frequency controls for tickers and previews, stop offscreen/hidden work, support keyboard controls, and render a static final snapshot under reduced motion.
- **CTA Placement:** Primary CTA in nav + After metrics
- **Section Order:** Hero (product + live preview or status) > Key metrics/indicators > How it works > CTA (Start trial / Contact)

---

## Motion

*Corrected by hand: the generated GSAP scroll-reveal preset does not apply — this is an always-on ops
surface with no page scroll and no external libraries.*

- Transitions 150–250 ms, `ease-out`, on `background`, `border-color`, `color`, `opacity`, `transform` only.
- A new message row fades in from `opacity: 0` over 150 ms; nothing slides. Nothing animates width/height.
- Attention pulses (unacked handoff, new-channel dot) are a 2 s `box-shadow` pulse, max 3 cycles, then static.
- `@media (prefers-reduced-motion: reduce)` disables every transition and pulse; state is shown at rest.

---

## Anti-Patterns (Do NOT Use)

- ❌ Slow updates
- ❌ No automation

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
