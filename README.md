# LLM Cardroom

A desktop app for watching language models play cards. Seat models from the
OpenRouter catalogue at a table, press deal, and watch them play — every move
annotated with the model's own reasoning.

Two games:

- **Blackjack** — one model plays against the house dealer.
- **No-Limit Texas Hold'em** — two to eight models play against each other.

## Running it

```bash
npm install
npm run dev      # development, with hot reload
```

Windows, macOS and Linux are all supported. `npm run dist` packages for
whichever platform you are on:

| Platform | Artifacts |
| --- | --- |
| Windows | `LLM-Cardroom-<version>-x64.exe` (NSIS installer), `-portable.exe` |
| macOS | `LLM-Cardroom-<version>-mac-<arm64\|x64>.dmg` and `.zip` |
| Linux | `LLM-Cardroom-<version>-linux-x64.AppImage` and `.deb` |

`npm run dist:dir` builds an unpacked folder instead, which is quicker when you
only want to smoke-test the packaged app.

**Each platform must be packaged on itself.** A macOS `.dmg` needs macOS to
build and sign, and Linux packaging needs Linux tooling, so there is no
cross-compiling to be had. The GitHub Actions workflow in
[`.github/workflows/build.yml`](.github/workflows/build.yml) builds all three on
a push, and attaches them to the release when a `v*` tag is pushed.

### Platform notes

**macOS builds are ad-hoc signed, not notarised**, because this project has no
paid Apple Developer ID. The app runs, but Gatekeeper will not vouch for it, so
the first launch needs right-click → **Open**, or:

```bash
xattr -dr com.apple.quarantine "/Applications/LLM Cardroom.app"
```

(An entirely unsigned build would not launch on Apple Silicon at all, which is
why `scripts/afterpack-adhoc-sign.cjs` exists.)

**Windows builds are unsigned**, so SmartScreen shows a warning on first run.

**On Linux, install a desktop keyring** — `gnome-keyring` or KWallet — before
saving an API key. Without one, Electron's `safeStorage` silently falls back to
a backend that "encrypts" with a hardcoded key, which is obfuscation rather than
protection. The app detects this and says so next to the key field instead of
claiming the key is encrypted.

## Setup inside the app

