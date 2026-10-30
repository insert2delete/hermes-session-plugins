/**
 * session-mint — creating a session from chat (agent → app).
 *
 * The agent has no tool that would create a real chat: `hermes chat -q` produces
 * `source='oneshot'`, which the sidebar deliberately hides, and rewriting it in
 * `state.db` means editing frozen policy + restarting the gateway from outside.
 * Only the renderer can create a real session (`session.create`). This is that
 * missing half: a file the agent writes to, and a plugin that reads it.
 *
 * THE AGENT WRITES (append-only, one JSON per line):
 *
 *   echo '{"id":"20261029-1830-barvy","title":"🎨 Barvy a vzhled","project":"Hermes",
 *          "text":"Přečti docs/HANDOFF-barvy.md a začni bodem 1."}' \
 *     >> ~/.hermes/session-requests.jsonl
 *
 *   title    optional — the session name (convention: emoji + space + text).
 *            NO title = leave it to Hermes: it takes the first 48 characters of
 *            the first message and then a small model refines it — so the name
 *            grows out of the content instead of being set up front. With a title
 *            the opposite holds: `title_source='user'` applies and the automation
 *            never renames it again.
 *   text     optional — text PRE-FILLED in the composer of the new session, so the
 *            assignment doesn't have to be copied over. It is inserted through
 *            `host.composer.setDraft` (the app hydrates it as a normal paste, so
 *            `@`/`/` tokens stay chips); as a fallback through the draft in
 *            localStorage. Nothing is sent — the user has to send it.
 *   project  optional — project name / slug / id; cwd is taken from primary_path
 *   cwd      optional — explicit folder (overrides the project)
 *   id       optional — unique key of the request (without it title|cwd|project)
 *   profile  optional — the profile in which the session should be created
 *   send     optional, OPT-IN — send it so the turn starts by itself (without it
 *            the field is only pre-filled and the user is waited for). Accepted
 *            also as `odeslat`, `odesli`, `poslat`, `rovnou-odeslat`,
 *            `rovnou_provest`, `provest`, `vykonat`, `prikaz`. `true`/`"ano"` =
 *            send `text`; any other string = send EXACTLY THAT text and leave
 *            `text` in the field.
 *
 * OPEN an existing session in a NEW TAB (a link from chat, nothing is created):
 *
 *   echo '{"id":"open-1","open":"local-feea94cbc29391de"}' >> ~/.hermes/session-requests.jsonl
 *
 *   open     full id, or an unambiguous prefix (`local-feea94cb`)
 *   text     optional — PRE-FILLS the field of the opened session (draft + live
 *            composer, the same path as for creating one). It is never sent:
 *            `send` is meaningless with `open` and the plugin only logs it as
 *            ignored — it never enters a session in progress without the user
 *            knowing.
 * The line is written by `~/.local/bin/hermes-url`, which provides `hermes://tab/<id>`
 * (the `hermes-url.desktop` handler). It opens with `intent: 'tab'`, so the chat
 * the user has in front of them stays as it is — a link never overwrites the main tab.
 *
 * MOVE an existing session (the same queue, a different shape — `move` + `to`):
 *
 *   echo '{"id":"mv-1","move":"Design and renovation of bathroom","to":"Koupelna"}' \
 *     >> ~/.hermes/session-requests.jsonl
 *
 *   move     session name, or its id (`local-…` = used directly)
 *   to       target project (name / slug / id); `cwd` overrides it
 * It calls `session.workspace.move` = the same path as dragging onto a project or
 * "⋯ → Move to project", so the cwd moves too and so does the project tree.
 * A running turn refuses the move (`session_busy`) — the plugin retries for ~2 minutes.
 *
 * At least one of `title` / `project` / `cwd` / `move` must be filled in, otherwise
 * the line is skipped.
 *
 * The plugin reads the file every second, creates the session with the given `cwd`
 * (which files it under the project — the sidebar groups by folder), opens it as a
 * tab and reports it. It remembers processed requests in `ctx.storage`, so an app
 * restart creates nothing twice; when a session with that name already exists, it
 * doesn't create a second one.
 *
 * Feedback for the agent: a row in `state.db` (`sessions.title` + `cwd`) — the
 * renderer can't write anything, the file is one-way only.
 *
 * A/B: ENABLED = false and save. Cleanup: delete the folder.
 */

