// marexec-ping: in a session where /marexec-watch is on, checks the shared Linear team every few
// minutes (scripts/marexec_ping.py, through Linear's MCP server signed in with /marexec-login, or
// through Aperture when mcp_url is an Aperture address). When the other side comments or hands an
// issue back, it sends a desktop notification and wakes this session, which drafts a reply into
// the MAREXEC pane. The pane lists open issues by whose turn it is; a band above the prompt shows
// time since you last read and a countdown to the next check. Nothing is written to Linear
// except by your click on "Approve and post" or "Move to ... turn".
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Draft, Handled, Issue, News, Plan, PlanItem } from '../types'

type Options = {
  team: string; connector: string; interval_minutes: number; mcp_url: string; python: string
}

const PANE = 'marexec'
const DRAFT_TOOL = 'mcp__marexec-ping__marexec_draft'
// ponytail: workspace slug fixed to the shared MAREXEC workspace; make it a setting if a second workspace appears.
const LINEAR_URL = 'https://linear.app/joe-olive/issue/'
const ROWS = 6
// The status a finished issue is closed into.
const DONE = 'Done'
// A faint gray wash: lifts an open row off the pane in both light and dark themes.
const OPEN_BG = 'rgba(128, 128, 128, 0.12)'
// Blue wash under the pointer, matching the pane's blue, so the row you're on stands out.
const HOVER_BG = 'rgba(88, 150, 240, 0.25)'

const WATCHING = { plugin: 'marexec-ping', key: 'watching' } as const
const issues = atom({ plugin: 'marexec-ping', key: 'issues' } as const, [], { shape: 'issues-1' })
const news = atom({ plugin: 'marexec-ping', key: 'news' } as const, [], { shape: 'news-2' })
const drafts = atom({ plugin: 'marexec-ping', key: 'drafts' } as const, {}, { shape: 'drafts-1' })
const handled = atom({ plugin: 'marexec-ping', key: 'handled' } as const, {}, { shape: 'handled-2' })
const expanded = atom({ plugin: 'marexec-ping', key: 'expanded' } as const, '')
const tab = atom({ plugin: 'marexec-ping', key: 'tab' } as const, 'mine')
const showAll = atom({ plugin: 'marexec-ping', key: 'showAll' } as const, false)
const lastReadAt = atom({ plugin: 'marexec-ping', key: 'lastReadAt' } as const, 0)
const nextCheckAt = atom({ plugin: 'marexec-ping', key: 'nextCheckAt' } as const, 0)
const now = atom({ plugin: 'marexec-ping', key: 'now' } as const, 0)
const working = atom({ plugin: 'marexec-ping', key: 'working' } as const, '')
const plan = atom({ plugin: 'marexec-ping', key: 'plan' } as const, { at: 0, items: [] }, { shape: 'plan-1' })
const PLAN_TOOL = 'mcp__marexec-ping__marexec_plan'
const PLAN_STATUS_TOOL = 'mcp__marexec-ping__marexec_plan_status'

let o: Options
let timer: { cancel: () => void } | undefined
let ticker: { cancel: () => void } | undefined
let busy = false
// Which side this machine is on: set once with the picker or /marexec-side, kept across sessions.
// No default: a copy that guessed the wrong side would hand issues to itself.
let side = ''
// Aperture's name for the Linear connection holding the board: /marexec-connector, else the setting.
// Empty (the default) means Linear's own server, whose tools have no prefix.
let connector = ''
const SIDES = ["Joe's Team", "Marco's Team"]
let python: string | undefined

const other = () => (side === "Joe's Team" ? "Marco's Team" : "Joe's Team")
const short = (side: string) => (side === "Joe's Team" ? 'Joe' : 'Marco')
const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

async function findPython($: any) {
  for (const cmd of ['python3', 'python']) {
    const r = await $.process.run([cmd, '--version']).catch(() => undefined)
    if (r?.exitCode === 0 && /Python 3/.test(r.stdout + r.stderr)) return cmd
  }
  return undefined
}

async function script($: any, args: string[], stdin?: string) {
  python ??= o.python || (await findPython($))
  if (!python) throw new Error('no Python 3 found')
  return $.process.run([python, `${$.plugin.root}/scripts/marexec_ping.py`,
    '--team', o.team, '--waiting', `Waiting on ${side}`, '--server', o.mcp_url,
    '--connector', connector, ...args],
    { timeoutMs: 300_000, ...(stdin === undefined ? {} : { stdin }) })
}

