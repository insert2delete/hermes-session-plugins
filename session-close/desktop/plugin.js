/**
 * session-close — closing tabs from the chat (agent → app).
 *
 * The counterpart to `session-mint`: there the agent CREATES a chat, here it
 * CLOSES it. The agent has no tool with which it could close a tab in the
 * desktop — the renderer can do that (`closeSessionTile`), but it is not in
 * the SDK. The plugin therefore clicks the ✕ of that panel, which is THE SAME
 * path as closing it by hand (the app itself watches over a running turn with
 * the "Close running tab?" dialog).
 *
 * THE AGENT WRITES (append-only, one JSON per line):
 *
 *   ~/.local/bin/hermes-close-session                 # close once the turn ends
 *   ~/.local/bin/hermes-close-session --now            # close without the 2.5s delay
 *   ~/.local/bin/hermes-close-session --hold "text"    # keep it open + mark with ❗
 *
 * and it writes into ~/.hermes/session-close.jsonl
 *
 *   {"id":"…","close":"local-<hex>","hold":false,"now":false,"why":"…"}
 *
 *   close  the full session id (the script takes it from $HERMES_SESSION_ID)
 *   hold   true / a string = DO NOT CLOSE: the tab stays and carries a red bar
 *          until the user visits it. It is used when the answer has something
 *          to read (a recommendation, a warning) — the answer marks it with ❗.
 *   now    true = close without delay (otherwise 2.5 s for the answer to land)
 *
 * WHEN IT CLOSES: it waits for the running turn to end (so it does not close
 * in the middle of work), then `SETTLE_MS` (2.5 s) for the answer to land and
 * the tab disappears — REGARDLESS of whether the user has it in front of them
 * right now. The aim is to save them the trip back to the tab and the manual
 * closing; whoever wants to read the answer gets `--hold` with ❗.
 *
 * (Focus is deliberately NOT read: this build reports `focusedStoredSessionId`
 * unreliably — measured, it pointed at a different session than the one that
 * had a visible composer, and it jumped around over time.)
 *
 * One more safeguard: if the plugin finds `❗` or `NEZAVÍRAT` in the LAST
 * answer of the given tab, it leaves the tab open and marks it — even if the
 * agent sent `hold:false`.
 */

import { host } from '@hermes/plugin-sdk'

const ID = 'session-close'
const ENABLED = true
// The Desktop read bridge opens a path literally — it does not expand `~` — so the
// queue path has to be absolute. Set HERMES_DIR once after installing the plugin
// (Linux/macOS: /home/<you>/.hermes, Windows: C:\Users\<you>\.hermes). The script
// that WRITES the queue uses $HOME and needs no edit.
const HERMES_DIR = '/home/USER/.hermes'
const QUEUE = `${HERMES_DIR}/session-close.jsonl`
const QUEUE_PATHS = Array.from(new Set([QUEUE, '~/.hermes/session-close.jsonl']))
const POLL_MS = 1000
const SIG_KEY = 'handled.v1'
const MAX_SIGS = 300
/** Delay after the turn ends so the answer has time to land in the DOM. */
const SETTLE_MS = 2500
/** How long to wait for the sought tab to show up in the DOM (hydration after opening). */
const TAB_LOOKUP_MS = 30 * 1000
/** Running turn: how long to wait for it. Not longer — the app watches over
 *  busy itself with the "Close running tab?" dialog, and a stuck `busyBySession`
 *  (which happens) would otherwise leave the tab hanging forever. */
const BUSY_MAX_WAIT_MS = 20 * 1000
const TILE_PREFIX = 'session-tile:'
const HOLD_ATTR = 'data-hermes-hold'
const STYLE_ID = 'hermes-session-close-style'
/** An answer containing this is never closed (a safeguard, see the header).
 *  Deliberately only a word marker — `❗` is a communication sign for the user
 *  and the agent puts it there even where closing is intended; blocking on it
 *  meant the tab did not close even on an explicit instruction. */
const HOLD_MARKERS = ['NEZAVÍRAT']

let store = null
/** sig → { id, sig, hold, now, why, since, settledAt } */
const pending = new Map()
/** id → why (holds the red bar on the tab until the user visits it) */
const held = new Map()
let busy = false
let debug = true
/** Temporary test: only log what would happen and close nothing. */
let dryRun = false