import { host } from '@hermes/plugin-sdk'

const ID = 'session-mint'
const ENABLED = true
// The Desktop read bridge opens a path literally — it does not expand `~` — so the
// queue path has to be absolute. Set HERMES_DIR once after installing the plugin
// (Linux/macOS: /home/<you>/.hermes, Windows: C:\Users\<you>\.hermes).
// The `~` form is kept as a fallback in case a build ever starts expanding it.
const HERMES_DIR = '/home/USER/.hermes'
const REQUESTS = `${HERMES_DIR}/session-requests.jsonl`
const REQUEST_PATHS = Array.from(new Set([REQUESTS, '~/.hermes/session-requests.jsonl']))
// 1 s, not 5 s: a click on `hermes://tab/<id>` only writes a line into the queue and
// this poll is supposed to pick it up right away — with a link in chat, a five-second wait is visible.
const POLL_MS = 1_000
const FIRST_MS = 2_000
const SIG_KEY = 'minted.v1'
const MAX_SIGS = 200
const MAX_ATTEMPTS = 3
const BUSY_ATTEMPTS = 24

const str = value => (typeof value === 'string' ? value : '')
const norm = value => str(value).trim().replace(/\s+/g, ' ')
// Text for the composer: trim the edges, but KEEP the inner line breaks (the
// assignment is usually a bulleted list, not a single line).
const para = value => str(value).replace(/\r\n/g, '\n').trim()

// -------------------------------------------------- "send" (opt-in) --------
// By default the plugin only PRE-FILLS the field and waits for the user. Sending
// (the turn starts by itself, without confirmation) happens only when the request
// says so explicitly — hence several field names: `send`, `odeslat`,
// `rovnou-odeslat`, `rovnou_provest`, `prikaz`… The value `true`/`"ano"` = send
// `text`; any other string = send EXACTLY THIS text and leave `text` in the field
// as a draft.
const SEND_KEYS = [
  'send',
  'odeslat',
  'odesli',
  'poslat',
  'posli',
  'rovnou-odeslat',
  'rovnou_odeslat',
  'rovnouodeslat',
  'rovnou-provest',
  'rovnou_provest',
  'rovnouprovest',
  'provest',
  'vykonat',
  'prikaz'
]
const SEND_ON = new Set(['1', 'true', 'yes', 'y', 'ano', 'a', 'on', 'send', 'odeslat'])
const SEND_OFF = new Set(['', '0', 'false', 'no', 'n', 'ne', 'off'])
const SEND_NONE = { sendOn: false, sendText: '' }

const readSend = item => {
  for (const key of SEND_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue
    const raw = item[key]

    if (raw === true) return { sendOn: true, sendText: '' }
    if (raw === false || raw === null || raw === undefined) return SEND_NONE
    if (typeof raw === 'number') return raw === 0 ? SEND_NONE : { sendOn: true, sendText: '' }

    const value = para(raw)
    const low = value.toLowerCase()

    if (SEND_OFF.has(low)) return SEND_NONE
    if (SEND_ON.has(low)) return { sendOn: true, sendText: '' }

    return value ? { sendOn: true, sendText: value } : SEND_NONE
  }

  return SEND_NONE
}

// ------------------------------------------------------ pure helpers -------
// Exported for the node probe (tools/session-mint-test.mjs) — without the app.

const parseRequests = text => {
  const out = []
  const seen = new Set()
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
    const req = {
      ...readSend(item),
      cwd: str(item.cwd).trim(),
      id: norm(item.id),
      move: norm(item.move),
      open: norm(item.open ?? item.otevrit ?? item.otevri),
      profile: norm(item.profile),
      project: norm(item.project),
      text: para(item.text),
      title: norm(item.title),
      to: norm(item.to)
    }
    if (!req.move && !req.open && !req.title && !req.project && !req.cwd) continue
    const sig = signatureOf(req)
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(req)
  }
  return out
}

