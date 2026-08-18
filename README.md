# LLM Cardroom

A desktop app for watching language models play cards. Seat models from the
OpenRouter catalogue at a table, press deal, and watch them play — every move
annotated with the model's own reasoning.

Five games:

- **Blackjack** — one to six models play the house dealer, sharing a single
  shoe, so they face the same cards in the same rounds.
- **No-Limit Texas Hold'em** — two to eight models play against each other.
- **Hearts** — exactly four models pass three cards and play thirteen tricks,
  dodging hearts and the queen of spades. Lowest score wins.
- **Spades** — exactly four models in two fixed partnerships, bidding tricks
  and playing them out. Partners sit opposite and **may not talk**, so each has
  to read its partner's hand out of the bidding and the play. It is the only
  game here that is not every seat for itself.
- **The 24 puzzle** — up to six models race the same four cards to 24, all
  answering at once.

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
| Linux | `LLM-Cardroom-<version>-linux-x86_64.AppImage` and `-linux-amd64.deb` |

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
   seats one to six, Hold'em two to eight, the 24 puzzle up to six, and Hearts
   and Spades exactly four each.
4. Adjust the table rules and the pace, then **Deal me in**.

Expanding a seated player exposes its **reasoning effort**: `Model's default`
(no reasoning parameter is sent, so the model behaves as it normally would),
`No reasoning`, `Low`, `Medium` or `High`. Models without reasoning support
ignore it. Sampling temperature is deliberately never sent — each model plays
at its own default.

Higher effort costs more and takes longer per decision. Because reasoning
tokens count against the response budget, the app raises `max_tokens` with the
effort level (4,000 → 24,000) so a thinking model cannot exhaust its budget
before it answers, and the 24 puzzle — an open search rather than a choice
between named actions — starts higher still.

If a model is cut off mid-thought anyway, the app notices (`finish_reason:
"length"`), says so plainly, and **retries with a larger budget** rather than
telling the model to fix its formatting. It had not failed to format an answer;
it never reached one. A generous ceiling costs nothing extra, since billing is
on tokens actually produced — but a truncated reply is billed in full and
returns nothing at all.

Each game keeps its own roster, so switching between games does not lose the
other tables' line-ups within a session.

**Every launch starts from a clean table.** The API key is the only thing kept
between runs — models, rules and pace all return to their defaults, so a
session never silently inherits whatever was being tried last time. The config
file on disk holds nothing but the encrypted key.

## Watching

- **The table** shows cards, chips, the button, blinds, side pots and showdowns.
  Every hole card is face up to you, the way a televised table is shown. The
  models never get that view: each prompt contains only that model's own two
  cards, and there is a test asserting no opponent's cards leak into it.
- **Win probability**, also as on television: each seat's chance of taking the
  hand, in the same slot that otherwise shows stack depth in big blinds. It is
  exact from the flop onwards — at most about 1,100 runouts to enumerate — and
  sampled pre-flop, where enumerating would mean millions. It costs nothing to
  run, being CPU rather than another paid call, but it is a few hundred
  milliseconds per board change, so **Show win probability** in the Pace panel
  turns it off for a table you want running flat out. Like the hole cards, it is
  strictly for you: it is computed from everyone's cards, so a test asserts the
  prompt is byte-identical whether or not it has been calculated.
- **Reasoning** is the interesting panel: each decision with the model's stated
  justification, latency, token counts and cost. Long traces are clamped to a
  few lines with a **Show more** toggle — reasoning models on the 24 puzzle
  routinely write far more than fits.
- **Table log** is the dealer's-eye narration of every card and action.
- **Usage** totals tokens and spend per model.

Pause, resume and stop take effect between decisions. The pace slider controls
how long the table lingers on each step so a human can follow along.

### Changing things mid-match

The pace, the round limit and the blackjack stake can all be changed while a
match is running. A new stake applies from the **next** round — a hand already
dealt always settles for the amount it was wagered for — and the change is
noted in the table log.

At blackjack and poker you can also **add or remove models mid-match**. Both
take effect at the next round boundary, never mid-hand: a player who joins buys
in for the starting stack, and a player who leaves takes their chips with them.
Drop below two players at poker and the table closes. The table log records each
arrival and departure.