async function check($: any) {
  if (busy || !side) return
  busy = true
  try {
    await update($, nextCheckAt, () => 0)
    const r = await script($, [])
    // Exit 2: the Linear sign-in is missing or expired.
    if (r.exitCode === 2) return void $.ui.status('MAREXEC: Linear sign-in needed, run /marexec-login')
    if (r.exitCode !== 0) return void $.ui.status('MAREXEC: check failed, see ~/.marexec-ping/errors.log')
    const out: { pings: { id: string; text: string; closed?: boolean }[]; issues: Issue[]; answered: Record<string, number> } =
      JSON.parse(r.stdout.trim())
    // A check that lost the race for the script's lock prints an empty list: nothing to do this round.
    if (!Array.isArray(out.issues)) return
    await update($, issues, () => out.issues)
    await clearAnswered($, out.issues, out.answered ?? {})
    // 0.2.4: an issue closed anywhere (from the chat, in Linear, by the other side) leaves the pane
    // by itself: its Start work item, its draft and its card go. out.issues is every open issue on
    // the team, and a check that finds none is a failed check, so a missing id means closed (or
    // archived, deleted, moved to another team). This runs AFTER clearAnswered on purpose: a card
    // for an issue that left your Waiting status by being closed first lands in "Just handled".
    const openIds = new Set(out.issues.map(i => i.id))
    await update($, plan, p => ({ ...p, items: p.items.filter(x => openIds.has(x.issue)) }))
    await update($, news, list => list.filter(n => openIds.has(n.id)))
    await update($, drafts, d => Object.fromEntries(Object.entries(d).filter(([k]) => openIds.has(k))))
    // "Just handled" entries drop on their own after 24 hours.
    const dayAgo = (await $.clock.now()) - 24 * 3_600_000
    await update($, handled, h => Object.fromEntries(Object.entries(h).filter(([, v]) => v.at > dayAgo)))
    $.ui.status(undefined)
    const at = await $.clock.now()
    // A comment on an issue that is already closed is shown under "Just handled" and never wakes
    // the session: there is nothing to draft, and a wake-up costs usage.
    const shut = out.pings.filter(p => p.closed)
    if (shut.length) {
      const what = (p: { text: string }) => p.text.slice(p.text.indexOf(' ') + 1)
      await update($, handled, prev => ({ ...prev, ...Object.fromEntries(shut.map(p =>
        [p.id, { at, text: '', isMoved: true, note: `Closed. ${what(p)}` }])) }))
      $.ui.toast(shut.length === 1 ? `${shut[0]!.id} is closed: ${what(shut[0]!)}` : `${shut.length} closed MAREXEC issues got a last comment`)
    }
    out.pings = out.pings.filter(p => !p.closed)
    if (!out.pings.length) return
    const statusOf = new Map(out.issues.map(i => [i.id, i.status]))
    await update($, news, list => [...list, ...out.pings.map(p => ({ ...p, isRead: false, at, status: statusOf.get(p.id) ?? '' }))])
    const head = out.pings.length === 1 ? out.pings[0]!.text : `${out.pings.length} MAREXEC updates`
    const sent = await $.ui.notify(head, { title: 'MAREXEC' }).catch(() => ({ isSent: false }))
    if (!sent.isSent) $.ui.toast(head)
    void $.prompt.submit({ text: [
      `MAREXEC changed on Linear (${o.team}):`, ...out.pings.map(p => `- ${p.text}`), '',
      'For each issue, read only its newest 3 comments through Linear (list_comments with limit 3; ' +
      'read further back only if those do not make sense alone). For each one, call the ' +
      `${DRAFT_TOOL} tool with a short plain summary of what the other side said or asked and a ` +
      'suggested reply. Use an empty reply when their comment needs no answer (a thanks, an ' +
      'acknowledgement, an FYI): never draft a reply that only acknowledges. When the issue is ' +
      'finished and nothing is owed by either side, set close: true and make the reply a short ' +
      'closing note instead of handing it back. In chat, give one line per issue and do not ' +
      'repeat the draft. Post nothing to Linear: I approve from the pane.',
    ].join('\n') })
  } catch {
    $.ui.status('MAREXEC: check failed, see ~/.marexec-ping/errors.log')
  } finally {
    busy = false
    const at = (await $.clock.now()) + o.interval_minutes * 60_000
    await update($, nextCheckAt, () => at)
  }
}

