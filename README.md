# hermes-session-plugins

Two small Desktop plugins that fill a gap in Hermes Agent: **the agent cannot create or close a real session**. Every chat it opens from a tool is a `oneshot` (`hermes chat -q`), which the sidebar deliberately hides, and there is no tool at all for closing a Desktop tab.

These plugins put a file between the two sides — the agent appends one JSON line, the plugin reads it and asks the app to do the thing through the app's own code paths. No core patch, no rebuild, survives `hermes update`.

| Plugin | What it does | Side it needs |
|---|---|---|
| [`session-mint`](session-mint/) | creates a real, visible session; prefills its composer; opens an existing one in a new tab; moves a session to another project | agent writes JSONL |
| [`session-close`](session-close/) | closes the tab of the session that just answered, once the turn finishes | ships a `hermes-close-session` script |

Both run in the Desktop renderer only — nothing listens on a port, nothing calls the network.

## Install

```bash
git clone https://github.com/insert2delete/hermes-session-plugins
cp -r hermes-session-plugins/session-mint  ~/.hermes/desktop-plugins/
cp -r hermes-session-plugins/session-close ~/.hermes/desktop-plugins/
cp hermes-session-plugins/session-close/bin/hermes-close-session ~/.local/bin/
chmod +x ~/.local/bin/hermes-close-session
```

Then **one edit** in each plugin: the queue file path is absolute, because the Desktop read bridge opens paths literally and does not expand `~`. Set it to your own home directory:

```js
// session-mint/desktop/plugin.js  (and the same constant in session-close)
const HERMES_DIR = '/home/USER/.hermes'
```

The app loads `desktop-plugins/` within a few seconds and hot-reloads on every save. If a plugin does not appear, run ⌘K → **Reload desktop plugins** and check `~/.hermes/logs/desktop.log`.

## session-mint

The agent (or you, or a cron job) appends one JSON object per line to `$HERMES_DIR/session-requests.jsonl`; the plugin polls it every second.

**Create a session**

```json
{"title":"🎨 Colours","project":"Hermes","text":"Read docs/HANDOFF-colours.md and start with point 1."}
```

- `title` — the session name. Leave it out to let Hermes name the session from the first message (the auto-namer will keep improving it; a `title` set here is treated as user-chosen and never rewritten).
- `project` — a project name as it appears in the Desktop; its `cwd` is resolved from `projects.db`. Alternatively pass `cwd` directly.
- `text` — prefilled into the composer, **not** sent.
- `send` — `true` (or a string) sends the message too, so the new session's first turn starts on its own. A string value is sent as the text, letting `text` stay as an editable draft in the composer.
- `profile` — a Hermes profile name; defaults to the active one.

**Open an existing session in a new tab** (the current chat is never replaced)

```json
{"open":"local-4d6b54d6","text":"anything optional"}
```

`open` accepts a full id or an unambiguous id prefix. `text` is only filled when the target composer is empty — a draft you were writing is never overwritten.

**Move a session to another project**

```json
{"move":"🎨 Colours","to":"Bathroom"}
```

The session keeps its id and history; only the project row changes. If the session is mid-turn the plugin retries for ~2 minutes instead of failing.

## session-close

```bash
hermes-close-session                    # close once the answer finishes (~2.5 s later)
hermes-close-session --now              # close immediately
hermes-close-session --hold "to read"   # do NOT close; keep the tab, flag it
hermes-close-session --session local-…  # another session (default: $HERMES_SESSION_ID)
```

It appends one line to `$HERMES_DIR/session-close.jsonl` and the plugin clicks the panel's ✕ — the same path as a manual close, so the app's own "Close running tab?" guard still applies. A running turn is waited out (up to 20 s), then the tab closes even if it is in front of you. The session stays in the sidebar.

`--hold` is for the opposite case: the answer carries something the reader must decide, so the tab stays and carries a red bar until it is visited.

## Why this is not a core patch

Both halves belong in the API, not in a file queue. The relevant ask upstream is
[NousResearch/hermes-agent#140199](https://github.com/NousResearch/hermes-agent/issues/140199) — "Plugin API: public seams for … creating a visible session from a plugin". If that lands, these plugins become unnecessary.

Until then the queue is what makes it work: the renderer is the only place that can call `session.create`, and the agent is the only place that knows what to create.

## Known limits

- Written against the Desktop build of commit `bf0203a` (2026-10-24). `session-close` finds the tab by DOM (`data-tree-tab`); a release that renames that attribute will make it stop finding tabs — it logs `čekám: tab zatím v DOM není` / `nenašel` and does nothing rather than closing the wrong tab.
- `session-mint` retries the composer mount 24 × 250 ms because there is no "session ready" signal; on a slow machine the draft can land after the tab already looks settled.
- Compression rotates session ids. Both plugins therefore match by id *and* title.
- No self-update, no network, no config beyond `HERMES_DIR`.

## License

MIT — see [LICENSE](LICENSE).