**Hearts, Spades and the 24 puzzle lock their tables** at the first deal
instead. Hearts is defined around four hands of thirteen cards; at Spades the
partnerships are *positional* — seats 0 and 2 against 1 and 3 — so a seat
joining or leaving would renumber the table and hand somebody a different
partner mid-match; and the 24 puzzle is scored in rounds won, so a model seated
halfway through has had fewer chances at them than one that answered every
puzzle.

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
amounts. For the games where the answer is a choice between named things, it
replies with one JSON object:

```json
{ "reasoning": "Pot odds justify a call here.", "action": "call" }
```

Raises carry an `amount`, the total the bet is raised *to*. Blackjack uses
`action`, hearts and spades use `card` for a play, hearts uses a three-element
`pass` array for the exchange — the only decision in the app that returns a set
— and spades uses a numeric `bid`, where `0` means nil.

**The 24 puzzle asks for plain text instead**, because its answer is not a
choice from a list:

```
(6 * 4) * (3 - 2)
```

or exactly `no solution`. The JSON envelope bought nothing there — the app
already reads a model's thinking from the reasoning channel — while adding
tokens to emit and syntax to get wrong. JSON is still accepted from a model that
volunteers it.

Replies are parsed leniently: fenced code blocks, surrounding prose, `Answer:`
prefixes, a trailing `= 24`, unicode `×` and `÷`, and common synonyms (`hit me`,
`shove`, `all-in`, `raise_to`) are all accepted. A 24 answer is read from the
*last* line, since models reason first.

If a reply is unusable or illegal, the model is told exactly what was wrong and
asked again, up to three attempts. If it still fails, the table falls back to a
safe action — stand at blackjack, check-or-fold at poker, the first legal card
at hearts and spades — records the reason on the decision card, and play
continues. **A badly behaved model never stalls the table.**

The one fallback chosen against the grain is the spades bid, which is never
nil. Nil is worth ±100 on its own, so defaulting a silent model into one would
charge it the single biggest swing in the game for failing to answer; the
fallback estimates the hand and clamps to at least 1 instead.

One case is deliberately *not* treated as a bad reply: an answer that is
well-formed but wrong. At the 24 puzzle a wrong expression is graded, not
corrected, because retrying it would hand one model three attempts at the puzzle
while another got one.

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

**Hearts** — hearts score 1 each and the queen of spades 13, lowest total wins,
game to 100. Deal thirteen; pass three left, right, across, then hold. The two
of clubs leads, no points may be played on the first trick, and hearts may not
be *led* until one has been played. **The queen of spades does not break
hearts** — only an actual heart does, which is the rule most often disputed, so
it is stated explicitly in the system prompt. Shooting the moon scores 26 to
everybody else rather than −26 to the shooter.

The exchange is shown rather than done instantly: the three cards leaving each
hand lean towards the middle of the table, then the three that arrived are
ringed, each for a beat of its own.

When only one card is legal it is played **without asking a model at all**: it
removes a paid call and, more usefully, a failure surface, since asking a model
to choose from one option can still burn three retries on a move that was never
in doubt. Across a full match about a quarter of plays are forced, and the felt
reports the running count.

**Spades** — spades are always trump, thirteen tricks, game to 500 with a
partnership that falls to −200 out at once. Each seat bids the tricks it expects
to take, in turn to the dealer's left, so a seat bidding late knows what its
partner committed to and one bidding first does not. **The partnership's
contract is both partners' bids added up**: making it scores 10 a trick, missing
it loses 10 a trick, and every trick over the contract is a *bag* worth 1 point
— which sounds good and is not, because **every 10 bags costs 100 points**. Bags
carry from hand to hand, the only score in the app that persists as a penalty
rather than as a total, so sandbagging a hand is paid for several hands later.

A bid of **0 is nil**: a promise to take no tricks, worth ±100 on its own. It
adds nothing to the contract, so the partner's bid has to stand unaided, and a
trick a nil bidder is forced to take both breaks the nil *and* counts towards
the contract — that last part is a **setting**, because tables genuinely play it
both ways, and whichever is in force is stated in the system prompt so no model
has to guess.

**Both partners bidding nil is a double nil, and it is scored as one thing
rather than two.** Bringing it home doubles the pair's nil bonuses, for +400;
if either of them takes a trick there is no nil penalty at all — but the
contract is then 0, so every trick the two of them took is a bag. Scoring it as
two independent nils would give +200 and −200, which is wrong in both
directions.