const signatureOf = req => {
  if (req.id) return `id:${req.id}`
  if (req.move) return `m:${req.move}|${req.to || req.cwd}`
  if (req.open) return `o:${req.open}`

  return `t:${req.title}|${req.cwd}|${req.project}`
}

/** `local-<hex>` is passed to the gateway as-is; anything else is a title. */
const looksLikeSessionId = value => /^local-[0-9a-f]{16,}$/i.test(norm(value))

const matchProject = (projects, hint) => {
  const want = norm(hint).toLowerCase()
  if (!want) return null
  const rows = Array.isArray(projects) ? projects.filter(p => p && typeof p === 'object') : []
  const byKey = rows.find(p => norm(p.slug).toLowerCase() === want || norm(p.id).toLowerCase() === want)
  if (byKey) return byKey
  return rows.find(p => norm(p.name).toLowerCase() === want) || null
}

const projectCwd = project => {
  if (!project) return ''
  const primary = str(project.primary_path).trim()
  if (primary) return primary
  const folders = Array.isArray(project.folders) ? project.folders : []
  const folder = folders.find(f => f && f.is_primary) || folders[0]
  return str(folder?.path).trim()
}

// ---------------------------------------------------------------- runtime --

let store = null
let busy = false
const attempts = new Map()

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
    const next = [...readSigs(), sig].slice(-MAX_SIGS)
    store?.set?.(SIG_KEY, next)
  } catch {
    /* no big deal — the request is retried next time, the title check catches duplicates */
  }
}

const currentProfile = () => (host.state?.profile?.get?.() || 'default').trim() || 'default'

const readRequestsFile = async () => {
  const readFile = window.hermesDesktop?.readFileText
  if (typeof readFile !== 'function') return null
  try {
    for (const path of REQUEST_PATHS) {
      const result = await readFile(path)
      if (typeof result?.text === 'string') return result.text
      if (typeof result === 'string' && result) return result
    }

    return ''
  } catch {
    return null
  }
}

const sessionIdByTitle = async title => {
  try {
    const found = await host.request('session.list', { title })

    // Two shapes are in play: a bare `{ session_id }` and the titled-lookup
    // envelope `{ sessions: [...] }`. A helper that only reads the first one
    // silently returns '' — which reads as "no such session" and made the move
    // path fail while the session was right there.
    const direct = str(found?.session_id)

    if (direct) return direct

    const rows = Array.isArray(found?.sessions) ? found.sessions : []
    const exact = rows.find(row => norm(row?.title).toLowerCase() === norm(title).toLowerCase()) || rows[0]

    return str(exact?.session_id) || str(exact?.id)
  } catch {
    return ''
  }
}

const DRAFT_KEY = 'hermes:composer-drafts:v3'
const DRAFT_SYNC_EVENT = 'hermes:composer-draft-sync'
const DRAFT_ATTEMPTS = 24
const DRAFT_RETRY_MS = 250

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Text into the composer through the app's interface (`host.composer.setDraft`):
 * the mounted surface takes it as a normal paste and answers `true`. But the
 * surface is mounted only after `openSession`, so this is retried in a loop for a
 * while — otherwise the text is dropped as "fail closed" and the user sees an
 * empty field.
 */
const setDraftWithRetry = async (sessionId, text) => {
  const setDraft = host.composer?.setDraft
  if (typeof setDraft !== 'function') return false
  for (let attempt = 0; attempt < DRAFT_ATTEMPTS; attempt += 1) {
    try {
      if (await setDraft(sessionId, text)) {
        console.error(`[${ID}] setDraft ok (pokus ${attempt + 1}) ${sessionId}`)
        return true
      }
    } catch (error) {
      /* the surface isn't there yet — retry in 250 ms */
      console.error(`[${ID}] setDraft pokus ${attempt + 1} selhal: ${String(error?.message || error)}`)
    }
    await sleep(DRAFT_RETRY_MS)
  }
  return false
}