// A card goes by itself once its work was done elsewhere: your side commented on the issue after
// the card appeared (you, another session, any of your agents), or the issue left your Waiting status.
async function clearAnswered($: any, open: Issue[], answered: Record<string, number>) {
  const mine = `Waiting on ${side}`
  const statusOf = new Map(open.map(i => [i.id, i.status]))
  const gone: Record<string, Handled> = {}
  for (const n of await read($, news)) {
    if (gone[n.id]) continue
    const now_ = statusOf.get(n.id)
    if ((answered[n.id] ?? 0) > n.at) gone[n.id] = { at: answered[n.id]!, text: '', isMoved: false, note: 'Answered elsewhere' }
    else if (n.status === mine && now_ !== mine) gone[n.id] = { at: await $.clock.now(), text: '', isMoved: true, note: `Now ${now_ ?? 'closed'}` }
  }
  const ids = Object.keys(gone)
  if (!ids.length) return
  await update($, handled, prev => ({ ...prev, ...gone }))
  await dropPlan($, ids)
  await update($, news, list => list.filter(n => !ids.includes(n.id)))
  await update($, drafts, d => Object.fromEntries(Object.entries(d).filter(([k]) => !ids.includes(k))))
}

async function setSide($: any, s: string) {
  if (!SIDES.includes(s)) return
  await $.store.set('side', s)
  side = s
  $.ui.toast(`MAREXEC: this machine is on ${s}`)
  if ((await $.state.get(WATCHING)).value) await start($)
}

function SidePicker($: any, e: any) {
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap"
      borderStyle="round" borderColor="warning" paddingX="sm">
      <Text color="warning" bold>MAREXEC: which side is this machine on?</Text>
      <Button key="side-joe" label="Joe's Team" onPress={() => setSide($, "Joe's Team")} />
      <Button key="side-marco" label="Marco's Team" onPress={() => setSide($, "Marco's Team")} />
    </Box>
  )
}

async function start($: any) {
  if (!side) return void $.ui.status('MAREXEC: pick your side first (/marexec)')
  timer?.cancel()
  ticker?.cancel()
  timer = $.clock.every(Math.max(1, o.interval_minutes) * 60_000, () => check($))
  ticker = $.clock.every(5_000, () => tick($))
  await tick($)
  void check($)
}

function stop() {
  timer?.cancel()
  ticker?.cancel()
  timer = ticker = undefined
}

async function tick($: any) {
  const t = await $.clock.now()
  await update($, now, () => t)
}

async function markRead($: any, id?: string) {
  const t = await $.clock.now()
  await update($, lastReadAt, () => t)
  await update($, news, list => (id ? list.map(n => (n.id === id ? { ...n, isRead: true } : n)) : []))
  // Reading everything (Mark all read, /marexec, Open MAREXEC) also clears "Just handled": you've seen it.
  if (!id) await update($, handled, () => ({}))
}

async function toggle($: any, id: string) {
  const open = await read($, expanded)
  await update($, expanded, () => (open === id ? '' : id))
  if (open !== id) await markRead($, id)
}

async function forget($: any, id: string) {
  await dropPlan($, [id])
  await update($, news, list => list.filter(n => n.id !== id))
  await update($, drafts, d => Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)))
}

async function approve($: any, id: string) {
  const d = (await read($, drafts))[id]
  const reply = d?.reply
  if (!reply || (await read($, working))) return
  await update($, working, () => `Posting on ${id}…`)
  try {
    const r = await script($, ['--post', id], reply)
    if (r.exitCode === 2) return void $.ui.toast(`Posting on ${id} needs a Linear sign-in: run /marexec-login, then post again.`)
    if (r.exitCode !== 0) return void $.ui.toast(`Posting on ${id} failed. Check Linear before trying again.`)
    const at = await $.clock.now()
    const isClose = d?.close === true
    const handBack = !isClose && d?.handBack !== false
    let isMoved = false
    if (isClose || handBack) {
      const status = isClose ? DONE : `Waiting on ${other()}`
      const m = await script($, ['--move', id, '--status', status])
      isMoved = m.exitCode === 0
      if (isMoved) await update($, issues, list => (isClose ? list.filter(i => i.id !== id)
        : list.map(i => (i.id === id ? { ...i, status } : i))))
    }
    // A closed issue has nowhere left to move, so its "Just handled" row offers no Move button.
    await update($, handled, prev => ({ ...prev, [id]: { at, text: reply, isMoved: isMoved || isClose, note: '' } }))
    await forget($, id)
    $.ui.toast(isClose ? (isMoved ? `Posted on ${id} and closed it` : `Posted on ${id}, but closing failed. Close it in Linear.`)
      : !handBack ? `Posted on ${id}` : isMoved ? `Posted on ${id} and handed to ${short(other())}`
      : `Posted on ${id}, but the move failed. Use Move on the card.`)
  } finally {
    await update($, working, () => '')
  }
}

