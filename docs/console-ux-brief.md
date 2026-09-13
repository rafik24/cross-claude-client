# Console UX redesign brief

> Hand this to a fresh FE/UX session (paste it, or point the session at this file). It is self-contained —
> the session needs no prior context. Goal: make the Crosstalk operator console a genuinely good dashboard
> that lets the operator **see what needs attention in under two seconds and act on it without leaving the
> page**, while preserving 100% of its existing behaviour.

## What this is
The Crosstalk operator console — a real-time dashboard for coordinating many Claude Code sessions across a
fleet of machines over a self-hosting message bus. The current UI works but looks and feels bad, and it is
read-only everywhere except the composer. Redesign it, then give the operator control.

## The file (the primary deliverable)
- Repo: `D:\projects\cross-claude-client` (local clone dir; git remote is `github.com/rafik24/crosstalk`,
  **default branch `main`**). Edit **`cc-console.html`** at the repo root.
- It is a **single self-contained HTML file**: inline `<style>` + inline vanilla-JS `<script>`, **zero external
  dependencies, no build step, no framework, no CDN, no web fonts**. It must keep working fully **offline**
  (the fleet has no guaranteed internet) and be served as-is. Do **not** add npm/bundlers/React/Tailwind-CDN.
- It is served two ways that must both keep working: opened directly as a `file://`, and served by the bus
  leader at `http://<leader>:8787/console`.
- Small **server changes are allowed** when a console feature needs them (e.g. the WS hub's origin allowlist
  for `file://` origins), provided they are covered by tests in `test/` and reviewed by the
  `crosstalk-reviewer` agent before merge.

## Design references (read these first)
- `design-system/crosstalk-console/MASTER.md` — the persisted design tokens (palette, type, spacing, rules).
  Generated with the `ui-ux-pro-max` skill. **Use these tokens; do not invent a new palette.**
- `docs/console-proto.html` — a static, fake-data prototype of the target layout under those tokens. It is
  the visual target: match its hierarchy and density, then wire it to the live bus.
- Skills: load `ui-ux-pro-max:ui-ux-pro-max` for UX rules and `frontend-design:frontend-design` for taste.
  (There is no `super-ui-ux-design` skill — an earlier draft of this brief named one by mistake.)

## Hard constraint — preserve every existing feature
Rewrite the CSS freely; refactor the JS only if you keep behaviour. Keep element IDs consistent with the JS,
or update both together — nothing may silently break.
1. **Header connect controls:** bus/base URL, token (`CC_TOKEN`, password field), "as" identity, Connect
   button, live connection dot + status text.
2. **Leader discovery + auto-connect + leader-follow on failover** — the JS `discoverLeader()` probes roster
   hosts + a cached leader via `/cc/whoami` and picks the highest-epoch leader; on disconnect it re-discovers
   and resumes; it auto-connects when a token is already stored. Load-bearing — keep intact and working.
3. **Message stream with exactly-once delivery.** Today this is a **1.5 s REST poll** per channel with
   per-channel `after_id` cursors and a `seenIds` dedupe set. (An earlier draft of this brief claimed the
   console already used WebSocket push — it does not. Adding push is Phase 2 below.) Base+token persist in
   `localStorage`. REST uses a Bearer header.
4. **Participants roster + Channels list**, each filtered by an "active within N minutes" window (default 15),
   with "show all" overrides; channels show an amber "new content since you last looked" indicator; a
   participant carries a "stale rev" badge when its code rev differs from the leader's.
5. **Unacked-handoff banner** — surfaces handoffs needing acknowledgement (high-priority operator signal).
6. **Toggleable read-only work-board panel** (right column) grouped by epic, with a summary and per-item
   state styling: queued / claimed / implementing / in-review / merged / deployed / blocked / abandoned, plus
   a "stale" chip on claimed/implementing items untouched for 15 min.
7. **Composer footer:** channel input (+datalist of channels), message-type select
   (message/status/request/response/handoff/done), body input with **@mention autocomplete**, Enter-to-send,
   Send button. Messages are colour/tagged by type.
8. **Settings bar:** the two active-window numbers, the show-all toggles, the work-board toggle, a "peers"
   discovery-seed field. Responsive (already collapses the board panel < 900px).

## Copy fixes (do these while you are in the file)
The config file is `~/.claude/.crosstalk`; the console's placeholder text and tooltips still say the legacy
`~/.claude/.cross-claude-bus`. Update them (the legacy name is still read for back-compat, so mention it only
in a tooltip). Title the page "Crosstalk console".

## Design intent (what "good" means here)
An **ops console**, not a marketing page. Optimise for at-a-glance situational awareness for a single operator
watching a live fleet: who is online now, which channels are hot, what needs attention (unacked handoffs =
urgent), the work-board state, and a scannable, dense-but-legible message stream. Prioritise information
hierarchy, scannability, status-colour semantics, and calm density over decoration. Dark theme by default;
a light option is a bonus, not required.

Rules from the design skill that the current file breaks and the rewrite must fix:
- No emoji or Unicode glyphs as icons (⚠ ⛔ ⚙ ◑ ✓) — use inline SVG (Lucide-style, 16px, `currentColor`).
- No text below 12 px. Fixed type sizes: 12 / 13 / 14 px. Mono for data (ids, times, channels, states),
  sans for labels and message bodies. No bold on mono.