/**
 * Sending (`host.composer.submit`) — inserts the text and presses Enter, so the
 * turn starts by itself. It is called ONLY on an explicit request in the payload
 * (`send`), so the app doesn't kick off work without the user knowing. `submit` is
 * synchronous and fail-closed: `false` = no visible composer is mounted for that session.
 */
const submitWithRetry = async (sessionId, text) => {
  const submit = host.composer?.submit
  if (typeof submit !== 'function') return false
  for (let attempt = 0; attempt < DRAFT_ATTEMPTS; attempt += 1) {
    try {
      if (submit(sessionId, text)) {
        console.error(`[${ID}] submit ok (pokus ${attempt + 1}) ${sessionId}`)
        return true
      }
    } catch (error) {
      console.error(`[${ID}] submit pokus ${attempt + 1} selhal: ${String(error?.message || error)}`)
    }
    await sleep(DRAFT_RETRY_MS)
  }
  return false
}

/**
 * Fallback path for builds without `host.composer`: the draft is written into the
 * same storage the app reads (`hermes:composer-drafts:v3`) and a "reload" signal is
 * dispatched. The draft map is loaded only when the module starts, so without that
 * signal the write wouldn't propagate into the running window at all.
 */
const stashDraftLocally = (sessionId, text) => {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    const map = raw ? JSON.parse(raw) : {}
    map[sessionId] = text
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(map))
  } catch {
    return false
  }
  for (const target of ['main', `tile:${sessionId}`]) {
    try {
      window.dispatchEvent(new CustomEvent(DRAFT_SYNC_EVENT, { detail: { mode: 'reload', target } }))
    } catch {
      /* an older build doesn't know the event — nothing happens */
    }
  }
  return true
}

const mint = async req => {
  const profile = req.profile || currentProfile()

  let cwd = req.cwd
  if (!cwd && req.project) {
    const list = await host.request('projects.list', {})
    const project = matchProject(list?.projects, req.project)
    if (!project) throw new Error(`projekt „${req.project}“ neexistuje`)
    cwd = projectCwd(project)
  }
  if (!cwd) cwd = str(host.state?.cwd?.get?.()).trim()

  const existingId = req.title ? await sessionIdByTitle(req.title) : ''

  if (existingId) {
    // I'm not creating a new session. But when the request wants to send, it goes
    // into the existing one — `submit` is fail-closed, so the session must be open.
    if (req.sendOn) {
      const body = req.sendText || req.text
      const sent = body ? await submitWithRetry(existingId, body) : false

      host.notify({
        kind: sent ? 'success' : 'error',
        message: sent
          ? `Posláno do existující session „${req.title}“`
          : `Session „${req.title}“ existuje, ale není otevřená — pošli to ručně`
      })

      return
    }

    host.notify({ kind: 'info', message: `Session „${req.title}“ už existuje — nezakládám druhou` })
    return
  }

  const created = await host.request('session.create', {
    cols: 100,
    ...(cwd ? { cwd } : {}),
    source: 'desktop',
    ...(req.title ? { title: req.title } : {})
  })
  const newId = str(created?.stored_session_id) || str(created?.session_id)
  if (!newId) throw new Error('session.create nevrátil id')

  try {
    await host.openSession(newId, { profile, intent: 'tab' })
  } catch {
    // Some builds can't open an empty draft by id — create the draft the classic
    // way and glue the name onto it (best effort).
    host.newChat(profile)
    if (req.title) await host.request('session.title', { title: req.title }).catch(() => undefined)
  }

  // Text into the composer: first a persistent write (survives an app reload), then
  // an insert into the live surface. Sending is opt-in (`send`): without it nothing
  // is sent and Enter stays with the user.
  let seeded = false
  let sent = false
  const body = req.sendText || req.text

  if (body) {
    if (req.sendOn) {
      // Separate text to send + `text` as a draft in the field = the user sees the
      // assignment, but only that short sentence goes into the model.
      if (req.text && req.text !== body) stashDraftLocally(newId, req.text)

      sent = await submitWithRetry(newId, body)

      if (!sent) {
        seeded = await setDraftWithRetry(newId, body)
        host.notify({ kind: 'error', message: 'Odeslání selhalo (composer nenaběhl) — text je v poli' })
      }
    } else {
      stashDraftLocally(newId, body)
      seeded = await setDraftWithRetry(newId, body)
      if (!seeded) console.error(`[${ID}] text se nevložil do composeru ${newId}`)
    }
  }

  const name = req.title ? `„${req.title}“` : '(bez názvu — pojmenuje se z 1. zprávy)'
  const note = sent
    ? ' · odesláno (turn běží)'
    : req.text
      ? seeded
        ? ' · text v composeru'
        : ' · text v draftu (klikni do pole)'
      : ''
  host.notify({ kind: 'success', message: `Nová session ${name}${cwd ? ` · ${cwd}` : ''}${note}` })
}