const str = value => (typeof value === 'string' ? value : '')
const norm = value => str(value).trim()
const hex = id => norm(id).replace(/^local-/, '').slice(0, 12)
const sameSession = (a, b) => !!a && !!b && (a === b || hex(a) === hex(b))

const dlog = (...args) => {
  if (debug) console.error(`[${ID}]`, ...args)
}

const readSigs = () => {
  try {
    const raw = store?.get?.(SIG_KEY, [])

    return new Set(Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

const rememberSig = sig => {
  try {
    store?.set?.(SIG_KEY, [...readSigs(), sig].slice(-MAX_SIGS))
  } catch {
    /* never mind — the request will be tried again if it stayed in the queue */
  }
}

const readQueueFile = async () => {
  const readFile = window.hermesDesktop?.readFileText
  if (typeof readFile !== 'function') return null
  try {
    for (const path of QUEUE_PATHS) {
      const result = await readFile(path)
      if (typeof result?.text === 'string') return result.text
      if (typeof result === 'string' && result) return result
    }

    return ''
  } catch {
    return null
  }
}

const parseQueue = text => {
  const out = []

  for (const line of str(text).split('\n')) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#')) continue
    let item = null
    try {
      item = JSON.parse(raw)
    } catch {
      continue
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const sessionId = norm(item.close)
    if (!sessionId) continue
    const hold = item.hold === true || typeof item.hold === 'string' ? item.hold : false
    const sig = item.id ? `id:${norm(item.id)}` : `c:${sessionId}|${hold === false ? '' : String(hold)}|${item.now === true}`
    out.push({ id: sessionId, sig, hold, now: item.now === true, why: norm(item.why), title: norm(item.title) })
  }

  return out
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const installStyle = () => {
  document.getElementById(STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  // Red bar = "there is something to read in there, that is why I did not close it".
  style.textContent = `[data-tree-tab][${HOLD_ATTR}] { box-shadow: inset -3px 0 0 0 #e5484d !important; }
[data-tree-tab][${HOLD_ATTR}] [data-slot='pane-tab'] { box-shadow: inset -3px 0 0 0 #e5484d !important; }`
  document.head.appendChild(style)
}

/** The panel tab for the given session (exact id, otherwise an unambiguous prefix). */
const findTab = sessionId => {
  const exact = document.querySelector(`[data-tree-tab="${TILE_PREFIX}${sessionId}"]`)
  if (exact) return exact

  const wanted = hex(sessionId)
  if (!wanted) return null
  const matches = [...document.querySelectorAll('[data-tree-tab^="session-tile"]')].filter(el =>
    hex((el.getAttribute('data-tree-tab') || '').slice(TILE_PREFIX.length)).startsWith(wanted)
  )

  return matches.length === 1 ? matches[0] : null
}

/**
 * Tab by session title. Necessary because compression rotates the id: `$HERMES_SESSION_ID`
 * in the chat is a RUNTIME id, whereas the tab carries a different (lineage) id — and then
 * we hit nothing by id. The title is the same in both.
 *
 * It also covers the main panel (`data-tree-tab="workspace"`): a session opened
 * "as the main one" has no `session-tile` tab, only this one — and that is
 * precisely why closing used to miss it (the tab existed, but under a different
 * key and without a session id).
 */
const tabCandidates = () =>
  [...document.querySelectorAll('[data-tree-tab]')].filter(el => {
    const key = el.getAttribute('data-tree-tab') || ''

    return key === 'workspace' || key.startsWith(TILE_PREFIX)
  })

const findTabByTitle = title => {
  const want = norm(title).toLowerCase()
  if (want.length < 6) return null
  const head = want.slice(0, 24)
  const matches = tabCandidates().filter(el => {
    const text = norm(el.textContent || '').replace(/\s+/g, ' ').toLowerCase()
    if (!text) return false

    return text.startsWith(head) || head.startsWith(text.slice(0, 24))
  })

  return matches.length === 1 ? matches[0] : null
}

/** The tab for the request: first by id, then by title. */
const resolveTab = entry => findTab(entry.id) || (entry.title ? findTabByTitle(entry.title) : null)

const closeButtonOf = tab => {
  if (!tab) return null
  if (tab.getAttribute('data-closeable') === null) return null

  return tab.querySelector('button[aria-label]') || tab.querySelector('button')
}

/** The last answer text, if that chat is mounted in the DOM. */
const lastAnswerText = sessionId => {
  const composer = document.querySelector(`[data-composer-target="tile:${sessionId}"]`)
  const surface = composer?.closest('[data-chat-surface]')
  if (!surface) return ''

  const parts = [...surface.querySelectorAll("[data-slot='aui_assistant-message-content']")]

  return parts.length ? parts[parts.length - 1].textContent || '' : ''
}

const isBusy = sessionId => {
  try {
    const map = host.state?.busyBySession?.get?.() || {}
    if (map[sessionId] === true) return true
    // compression rotates the session id — try a prefix match as well
    for (const [key, value] of Object.entries(map)) {
      if (value === true && sameSession(key, sessionId)) return true
    }

    return false
  } catch {
    return false
  }
}

const markHold = (sessionId, why) => {
  held.set(sessionId, why || '')
  const tab = findTab(sessionId)
  if (tab) tab.setAttribute(HOLD_ATTR, '1')
}

const releaseHold = sessionId => {
  if (!held.has(sessionId)) return
  held.delete(sessionId)
  const tab = findTab(sessionId)
  if (tab) tab.removeAttribute(HOLD_ATTR)
}

/** Re-applying the bar (React strips the attribute on re-render). */
const upkeep = () => {
  for (const sessionId of [...held.keys()]) {
    const tab = findTab(sessionId)
    if (!tab) {
      held.delete(sessionId)
      continue
    }
    if (tab.getAttribute(HOLD_ATTR) !== '1') tab.setAttribute(HOLD_ATTR, '1')
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const enqueue = requests => {
  const sigs = readSigs()
  for (const req of requests) {
    if (sigs.has(req.sig) || pending.has(req.sig)) continue
    pending.set(req.sig, { ...req, since: Date.now(), settledAt: null })
    dlog('přijato', hex(req.id), req.hold, req.now)
  }
}

const finish = (entry, kind, message) => {
  pending.delete(entry.sig)
  rememberSig(entry.sig)
  if (message) host.notify({ kind, message })
  dlog('hotovo', hex(entry.id), kind, message)
}

const tabText = el => norm(el?.textContent || '').replace(/\s+/g, ' ').toLowerCase()

/** Matching the tab against the session title (the first few characters are enough, the tab shortens the title). */
const titleMatches = (el, title) => {
  const want = norm(title).toLowerCase()
  const text = tabText(el)
  if (!want || !text) return false
  const head = want.slice(0, 24)

  return text.startsWith(head) || head.startsWith(text.slice(0, 24))
}

/**
 * Verification that the tab is gone. The main panel (`workspace`) always stays
 * in the DOM — after a session is closed the app puts another one in it — so for
 * it the TEXT decides, not the presence of the element (otherwise it reports a
 * false "tab stayed open").
 */
const verifyGone = async (tab, entry) => {
  await new Promise(resolve => setTimeout(resolve, 1200))

  if (!tab.isConnected) return true
  if (tab.getAttribute('data-tree-tab') === 'workspace') {
    return !entry.title || !titleMatches(tab, entry.title)
  }

  return false
}

const process = async () => {
  if (!pending.size) return
  const now = Date.now()

  for (const entry of [...pending.values()]) {
    const tab = resolveTab(entry)

    if (!tab) {
      // The tab may only appear after hydration (opening a session takes a few
      // seconds) — so do not let the request die right away, otherwise it is lost
      // and the tab stays.
      if (now - entry.since < TAB_LOOKUP_MS) {
        dlog('čekám: tab zatím v DOM není', hex(entry.id))
        continue
      }
      finish(entry, 'info', `Tab session se nenašel (${Math.round(TAB_LOOKUP_MS / 1000)} s) — nic jsem nezavřel`)

      continue
    }

    // 1. hold (both explicit and derived from ❗ in the last answer)
    if (entry.hold) {
      const why = typeof entry.hold === 'string' ? entry.hold : entry.why
      if (dryRun) {
        console.error(`[${ID}] DRY-RUN: hold ${hex(entry.id)}`)
        finish(entry, 'info', `Test: tab by zůstal s ❗${why ? `: ${why}` : ''}`)

        continue
      }
      markHold(entry.id, why)
      finish(entry, 'warning', `❗ Nechávám tab otevřený${why ? `: ${why}` : ''}`)

      continue
    }

    const text = lastAnswerText(entry.id)
    if (text && HOLD_MARKERS.some(marker => text.includes(marker))) {
      markHold(entry.id, '')
      finish(entry, 'warning', '❗ Poslední odpověď má vykřičník — tab nechávám otevřený')

      continue
    }

    // 2. running turn — wait so that it does not close in the middle of work; after
    //    20 s go ahead anyway, because `busyBySession` can stay stuck
    if (isBusy(entry.id) && now - entry.since < BUSY_MAX_WAIT_MS) {
      dlog('čekám: běží turn', hex(entry.id))
      continue
    }

    // 3. a short delay after the turn ends (the answer must land in the DOM)
    const settle = entry.now ? 0 : SETTLE_MS
    if (entry.settledAt === null) entry.settledAt = now
    if (now - entry.settledAt < settle) {
      dlog('čekám: dojezd tahu', hex(entry.id), Math.round((settle - (now - entry.settledAt)) / 100) / 10 + 's')
      continue
    }

    // 4. close = a click on the ✕ of that panel (the same path as closing by hand)
    const button = closeButtonOf(tab)
    if (!button) {
      finish(entry, 'error', 'Tenhle panel nejde zavřít (nemá ✕)')

      continue
    }

    try {
      if (dryRun) {
        console.error(`[${ID}] DRY-RUN: zavřel bych ${hex(entry.id)}`)
        finish(entry, 'info', `Test: tab by se zavřel (${hex(entry.id)}…)`)

        continue
      }
      button.click()
    } catch (error) {
      finish(entry, 'error', `Zavření selhalo: ${String(error?.message || error).slice(0, 80)}`)

      continue
    }

    dlog('zavírám tab', (tab.getAttribute('data-tree-tab') || '').slice(0, 30))
    releaseHold(entry.id)
    if (await verifyGone(tab, entry)) {
      finish(entry, 'success', 'Tab zavřen')
    } else {
      finish(entry, 'warning', 'Appka se ptá na potvrzení — tab zůstal otevřený')
    }
  }
}

const poll = async () => {
  if (busy) return
  busy = true
  try {
    const text = await readQueueFile()
    if (text != null) enqueue(parseQueue(text))
    await process()
  } catch (error) {
    console.error(`[${ID}] poll selhal: ${String(error?.message || error)}`)
  } finally {
    busy = false
  }
}

export default {
  id: ID,
  name: 'Session close',
  register(ctx) {
    if (!ENABLED) return

    store = ctx.storage

    // Hot reload runs again in the same document — take down the old interval and style.
    if (typeof window.__sessionCloseDispose === 'function') window.__sessionCloseDispose()

    // The new instance holds nothing — after a reload the old bars would stay hanging with no owner.
    document.querySelectorAll(`[${HOLD_ATTR}]`).forEach(el => el.removeAttribute(HOLD_ATTR))

    installStyle()

    // The "there is something to read" bar disappears as soon as you click that tab.
    const onPointerDown = event => {
      const node = event.target
      const tab = node && typeof node.closest === 'function' ? node.closest('[data-tree-tab^="session-tile"]') : null
      if (!tab) return
      const id = (tab.getAttribute('data-tree-tab') || '').slice(TILE_PREFIX.length)
      for (const heldId of [...held.keys()]) {
        if (sameSession(heldId, id)) releaseHold(heldId)
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)

    let timer = null
    let first = null

    window.__sessionCloseDispose = () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      if (timer) clearInterval(timer)
      if (first) clearTimeout(first)
      timer = null
      first = null
      document.getElementById(STYLE_ID)?.remove()
    }

    // 3 s: so that it is visible the plugin came up, also in `desktop.log` (console.log does not get there).
    first = setTimeout(() => {
      try {
        console.error(`[${ID}] loaded · queue: ${QUEUE}`)
      } catch {
        /* ignore */
      }
    }, 3000)

    timer = setInterval(() => {
      upkeep()
      void poll()
    }, POLL_MS)
  }
}