async function move($: any, id: string) {
  if (await read($, working)) return
  const status = `Waiting on ${other()}`
  await update($, working, () => `Moving ${id}…`)
  try {
    const r = await script($, ['--move', id, '--status', status])
    if (r.exitCode !== 0) return void $.ui.toast(`Moving ${id} failed. Check Linear.`)
    await update($, issues, list => list.map(i => (i.id === id ? { ...i, status } : i)))
    await update($, handled, prev => (prev[id] ? { ...prev, [id]: { ...prev[id]!, isMoved: true } } : prev))
    await dropPlan($, [id])
    $.ui.toast(`${id} moved to ${status}`)
  } finally {
    await update($, working, () => '')
  }
}

async function edit($: any, id: string) {
  const reply = (await read($, drafts))[id]?.reply ?? ''
  await $.prompt.fill({ text: `Post this reply on ${id} after my edits:\n\n${reply}`, mode: 'replace' })
}

async function askDraft($: any, id: string) {
  void $.prompt.submit({ text: `Read ${id} and its newest comments through Linear, then call the ` +
    `${DRAFT_TOOL} tool with a short summary and a suggested reply. Post nothing to Linear.` })
}

async function review($: any) {
  await $.ui.open({ id: PANE, title: 'MAREXEC' })
  await update($, tab, () => 'mine')
  const first = (await read($, news))[0]
  if (first) await toggle($, first.id)
  else await markRead($)
}

async function setTab($: any, t: string) {
  await update($, tab, () => t)
  await update($, showAll, () => false)
}

async function startWork($: any) {
  await $.ui.open({ id: PANE, title: 'MAREXEC' })
  await update($, tab, () => 'work')
  await update($, plan, p => ({ ...p, at: -1 }))
  // A plain prompt, not a slash command: a mod's submit of a slash command never reached the session.
  void $.prompt.submit({ text: `Use the marexec-ping:start-work skill to pick the next MAREXEC tasks. side: ${side}, team: ${o.team}` })
}

// Once you act on an issue's card (post, skip, done, move) or it clears as answered elsewhere,
// it has no place on the Start work list any more.
async function dropPlan($: any, ids: string[]) {
  await update($, plan, p => ({ ...p, items: p.items.filter(x => !ids.includes(x.issue)) }))
}

async function setItem($: any, issue: string, state: PlanItem['state'], note = '') {
  await update($, plan, p => ({ ...p, items: p.items.map(x => (x.issue === issue ? { ...x, state, note: note || x.note } : x)) }))
}

function doPrompt(items: PlanItem[]) {
  return [`Do ${items.length === 1 ? 'this item' : 'these items, in order,'} from the MAREXEC Start work list ` +
    `(side: ${side}, team: ${o.team}). Follow the "When a Do it prompt arrives" part of ` +
    'the marexec-ping:start-work skill: reads and drafts only, nothing posted or changed.',
    ...items.map(x => `- ${x.issue} ${x.title}: ${x.why}`)].join('\n')
}

async function doIt($: any, issue: string) {
  const x = (await read($, plan)).items.find(i => i.issue === issue)
  if (!x) return
  await setItem($, issue, 'doing')
  void $.prompt.submit({ text: doPrompt([x]) })
}

// A "needs you" item is usually a team effort: bring it into this session's chat.
async function together($: any, issue: string) {
  const x = (await read($, plan)).items.find(i => i.issue === issue)
  if (!x) return
  await setItem($, issue, 'doing')
  void $.prompt.submit({ text: `Let's work on ${x.issue} (${x.title}) together, from the MAREXEC Start work list ` +
    `(side: ${side}, team: ${o.team}). What needs me: ${x.why}\n\n` +
    'Read the issue and its newest comments through Linear. Do the parts you can (reading, checking, ' +
    'drafting), then walk me through my part one step at a time. Post nothing to Linear and change no ' +
    'server without my yes; any box change gets its what, check and undo posted first.' })
}

async function doAll($: any) {
  const todo = (await read($, plan)).items.filter(x => x.who === 'claude' && x.state === 'todo')
  if (!todo.length) return
  for (const x of todo) await setItem($, x.issue, 'doing')
  void $.prompt.submit({ text: doPrompt(todo) })
}

