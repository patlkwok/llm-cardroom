/**
 * Drives the built app and captures screenshots of the three main views.
 *
 *   npm run build && npm run screenshot     # -> screenshots/*.png
 *
 * The point is layout verification on platforms the author cannot run: several
 * layout bugs in this project (clipped seats, an overlapping stats bar) were
 * visible only in a rendered frame, never in the DOM. CI runs this on Windows,
 * macOS and Linux and uploads the results as artifacts.
 *
 * Two rules, both learned the hard way:
 *
 *  1. Always launch with an isolated --user-data-dir. Without it the driver
 *     writes to the real per-user config directory and leaves junk behind.
 *  2. Mock OpenRouter in the MAIN process. Every API call originates there, so
 *     a renderer-side mock intercepts nothing.
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(APP_DIR, 'screenshots')

/** Installed in the main process; see rule 2 above. */
function installOpenRouterMock() {
  // Flipped between games so the canned reply is always a legal action.
  globalThis.__mockAction = 'stand'

  const MODELS = [
    // The first entry is deliberately long. Seat names are capped at 22
    // characters, and the catalogue is sorted by name, so this one gets seated
    // first and every run photographs the worst case for name overflow.
    'anthropic/claude-opus-4-5-long-context',
    'anthropic/claude-sonnet-4.5',
    'openai/gpt-5',
    'google/gemini-3-pro',
    'meta-llama/llama-4-70b-instruct',
    'mistralai/mistral-large',
    'deepseek/deepseek-v3'
  ].map((id) => ({
    id,
    name: id
      .split('/')[1]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    context_length: 200000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    architecture: { input_modalities: ['text'] },
    description: 'Mocked catalogue entry for screenshots.'
  }))

  const json = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })

  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input)

    if (url.endsWith('/key')) {
      return json({ data: { label: 'screenshot key', usage: 0, limit: null } })
    }
    if (url.endsWith('/models')) {
      return json({ data: MODELS })
    }
    if (url.endsWith('/chat/completions')) {
      const body = String((init && init.body) || '')
      // Insurance is a separate decision with its own reply shape. Answering it
      // with an `action` fails parsing three times and lands on a fallback,
      // which then shows up in the screenshots as if the app had misbehaved.
      let answer = { action: globalThis.__mockAction }
      if (body.includes('Do you take insurance?')) {
        answer = { insurance: false }
      } else if (globalThis.__mockPrefer) {
        // Take the first preferred action the prompt actually offers, so a
        // capture can steer the table towards a state — a split, say — without
        // ever answering illegally and landing on a fallback.
        const legal = (body.match(/Legal actions: ([^"\\]*)/) || ['', ''])[1]
        const choice = globalThis.__mockPrefer.find((a) => legal.includes(a))
        if (choice) answer = { action: choice }
      }

      const reply = JSON.stringify({
        reasoning:
          'Canned reply from the screenshot harness — enough to keep the table ' +
          'moving so the layout can be photographed.',
        ...answer
      })
      return json({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 640, completion_tokens: 48, cost: 0.0021 }
      })
    }
    throw new Error(`screenshot mock got an unexpected request: ${url}`)
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'cardroom-shot-'))

  // ELECTRON_RUN_AS_NODE makes Electron behave as plain Node, so no window
  // ever appears. Strip it rather than trusting the ambient environment.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const args = [APP_DIR, `--user-data-dir=${profile}`]
  // CI runners have no GPU, and Linux containers reject the sandbox.
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')

  const app = await electron.launch({ args, env })
  try {
    await app.evaluate(installOpenRouterMock)

    const win = await app.firstWindow()
    await win.waitForSelector('.sidebar', { timeout: 30000 })
    await win.setViewportSize({ width: 1440, height: 940 })

    // --- key + first model ------------------------------------------------
    await win.fill('.key-input', 'sk-or-v1-screenshot')
    await win.click('button:has-text("Save key")')
    await win.waitForSelector('.badge-ok', { timeout: 15000 })

    // A full table of six on one shoe. The crowded case is the one worth
    // photographing every run: it is where seat plates, names and card rows all
    // have to shrink to fit, and a four-seat frame would never show that.
    for (let i = 0; i < 6; i++) await seatModel(win, i)
    await win.waitForTimeout(400)
    await shoot(win, '01-setup-blackjack.png')

    // --- a blackjack round ------------------------------------------------
    // Slow enough that the settled felt lingers long enough to catch. Waiting
    // for the state rather than sleeping is what makes this reliable: a fixed
    // delay used to land mid-deal and never photograph an outcome.
    await win.fill('input[type="range"]', '700')
    await win.click('.start-button')
    await waitForCounter(win, /Round [1-9]/)
    await win.waitForSelector('.hand-outcome', { timeout: 120000 })
    await shoot(win, '02-blackjack-round.png')

    // A split at a full table is the worst case for the felt: it puts an extra
    // hand on a row that already holds six, and the hands stack because there
    // is no width for them side by side. That used to grow the column past the
    // bottom of the window and take the stats bar with it.
    //
    // Captured at a deliberately SHORT viewport, because height is what breaks:
    // at 940px the overflow simply does not happen and the frame proves
    // nothing. 700px is roughly the smallest window worth supporting.
    await win.setViewportSize({ width: 1360, height: 700 })
    await app.evaluate(() => {
      globalThis.__mockPrefer = ['split', 'stand']
    })
    await win.waitForSelector('.hand-index', { timeout: 180000 })
    await shoot(win, '03-blackjack-split.png')
    await stopMatch(win)
    await app.evaluate(() => {
      globalThis.__mockPrefer = undefined
    })
    await win.setViewportSize({ width: 1440, height: 940 })

    // --- a poker table ----------------------------------------------------
    await app.evaluate(() => {
      // 'call' is legal at every poker decision: the engine treats a call with
      // nothing to call as a check.
      globalThis.__mockAction = 'call'
    })

    await win.click('.segmented button:has-text("Hold\'em")')
    for (let i = 0; i < 4; i++) await seatModel(win, i)

    // Slow the table so the showdown frame lingers long enough to catch. It is
    // the most informative state — the only one showing hand labels and the
    // pot award — so the capture waits for it rather than for a fixed delay.
    await win.fill('input[type="range"]', '900')

    await win.click('.start-button')
    await waitForCounter(win, /Hand [1-9]/)

    // Two frames, because the seat plates show different things: win
    // probability while the hand is live, stack depth at showdown.
    await win.waitForSelector('.seat-equity', { timeout: 90000 })
    await shoot(win, '04-poker-hand.png')

    await win.waitForSelector('.seat-showdown', { timeout: 120000 })
    await shoot(win, '05-poker-showdown.png')
    await stopMatch(win)

    console.log(`\nScreenshots written to ${OUT_DIR}`)
  } finally {
    await app.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }
}

/** Opens the catalogue and picks the nth model. */
async function seatModel(win, index) {
  await win.click('button:has-text("+ Add model")')
  await win.waitForSelector('.model-row', { timeout: 15000 })
  await win.locator('.model-row').nth(index).click()
  await win.waitForSelector('.modal', { state: 'detached', timeout: 10000 })
}

async function waitForCounter(win, pattern) {
  await win.waitForFunction(
    (source) => {
      const node = document.querySelector('.status-counter')
      return node ? new RegExp(source).test(node.textContent || '') : false
    },
    pattern.source,
    { timeout: 60000 }
  )
}

async function stopMatch(win) {
  const stop = win.locator('button:has-text("Stop")')
  if (await stop.count()) await stop.first().click()
  await win.waitForTimeout(800)
}

async function shoot(win, name) {
  // Setting the pace slider focuses a control near the bottom of the sidebar,
  // which scrolls the panel and leaves its heading out of frame — worse on
  // Linux, where wider font metrics make the sidebar taller.
  await win.evaluate(() => {
    document.querySelector('.sidebar')?.scrollTo(0, 0)
  })
  const path = join(OUT_DIR, name)
  await win.screenshot({ path })
  console.log(`  captured ${name}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