const moveSession = async req => {
  const target = req.to || req.project
  let cwd = req.cwd

  if (!cwd) {
    if (!target) throw new Error('chybí „to“ (projekt) nebo „cwd“')
    const list = await host.request('projects.list', {})
    const project = matchProject(list?.projects, target)

    if (!project) throw new Error(`projekt „${target}“ neexistuje`)
    cwd = projectCwd(project)
  }

  if (!cwd) throw new Error(`projekt „${target}“ nemá složku`)

  const sessionId = looksLikeSessionId(req.move) ? req.move : await sessionIdByTitle(req.move)

  if (!sessionId) throw new Error(`session „${req.move}“ nenalezena`)

  try {
    await host.request('session.workspace.move', { cwd, session_key: sessionId })
  } catch (error) {
    const reason = error?.data?.reason || ''

    if (reason === 'session_busy') {
      const busyError = new Error(`session „${req.move}“ právě běží — přesun zkusím znovu`)

      busyError.retryable = true
      throw busyError
    }

    throw new Error(`${reason || error?.message || error} (přesun „${req.move}“ → ${target || cwd})`)
  }

  host.notify({ kind: 'success', message: `Session „${req.move}“ přesunuta → ${target || cwd}` })
}

/**
 * `<id>` as well as a shortened prefix (`local-feea94cb`) → the full id. A link in
 * chat should be short, but `session.list` wants the full id, so an unambiguous
 * prefix is looked up.
 */
const resolveSessionRef = async ref => {
  const want = norm(ref)
  if (!want) return ''
  try {
    const found = await host.request('session.list', {})
    const rows = Array.isArray(found?.sessions) ? found.sessions : []
    const ids = rows.map(row => str(row?.session_id) || str(row?.id)).filter(Boolean)
    const exact = ids.find(id => id === want)
    if (exact) return exact
    const hits = ids.filter(id => id.startsWith(want))
    return hits.length === 1 ? hits[0] : ''
  } catch {
    return ''
  }
}

/**
 * Is there anything in the target session's composer that the insert would
 * overwrite? `getDraft` reads the live text of the mounted surface (including
 * characters that aren't saved yet), so it is exactly what the user would lose.
 * `null` = the surface doesn't answer, there is nothing to rescue.
 */