function Work($: any, e: any, p: Plan, nowMs: number) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const live = p.items.filter(x => x.state !== 'skipped')
  const yours = live.filter(x => (x.who === 'you' && x.state !== 'done') || x.state === 'needs_you')
  const ours = live.filter(x => x.who === 'claude' && x.state !== 'needs_you')
  const todo = ours.filter(x => x.state === 'todo').length
  const card = (x: PlanItem, color: string) => (
    <Box key={`w-${x.issue}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX="sm"
      hover={{ backgroundColor: HOVER_BG }}>
      <Box flexDirection="row" gap="xs">
        <Text mono size="footnote">{x.rank} · {x.issue}</Text>
        <Text wrap="truncate-end">{x.title}</Text>
      </Box>
      <Text color={color} size="footnote">
        {x.state === 'doing' ? 'Working on it… ' : x.state === 'done' ? 'Done: ' : ''}{x.note || x.why}
      </Text>
      <Box flexDirection="row" gap="xs" flexWrap="wrap">
        {x.who === 'claude' && x.state === 'todo' && <Button key={`do-${x.issue}`} variant="primary" label="Do it" onPress={() => doIt($, x.issue)} />}
        {x.who === 'claude' && x.state === 'todo' && <Button key={`no-${x.issue}`} label="Not now" onPress={() => setItem($, x.issue, 'skipped')} />}
        {color === 'warning' && x.state !== 'doing' && <Button key={`tog-${x.issue}`} variant="primary" label="Work on it together" onPress={() => together($, x.issue)} />}
        {color === 'warning' && <Button key={`did-${x.issue}`} label="Done it" onPress={() => dropPlan($, [x.issue])} />}
        <Link href={`${LINEAR_URL}${x.issue}`} label="Open in Linear" />
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" gap="sm">
      {p.at === -1 && <Text color="suggestion">Picking the next tasks…</Text>}
      {p.at === 0 && <Text dimColor>Press Start work to pick the next tasks.</Text>}
      {yours.length > 0 && <Text dimColor size="footnote">Needs you ({yours.length})</Text>}
      {yours.map(x => card(x, 'warning'))}
      {ours.length > 0 && <Text dimColor size="footnote">Claude can do now ({ours.length})</Text>}
      {ours.map(x => card(x, 'suggestion'))}
      {p.at > 0 && (
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text dimColor size="footnote">Picked {ago(nowMs - p.at)}{nowMs - p.at < 60_000 ? '' : ' ago'}</Text>
          {todo > 0 && <Button key="do-all" plain onPress={() => doAll($)}><Text color="suggestion">Do all Claude items</Text></Button>}
        </Box>
      )}
    </Box>
  )
}

function Row($: any, e: any, i: { id: string; title: string }, note: string, isNew: boolean, isOpen: boolean,
  d: Draft | undefined, done: Handled | undefined, busyText: string, nowMs: number) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const color = done ? 'success' : isNew ? 'suggestion' : undefined
  return (
    <Box key={i.id} flexDirection="column" borderStyle={isNew || done || isOpen ? 'round' : undefined}
      borderColor={color} paddingX={isNew || done || isOpen ? 'sm' : 0} paddingY={isOpen ? 'sm' : 0}
      backgroundColor={isOpen ? OPEN_BG : undefined}>
      <Box hover={{ backgroundColor: HOVER_BG }}>
      <Button key={`row-${i.id}`} plain onPress={() => toggle($, i.id)}>
        <Text color={color}>{done ? '✓ ' : isNew ? '● ' : ''}</Text>
        <Text mono size="footnote">{i.id} </Text>
        <Text wrap="truncate-end">{i.title}</Text>
        <Text dimColor>{isOpen ? ' ▴' : ' ▾'}</Text>
      </Button>
      </Box>
      {isOpen && (
        <Box flexDirection="column" gap="xs">
          {note && <Text dimColor size="footnote">{note}</Text>}
          {done ? (
            <Box flexDirection="column" gap="xs">
              <Text color="success">{done.note ? `${done.note}, ${ago(nowMs - done.at)}${nowMs - done.at < 60_000 ? '' : ' ago'}` : `Posted: ${done.text}`}</Text>
              <Box flexDirection="row" gap="xs" flexWrap="wrap">
                {!done.isMoved && <Button key={`move-${i.id}`} label={`Move to ${short(other())}'s turn`} onPress={() => move($, i.id)} />}
                <Link href={`${LINEAR_URL}${i.id}`} label="Open in Linear" />
              </Box>
            </Box>
          ) : d ? (
            <Box flexDirection="column" gap="xs">
              <Text size="footnote">{d.summary}</Text>
              {d.reply
                ? <Box borderStyle="round" borderColor="suggestion" paddingX="sm"><Text color="suggestion">{d.reply}</Text></Box>
                : <Text dimColor>No reply needed.</Text>}
              {d.reply && d.close === true && <Text dimColor size="footnote">Finished: posting this note also closes the issue.</Text>}
              {d.reply && d.close !== true && d.handBack === false && <Text dimColor size="footnote">Stays your turn after posting.</Text>}
              <Box flexDirection="row" gap="xs" flexWrap="wrap">
                {d.reply && <Button key={`ok-${i.id}`} variant="primary"
                  label={d.close === true ? 'Post and close' : d.handBack === false ? 'Approve and post' : `Post and hand to ${short(other())}`}
                  onPress={() => approve($, i.id)} />}
                {d.reply && <Button key={`edit-${i.id}`} label="Edit" onPress={() => edit($, i.id)} />}
                <Button key={`skip-${i.id}`} label={d.reply ? 'Skip' : 'Done'} onPress={() => forget($, i.id)} />
                <Link href={`${LINEAR_URL}${i.id}`} label="Open in Linear" />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="row" gap="xs" flexWrap="wrap">
              {isNew
                ? <Text dimColor>Drafting…</Text>
                : <Button key={`ask-${i.id}`} label="Draft a reply" onPress={() => askDraft($, i.id)} />}
              <Link href={`${LINEAR_URL}${i.id}`} label="Open in Linear" />
            </Box>
          )}
          {busyText && <Text dimColor>{busyText}</Text>}
        </Box>
      )}
    </Box>
  )
}