- Status colour is never the only signal: pair every colour with a glyph and/or label.
- Visible focus rings (2 px, 3:1 contrast) on every interactive element; `cursor:pointer` on clickables.
- `prefers-reduced-motion` respected; transitions 150–250 ms; nothing animates width/height.
- Live counts (unacked handoffs, new messages) are announced via one `role="status"` element with atomic
  text ("3 unacked handoffs"), not bare numbers in competing live regions.
- Contrast ≥ 4.5:1 for all text on its actual background.

## The work, in three PRs (each dogfooded and merged before the next)

### PR 1 — look and feel (no behaviour change)
Tokens, layout, typography, SVG icons, focus + reduced-motion, the copy fixes above. Collapse the connect
controls into a **status chip** once connected (dot · leader host · epoch · rev; click to expand). Failover
shows a small toast ("leader moved to <host>, resumed") instead of a status string that flashes past.

### PR 2 — real-time
- Move the stream to **WebSocket push** via `GET /cc/ws?identity=<me>&token=<tok>` (the hub already accepts
  `?token=` because browsers cannot set handshake headers). Keep the REST poll as the automatic fallback and
  keep the cursor + `seenIds` logic so delivery stays exactly-once across reconnects and leader migration.
- Pause-on-scroll with a "N new · jump to latest" pill; type filter (hide `status` chatter, show only
  handoff/request/done); click a sender to filter by them; a "mentions me" toggle.
- Group consecutive messages from the same sender in the same channel. Render `@mentions` as chips.
- Browser Notification API (opt-in toggle in settings) for handoffs and `@<me>` mentions.

### PR 3 — control
- **Handoff attention queue** replaces the banner: one row per unacked handoff with age, target, channel, and
  actions: *nudge* (posts `@<target>` reminder to the same channel), *ack for me* (when the operator is the
  target), *jump* (scrolls to and highlights the message).
- **Work board actions** via the existing endpoints (`/api/work/:id/state`, `/claim`, `/handoff`): change
  state from a small menu, reassign owner, "who is on this?" opens the owner's DM. Filter chips at the top of
  the board: blocked · stale · unowned · mine.
- **Threads:** the schema has `in_reply_to` and `/messages/:channel/:id/replies`. Add a reply affordance on
  hover and a reply count on the parent.
- **"While you were away" strip** on tab refocus after > 5 min: new handoffs, items that went blocked,
  participants that dropped.
- **Keyboard:** `/` focuses the composer, `Ctrl+K` channel switcher, `Esc` clears filters, `Ctrl+Enter` sends.

## Verify against the live bus — don't ship on looks alone
A live bus is running with real data. Dogfood before claiming it works:
- Leader is on this desktop at `http://localhost:8787` (role=leader). Token (`CC_TOKEN`) is in
  `~/.claude/.crosstalk` (line `CC_TOKEN=…`), also in `D:\projects\mailroom-stuff\cross-claude-bus.txt`.
- Real data to render: channels `general` (fleet coordination) and `demo-sprint` (a completed multi-agent
  "kata sprint"), work-board projects `kata-sprint` + `kata-sprint-2` (items #1–#24 in various states),
  ~10 participants (desktop + Linux VM sessions).
- Open the file in a browser (use the `claude-in-chrome` / `agent-browser` tools), set
  `base=http://localhost:8787`, paste the token, Connect, and confirm every item in the acceptance list.

## Acceptance checklist (the PR description must tick each)
- [ ] Discovery + auto-connect works from `file://` and from `/console`.
- [ ] Failover: run `POST /cc/stepdown` (admin key) on the leader; the console follows the new leader and
      resumes with no duplicate or missing messages.
- [ ] Stream renders both channels; channel filter, active-window filters and show-all toggles behave.
- [ ] Roster shows the stale-rev badge for a node on a different rev.
- [ ] Work board renders all 24 items with correct state colours + glyphs; stale chip appears.
- [ ] Composer sends a test message; @mention autocomplete (type `@`, arrows, Enter) works.
- [ ] Unacked handoff appears within one poll of being sent, and clears on ack.
- [ ] Keyboard-only pass: every control reachable, focus visible.
- [ ] `npm test` green.
- [ ] Before/after screenshots at 1440 px and 1024 px, plus the board-collapsed < 900 px view.

## Workflow
- `git fetch`, branch from `origin/main` (e.g. `feat/console-ux-pr1`). Ignore other in-flight branches.
- Keep the change to `cc-console.html` + `docs/` + (if needed) a small, tested server change.
- Run `npm test`, commit, open a PR on `rafik24/crosstalk` **targeting `main`** with the acceptance checklist and
  screenshots. After merge, fast-forward the `crosstalk` branch to `main` (invariant: `main == crosstalk`; the
  plugin marketplace installs from the default branch, so a PR that lands anywhere else never reaches clients).

Ask for the token if the config file isn't readable. Start by reading `MASTER.md` and the prototype, then
`cc-console.html` end-to-end to inventory the feature surface, then propose a direction before rewriting.