const composerHasText = async id => {
  try {
    const draft = await host.composer?.getDraft?.(id)
    return typeof draft === 'string' && draft.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Opening a session in a NEW TAB — `{open: "<id or prefix>"}`. This is written by
 * `~/.local/bin/hermes-url` on a click on `hermes://tab/<id>`, so the link never
 * overwrites the chat the user has in front of them (`intent: 'tab'`).
 *
 * `text` with `open` means the same as with creating one: PRE-FILL the field — but
 * only when it is empty. When there is already something in the target, the plugin
 * LEAVES it alone (an open session is somebody else's work in progress) and only
 * reports "there was already something in the field". Sending (`send`) deliberately
 * doesn't apply here — an open session may be work in progress and sending would
 * enter it without the user knowing.
 */
const openSessionTab = async req => {
  const id = await resolveSessionRef(req.open)

  console.error(`[${ID}] open „${req.open}“ → ${id || '(nenalezeno)'}`)
  if (!id) throw new Error(`session „${req.open}“ nenalezena`)

  if (req.sendOn) console.error(`[${ID}] open: „send“ ignorován — u otevřené session se neodesílá`)

  await host.openSession(id, { profile: req.profile || currentProfile(), intent: 'tab' })
  console.error(`[${ID}] tab otevřen ${id}`)

  // Text into the composer of the opened session — the same path as in mint():
  // a persistent write (survives an app reload) + an insert into the live surface.
  // WITHOUT sending.
  //
  // With `open`, though, what is already there is NEVER overwritten: an open session
  // is somebody else's work in progress. Creating a new session (mint) is a different
  // case — there the field is empty from the moment it comes into existence, which is
  // why we insert unconditionally there.
  let seeded = false
  let kept = false
  if (req.text) {
    kept = await composerHasText(id)
    if (kept) {
      console.error(`[${ID}] open: v composeru už text je — nepřepisuju ${id}`)
    } else {
      stashDraftLocally(id, req.text)
      seeded = await setDraftWithRetry(id, req.text)
      if (!seeded) console.error(`[${ID}] open: text se nevložil do composeru ${id}`)
    }
  }

  const note = kept
    ? ' · v poli už něco bylo, nechal jsem to'
    : req.text
      ? seeded
        ? ' · text v composeru'
        : ' · text v draftu (klikni do pole)'
      : ''
  host.notify({
    kind: kept ? 'info' : 'success',
    message: `Otevřeno v novém tabu: ${id.slice(0, 14)}…${note}`
  })
}

const poll = async () => {
  if (busy) return
  busy = true
  try {
    const text = await readRequestsFile()
    if (text == null) return
    for (const req of parseRequests(text)) {
      const sig = signatureOf(req)
      if (readSigs().has(sig)) continue
      try {
        if (req.move) await moveSession(req)
        else if (req.open) await openSessionTab(req)
        else await mint(req)
        attempts.delete(sig)
        rememberSig(sig)
      } catch (error) {
        const limit = error?.retryable === true ? BUSY_ATTEMPTS : MAX_ATTEMPTS
        const count = (attempts.get(sig) || 0) + 1
        attempts.set(sig, count)
        if (count >= limit) {
          attempts.delete(sig)
          rememberSig(sig)
          const what = req.move ? `Přesun „${req.move}“` : `Session „${req.title}“`
          const message = String(error?.message || error).slice(0, 120)
          host.notify({ kind: 'error', message: `${what}: ${message}` })
        }
      }
    }
  } catch (error) {
    console.error(`[${ID}] poll selhal: ${String(error?.message || error)}`)
  } finally {
    busy = false
  }
}

export default {
  id: ID,
  name: 'Session mint',
  register(ctx) {
    if (!ENABLED) return

    store = ctx.storage

    // Hot reload runs again in the same document — tear down the old interval.
    if (typeof window.__sessionMintDispose === 'function') window.__sessionMintDispose()

    let timer = null
    let first = null

    window.__sessionMintDispose = () => {
      if (timer) clearInterval(timer)
      if (first) clearTimeout(first)
      timer = null
      first = null
    }

    // Probe for `~/.hermes/logs/desktop.log` (console.log doesn't make it there).
    console.error(`[${ID}] loaded · requests: ${REQUESTS}`)

    window.__sessionMint = {
      matchProject,
      mintTitle: title => mint({ cwd: '', id: '', profile: '', project: '', text: '', title: norm(title) }),
      move: req => moveSession({ cwd: '', id: '', move: '', profile: '', project: '', title: '', to: '', ...req }),
      parseRequests,
      poll,
      projectCwd,
      signatures: () => [...readSigs()],
      signatureOf
    }

    first = setTimeout(() => void poll(), FIRST_MS)
    timer = setInterval(() => void poll(), POLL_MS)

    ctx.register({
      id: 'scan',
      area: 'palette',
      data: {
        id: `${ID}.scan`,
        keywords: ['session', 'mint', 'zalozit', 'založit', 'session-mint'],
        label: 'Session mint: check requests',
        run: () => void poll()
      }
    })
  }
}

export { looksLikeSessionId, matchProject, parseRequests, projectCwd, signatureOf }