async function Pane($: any, e: any) {
  if (!side) return SidePicker($, e)
  const { Box, Text, Button } = $.ui.resolve(e)
  const [all, nw, dr, hd, open, t, more, busyText] = await Promise.all([
    read($, issues), read($, news), read($, drafts), read($, handled),
    read($, expanded), read($, tab), read($, showAll), read($, working)])
  const t0 = await read($, now)
  const pl = await read($, plan)
  const mineStatus = `Waiting on ${side}`
  const theirStatus = `Waiting on ${other()}`
  const byId = new Map(all.map(i => [i.id, i]))
  const newIds = [...new Set(nw.map(n => n.id))]
  const note = (id: string) => nw.filter(n => n.id === id).map(n => n.text.replace(/^\S+ /, '')).join('; ')
  const unread = (id: string) => nw.some(n => n.id === id && !n.isRead)
  const handledIds = Object.keys(hd).filter(id => !newIds.includes(id))
  const rest = (pred: (i: Issue) => boolean) =>
    all.filter(i => pred(i) && !newIds.includes(i.id) && !handledIds.includes(i.id))
  const list = t === 'mine' ? rest(i => i.status === mineStatus)
    : t === 'theirs' ? rest(i => i.status === theirStatus)
    : [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const shown = more ? list : list.slice(0, ROWS)
  const row = (id: string, isNew: boolean) => {
    const i = byId.get(id) ?? { id, title: '' }
    return Row($, e, i, note(id), isNew && unread(id), open === id, dr[id], hd[id], open === id ? busyText : '', t0)
  }
  const tabBtn = (key: string, label: string, n: number) => (
    <Button key={`tab-${key}`} plain onPress={() => setTab($, key)}>
      <Text color={t === key ? 'suggestion' : undefined} bold={t === key} dimColor={t !== key}>{label} {n}</Text>
    </Button>
  )
  return (
    <Box flexDirection="column" gap="sm" padding="sm">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>MAREXEC</Text>
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text dimColor size="footnote">{side}</Text>
          <Button key="start-work" label="Start work" onPress={() => startWork($)} />
        </Box>
      </Box>
      <Box flexDirection="row" gap="md">
        {tabBtn('mine', 'Your turn', all.filter(i => i.status === mineStatus).length)}
        {tabBtn('theirs', `${short(other())}'s turn`, all.filter(i => i.status === theirStatus).length)}
        {tabBtn('all', 'All', all.length)}
        {tabBtn('work', 'Start work', pl.items.filter(x => x.state !== 'skipped' && x.state !== 'done').length)}
      </Box>
      {t === 'work' && Work($, e, pl, t0)}
      {t === 'mine' && newIds.length > 0 && <Text dimColor size="footnote">New since you read ({newIds.length})</Text>}
      {t === 'mine' && newIds.map(id => row(id, true))}
      {t === 'mine' && handledIds.length > 0 && <Text dimColor size="footnote">Just handled ({handledIds.length})</Text>}
      {t === 'mine' && handledIds.map(id => row(id, false))}
      {t !== 'work' && <Text dimColor size="footnote">
        {t === 'mine' ? mineStatus : t === 'theirs' ? theirStatus : 'All open'} ({list.length})
      </Text>}
      {t !== 'work' && shown.map(i => row(i.id, false))}
      {t !== 'work' && list.length > ROWS && (
        <Button key="more" plain onPress={() => update($, showAll, v => !v)}>
          <Text dimColor>{more ? 'Show fewer' : `Show ${list.length - ROWS} more`}</Text>
        </Button>
      )}
      {all.length === 0 && <Text dimColor>Waiting for the first check…</Text>}
      <Box flexDirection="row" justifyContent="space-between">
        <Button key="read-all" plain onPress={() => markRead($)}><Text dimColor>Mark all read</Text></Button>
        <Text dimColor size="footnote">Watching: on</Text>
      </Box>
    </Box>
  )
}

async function Band($: any, e: any) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const [nw, lr, nc, n] = await Promise.all([read($, news), read($, lastReadAt), read($, nextCheckAt), read($, now)])
  const unread = new Set(nw.filter(x => !x.isRead).map(x => x.id)).size
  const left = nc - n
  const countdown = nc === 0 ? 'Checking…'
    : left >= 60_000 ? `Next check in ${Math.ceil(left / 60_000)} min`
    : `Next check in ${Math.max(0, Math.ceil(left / 1000))}s`
  return (
    <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap"
      borderStyle="round" borderColor="suggestion" paddingX="sm">
      <Text color="suggestion" bold>{lr ? `${ago(n - lr)} since read` : 'Not read yet'}</Text>
      <Text color="suggestion">{unread ? `${unread} new` : 'nothing new'}</Text>
      <Box flexGrow={1} />
      <Button key="review" label={unread ? 'Review one by one' : 'Open MAREXEC'} onPress={() => review($)} />
      <Text color="suggestion">{countdown}</Text>
      <Button key="check" label="Check now" onPress={() => check($)} />
    </Box>
  )
}