1. Paste an [OpenRouter API key](https://openrouter.ai/keys). It is verified
   against the account endpoint and then stored in the operating system's
   credential store via Electron's `safeStorage` — DPAPI on Windows, the
   Keychain on macOS, a keyring on Linux. On every later launch
   the stored key is re-checked in the background, so the badge reads **key
   works** or **key rejected** rather than merely "saved" — a revoked key is
   caught before you deal in, not after a table full of failed calls.
2. Pick a game.
3. **Add model** opens the OpenRouter catalogue — search by name or id, and the
   list shows the context window and the price per million tokens. Blackjack
   seats one model; Hold'em seats two to eight.
4. Adjust the table rules and the pace, then **Deal me in**.

Expanding a seated player exposes its **reasoning effort**: `Model's default`
(no reasoning parameter is sent, so the model behaves as it normally would),
`No reasoning`, `Low`, `Medium` or `High`. Models without reasoning support
ignore it. Sampling temperature is deliberately never sent — each model plays
at its own default.

Higher effort costs more and takes longer per decision. Because reasoning
tokens count against the response budget, the app raises `max_tokens` with the
effort level (900 → 12,000) so a thinking model cannot exhaust its budget
before it answers.

Each game keeps its own roster, so switching between Blackjack and Hold'em does
not lose the other table's line-up within a session.

**Every launch starts from a clean table.** The API key is the only thing kept
between runs — models, rules and pace all return to their defaults, so a
session never silently inherits whatever was being tried last time. The config
file on disk holds nothing but the encrypted key.

## Watching

- **The table** shows cards, chips, the button, blinds, side pots and showdowns.
  Every hole card is face up to you, the way a televised table is shown. The
  models never get that view: each prompt contains only that model's own two
  cards, and there is a test asserting no opponent's cards leak into it.
- **Reasoning** is the interesting panel: each decision with the model's stated
  justification, latency, token counts and cost.
- **Table log** is the dealer's-eye narration of every card and action.
- **Usage** totals tokens and spend per model.

Pause, resume and stop take effect between decisions. The pace slider controls
how long the table lingers on each step so a human can follow along.

### Changing things mid-match

The pace, the round limit and the blackjack stake can all be changed while a
match is running. A new stake applies from the **next** round — a hand already
dealt always settles for the amount it was wagered for — and the change is
noted in the table log.

At a poker table you can also **add or remove models mid-match**. Both take
effect at the next hand boundary, never mid-hand: a player who joins buys in
for the starting stack, and a player who leaves takes their chips with them.
Drop below two players and the table closes. The table log records each
arrival and departure.

Adding a model **pauses the table** so you can set it up before it is dealt in.
A model waiting to join is marked *joins next hand* and its reasoning effort
and model choice stay editable; press Resume when you are happy. A model that
has already been dealt in is frozen for the rest of the match — the same model
at a different reasoning effort is, for comparison purposes, a different
player, so it cannot be changed mid-game. The runner enforces this even if the
UI is bypassed.

Everything else (the game itself, deck count, blinds) is fixed once a match
starts, because changing it mid-game would invalidate the table state.

### Shuffling

**Blackjack** deals from a multi-deck shoe. Once roughly three quarters of the
shoe has been dealt, it is rebuilt and reshuffled — checked *between rounds*, so
a shuffle never happens partway through a hand. The felt shows how many cards
remain, the log says *"The shoe is reshuffled"*, and the model is told the count
so card counting is at least possible in principle.

**Poker** shuffles a fresh 52-card deck for every hand, which is what a real
card room does. There is no shoe and nothing to count across hands: within a
hand cards are drawn without replacement (including a burn card before the
flop, turn and river), but the previous hand tells you nothing about this one.
The system prompt states this so models do not reason as if cards were being
tracked.

### Who decides the bet

By default blackjack uses a flat stake. Turn on **Model chooses its own bet**
and the model is asked before each deal how much to wager: it is shown its
bankroll, its win/loss record, the session's running total and how deep the
shoe is, and picks any amount from the table minimum up to its entire
bankroll. The wager appears in the Reasoning feed alongside the play decisions,
with the model's justification. An unparseable answer falls back to the table
minimum so the session survives.

## How models are asked to play

Each decision is a single chat completion. The model gets a system prompt with
the rules in force and a user prompt with the exact game state — its cards, the
board, stacks, pot, betting history this hand and the legal actions with their
amounts. It must answer with one JSON object:

```json
{ "reasoning": "Pot odds justify a call here.", "action": "call" }
```

Raises carry an `amount`, which is the total the bet is raised *to*.

Replies are parsed leniently: fenced code blocks, surrounding prose and common
synonyms (`hit me`, `shove`, `all-in`, `raise_to`) are all accepted. If a reply
is unusable or illegal, the model is told exactly what was wrong and asked
again, up to three attempts. If it still fails, the table falls back to a safe
action — stand at blackjack, check-or-fold at poker — records the reason on the
decision card, and play continues. **A badly behaved model never stalls the
table.**

Account-level failures are treated differently. A rejected key (401), exhausted
credits (402) or a forbidden model (403) will fail identically on every
subsequent call, so they are **not** retried and **not** absorbed as fallbacks:
the match stops immediately with the reason in the status bar. Transient
trouble (429, 5xx, timeouts) is still retried with backoff.

## Rules implemented

**Blackjack** — configurable shoe (1–8 decks) reshuffled at 75% penetration,
dealer stands on all 17s or hits soft 17, blackjack pays 3:2, double on any
first two cards, double-after-split optional, splitting up to three times with
split aces receiving exactly one card each. The stake is either flat or chosen
by the model each hand.

**Insurance** is offered (and can be switched off) when the dealer's upcard is
an ace: a side bet of half the stake, paying 2:1 if the dealer has blackjack.
It is asked before the dealer peeks, as a separate decision, so taking it never
costs the model its turn. Insurance settles independently of the hand — take it
against a dealer blackjack and the 2:1 payout exactly cancels the lost stake.
**Surrender is not offered**, and the system prompt says so explicitly.

**Hold'em** — blinds with optional escalation, correct heads-up blind posting
(button posts the small blind and acts first pre-flop, last post-flop), full
side-pot construction for all-in players, undersized all-in raises that do not
reopen the betting, odd chips awarded to the first seat left of the button, and
seven-card hand evaluation with proper kicker comparison.

## Tests

```bash
npm test
```

98 tests covering hand evaluation, betting order, side pots, chip conservation
across randomised hands (including players who fold when checking was free) and
repeated roster churn, undersized all-in raises, short blinds, blackjack settlement,
insurance payouts, bankroll accounting, stake changes landing on the right
round, plus end-to-end runs of both games against a mocked OpenRouter —
including a model that only ever returns garbage, to prove the fallback path
keeps play moving.

## Layout

```
src/
  main/               Electron main process
    openrouter.ts     model catalogue + chat completions
    config.ts         encrypted key storage, persisted settings
    games/
      blackjack.ts    blackjack engine
      poker/          hold'em engine + 7-card hand evaluator
      prompts.ts      prompt construction and reply parsing
      agent.ts        one decision, with retries and a fallback
      runner.ts       drives a match, emits events to the UI
  preload/            context-isolated IPC bridge
  renderer/           React UI
  shared/             types and card primitives used by both sides
scripts/
  make-icon.cjs       renders resources/icon.png, the source of every app icon
  screenshot.mjs      drives the built app and captures the main views
  afterpack-adhoc-sign.cjs   ad-hoc signs the macOS bundle at package time
```

## Screenshots

```bash
npm run build && npm run screenshot   # -> screenshots/*.png
```

Launches the real app with an isolated profile and a mocked OpenRouter, plays a
blackjack round and a few poker hands, and photographs each view. CI runs it on
all three platforms and uploads the results, which is the only practical way to
catch layout breakage on an OS you do not have — font metrics differ per
platform, and several bugs here (clipped seats, an overlapping stats bar) were
only ever visible in a rendered frame.

Costs are real: every decision is a paid API call. Set a spend limit on your
OpenRouter key, watch the Usage tab, and use the "stop after N rounds" setting
when leaving a table unattended.