**Blind nil is an option, off by default.** With it on, a partnership at least
100 points behind is offered a nil declared *before its seats have seen a
card* — worth ±200 rather than ±100, and a **double blind nil** where both
partners take one is +800 if they both bring it home. Nobody qualifies in the
first hand, since the scores start level. The offer is a prompt with no cards in
it at all, which is the whole of what makes it blind, and a model that fails to
answer always declines: committing one to a ±200 swing because it went quiet
would be the worst default in the app.

Spades is genuinely less standardised than Hearts — how a nil bidder's tricks
are counted, whether a set partnership keeps its bags, and what ten bags costs
are all real disagreements between tables — so every one of those lines is
stated in force in the system prompt rather than assumed, and a test asserts
they are present.

The reason to play it is that **it is the only game here that is not a
free-for-all**. Partners may not talk, signal or agree anything, so a model has
to infer its partner's holding from the bidding and the play — and a test
asserts that no other seat's cards ever reach a prompt, because a leak there
would quietly remove the one capability Spades measures that the other four
games do not. As at Hearts, a forced play is made without asking a model at all;
about a quarter of plays come free.

**The 24 puzzle** — four cards combined with `+ − × ÷` and brackets to make 24,
with ace = 1, jack = 11, queen = 12, king = 13. Every card is used exactly once
and division is exact rather than rounded, so `8/(3−8/3) = 24` is a valid answer
— it is evaluated in exact fractions, because in floating point it is not quite
24. Expressions are parsed, never `eval`'d.

Unsolvable deals are dealt **on purpose**, and "no solution" is a legal answer
graded against the app's own solver. That is the whole point: it is the only
version of the game that catches a model inventing an expression that does not
evaluate. About three quarters of four-card deals can be made into 24.

Every seat answers at once, and the round goes to the fastest correct answer —
timed on the model's own answering attempt, so a retry after rate limiting is
not counted against it. Since arrival order otherwise measures throughput rather
than skill, the two numbers actually worth reading are on the felt: **solve
rate** and **median time**, for the table and for each model. Answers appear as
they arrive rather than all at once when the last one lands, and stopping the
match sorts the board into final standings.

## Tests

```bash
npm test
```

267 tests. The load-bearing ones are invariants rather than examples: chip
conservation across randomised poker hands and repeated roster churn, per-seat
bankroll accounting at blackjack, card conservation on the shoe, 52 cards and
exactly 26 points conserved through every hearts hand, all thirteen tricks
accounted for between the two spades partnerships, and exact-rational arithmetic
for the 24 puzzle checked against an independently written solver.

Both scoring systems that are easy to get subtly wrong are checked against
independently written oracles rather than against themselves: the 24 solver
against an enumeration of operator triples, and spades scoring — contracts,
nil, bags and the hundred-point roll — exhaustively over every combination a
hand can produce.

Rule *rejections* are asserted as well as rule successes — the trick engines
must refuse an off-suit card while the led suit is held, and the expression
parser must refuse everything that is not arithmetic. Every game runs end to end
against a mocked OpenRouter, including a model that only ever returns garbage,
to prove the fallback path keeps play moving.

## Layout

```
src/
  main/               Electron main process
    openrouter.ts     model catalogue + chat completions
    config.ts         encrypted key storage, persisted settings
    games/
      blackjack.ts    blackjack engine
      poker/          hold'em engine, 7-card evaluator, win-probability
      tricks/         what both trick-taking games share: follow-suit legality,
                      trick resolution with or without trump, dealing
      hearts/         trick engine: passing, legality, trick and hand scoring
      spades/         partnership engine: bidding, contracts, nil, bags
      twentyfour/     expression parser, exact rationals, brute-force solver
      prompts/        prompt construction and reply parsing, one file per game
      drivers/        one per game: the rules of play, behind a GameDriver
      agent.ts        one decision, with retries and a fallback
      driver.ts       the GameDriver seam and what a driver may reach for
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

Launches the real app with an isolated profile and a mocked OpenRouter, plays
each game and photographs it — deliberately at a full table and a small window,
because those are the arrangements that break layouts. CI runs it on
all three platforms and uploads the results, which is the only practical way to
catch layout breakage on an OS you do not have — font metrics differ per
platform, and several bugs here (clipped seats, an overlapping stats bar) were
only ever visible in a rendered frame.

Costs are real: every decision is a paid API call. Set a spend limit on your
OpenRouter key, watch the Usage tab, and use the "stop after N rounds" setting
when leaving a table unattended.