async function savePlan($: any, e: any) {
  const raw: any[] = Array.isArray(e.items) ? e.items : []
  const items: PlanItem[] = raw.slice(0, 6).map((x, n) => ({
    issue: String(x.issue ?? ''), title: String(x.title ?? ''), who: x.who === 'you' ? 'you' as const : 'claude' as const,
    why: String(x.why ?? ''), state: 'todo' as const, note: '', rank: n + 1,
  })).filter(x => /^[A-Z]+-\d+$/.test(x.issue))
  const at = await $.clock.now()
  await update($, plan, () => ({ at, items }))
  return { result: `Start work list (${items.length}) is in the MAREXEC pane. Do not start the claude items: the person presses Do it.` }
}

async function savePlanStatus($: any, e: any) {
  const state = ['doing', 'done', 'needs_you'].includes(e.state) ? e.state : 'doing'
  await setItem($, String(e.issue ?? ''), state, String(e.note ?? ''))
  return { result: `${e.issue} marked ${state} in the MAREXEC pane.` }
}

async function saveDraft($: any, e: any) {
  const id = String(e.issue ?? '').trim()
  if (!/^[A-Z]+-\d+$/.test(id)) return { result: 'Give the issue id, like MAREXEC-7.' }
  await update($, drafts, d => ({ ...d, [id]: { summary: String(e.summary ?? ''), reply: String(e.reply ?? ''), handBack: e.hand_back !== false, close: e.close === true } }))
  const at = await $.clock.now()
  const status = (await read($, issues)).find(i => i.id === id)?.status ?? ''
  await update($, news, list => (list.some(n => n.id === id) ? list : [...list, { id, text: `${id} draft ready`, isRead: false, at, status }]))
  return { result: `Draft for ${id} is in the MAREXEC pane. Joe approves it there; do not post it yourself.` }
}

export const register: Register = (on, options) => {
  o = options as Options

  on('session.start', async ($, e, next) => {
    const saved = String((await $.store.get('side')) ?? '')
    side = SIDES.includes(saved) ? saved : ''
    // A saved choice wins, even an empty one (/marexec-connector none); else the setting.
    const savedConnector = await $.store.get('connector')
    connector = String(savedConnector ?? o.connector ?? '')
    await $.command.register({ name: 'marexec-login', description: 'Sign in to Linear for the MAREXEC board (opens your browser)' })
    await $.command.register({ name: 'marexec-connector', description: "Aperture mode only: set Aperture's Linear connection, e.g. Linearjoe, or none" })
    await $.command.register({ name: 'marexec-side', description: "Set this machine's MAREXEC side: joe or marco" })
    await $.command.register({ name: 'marexec-watch', description: 'Turn MAREXEC wake-ups on or off for this session' })
    await $.command.register({ name: 'marexec', description: 'Open the MAREXEC pane' })
    await $.tool.register({
      name: 'marexec_draft',
      description: 'Put a summary and a suggested reply for one MAREXEC issue into the MAREXEC pane, where ' +
        'Joe approves or edits it. Never posts to Linear. Use an empty reply when none is needed.',
      inputSchema: { type: 'object', properties: {
        issue: { type: 'string', description: 'Issue id, like MAREXEC-7' },
        summary: { type: 'string', description: 'One or two plain sentences: what the other side said or asked' },
        reply: { type: 'string', description: 'Suggested reply text, or empty' },
        hand_back: { type: 'boolean', description: 'true (default): after posting, the next move is the other ' +
          "side's, so posting also moves the issue to their Waiting status. false: your side still has work " +
          'after this reply (the reply promises something you or the agent will do next).' },
        close: { type: 'boolean', description: 'true: the issue is finished, so the reply is a short closing ' +
          'note and posting it also closes the issue (status Done) instead of handing it to the other side. ' +
          'Use it when the work is done and checked and the other side has already agreed or said it can ' +
          'close, or nothing is owed by either side. Never hand an issue back only so the other side can close it.' },
      }, required: ['issue', 'summary', 'reply'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'marexec_plan',
      description: 'Put the ranked Start work list into the MAREXEC pane: the next best issues, each marked ' +
        'who acts next (you = the person, claude = you can read or draft it now) and why. Best first. Never posts.',
      inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
        issue: { type: 'string', description: 'Issue id, like MAREXEC-7' },
        title: { type: 'string', description: 'Short title' },
        who: { type: 'string', enum: ['you', 'claude'] },
        why: { type: 'string', description: 'For you: exactly what the person must do. For claude: what you will produce.' },
      }, required: ['issue', 'title', 'who', 'why'] } } }, required: ['items'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'marexec_plan_status',
      description: 'Mark one Start work item in the MAREXEC pane as doing, done (with a one-line note of what ' +
        'you left in the pane) or needs_you (with what the person must do).',
      inputSchema: { type: 'object', properties: {
        issue: { type: 'string' }, state: { type: 'string', enum: ['doing', 'done', 'needs_you'] },
        note: { type: 'string' },
      }, required: ['issue', 'state'] },
      isDeferred: false,
    })
    if ((await $.state.get(WATCHING)).value) await start($)
    return next(e)
  })

  // The tool exists only once registered, so the build's tool list doesn't know its name.
  on('tool.call', { tool: DRAFT_TOOL } as any, ($: any, e: any) => saveDraft($, e))
  on('tool.call', { tool: PLAN_TOOL } as any, ($: any, e: any) => savePlan($, e))
  on('tool.call', { tool: PLAN_STATUS_TOOL } as any, ($: any, e: any) => savePlanStatus($, e))

  on('command.run', { command: 'marexec-login' }, async $ => {
    try {
      const r = await script($, ['--login'])
      const said = (r.stdout + r.stderr).trim().split('\n').pop() ?? ''
      if (r.exitCode !== 0) return { text: `MAREXEC sign-in did not finish. ${said}` }
      if ((await $.state.get(WATCHING)).value) await start($)
      return { text: said || 'MAREXEC: signed in to Linear.' }
    } catch (err: any) {
      return { text: `MAREXEC sign-in failed: ${err?.message ?? 'unknown error'}` }
    }
  })

  on('command.run', { command: 'marexec-connector' }, async ($, e: any) => {
    const arg = String(e.args ?? '').trim()
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(arg)) return { text: `MAREXEC connector is ${connector || 'none (Linear\'s own server)'}. Use /marexec-connector <name>, e.g. /marexec-connector Linearjoe, or /marexec-connector none.` }
    const name = arg.toLowerCase() === 'none' ? '' : arg
    await $.store.set('connector', name)
    connector = name
    if ((await $.state.get(WATCHING)).value) await start($)
    return { text: name ? `MAREXEC now reads the board through the ${name} connection. A check runs now.`
      : 'MAREXEC now calls the Linear tools by their plain names (Linear\'s own server).' }
  })

  on('command.run', { command: 'marexec-side' }, async ($, e: any) => {
    const a = String(e.args ?? '').toLowerCase()
    const s = a.includes('marco') ? "Marco's Team" : a.includes('joe') ? "Joe's Team" : ''
    if (!s) return { text: `MAREXEC side is ${side || 'not set'}. Use /marexec-side joe or /marexec-side marco.` }
    await setSide($, s)
    return { text: `MAREXEC: this machine is on ${s}. It reads "Waiting on ${s}" as your turn.` }
  })

  on('command.run', { command: 'marexec' }, async $ => {
    await $.ui.open({ id: PANE, title: 'MAREXEC' })
    await markRead($)
    return { text: 'MAREXEC pane opened.' }
  })

  on('command.run', { command: 'marexec-watch' }, async $ => {
    const isOn = !(await $.state.get(WATCHING)).value
    await $.state.set(WATCHING, isOn)
    if (!isOn) {
      stop()
      return { text: 'MAREXEC watch is off for this session.' }
    }
    await start($)
    void $.ui.open({ id: PANE, title: 'MAREXEC' })
    return { text: `MAREXEC watch is on for this session: checking ${o.team} every ${o.interval_minutes} min. Run /marexec-watch again to turn it off.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => Pane($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await $.state.get(WATCHING)).value) return next(e)
    return side ? Band($, e) : SidePicker($, e)
  })
}
