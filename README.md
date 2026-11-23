# marexec-ping

Wakes a Claude Code session when the other side posts on the shared Linear team.

When the watch is on, the mod checks the shared Linear team (default: Marco - Exec) every 10 minutes, signed in to Linear as you. It pings when either of these happens:
- someone other than you comments on an issue, or
- an issue moves into your "waiting on us" status.

Each ping sends a desktop notification and wakes the session with a prompt: read the issue, summarize what the other side said, and suggest a reply. It never posts to Linear by itself.

## Needs
- Claude Code (desktop app or terminal), with a session kept open.
- Python 3 on that machine (standard library only, nothing to install).
- A Linear login that can see the shared team (a guest on it is enough).

## Install (Marco)
1. Install the plugin: `/plugin install marexec-ping --marketplace <owner>/<repo>`. The install settings can all keep their defaults.
2. Run `/marexec-login`. Linear opens in your browser: click **Authorize**. The chat then says "Signed in to Linear as ...". You do this once; the mod renews the sign-in by itself.
3. Run `/marexec`. The pane asks **which side is this machine on?** Pick **Marco's Team**. The choice is kept across sessions (change it later with `/marexec-side joe` or `/marexec-side marco`).
4. Run `/marexec-watch` in the session that should be woken.

If the band ever says "Linear sign-in needed", run `/marexec-login` again.

The sign-in is kept in `~/.marexec-ping/auth.json`: encrypted so only your Windows login on that computer can read it, or on Mac/Linux a file only you can read. No Linear key is ever typed or pasted anywhere. Sign-in uses Linear's own self-registration, so nobody has to set up an app first. (Only if a server ever stops allowing that: Joe registers an OAuth app and you run the script with `--login --client-id <id> --port <port>`.)

## Aperture mode (Joe's side)
To keep reading the board through Aperture instead, set the install setting **Linear MCP address** to Aperture's address (`http://aperture/v1/mcp`) and name its Linear connection: `/marexec-connector Linear` (or `Linearjoe` on a machine with two Linear workspaces; `/marexec-connector none` goes back to plain names). No sign-in is needed: Aperture trusts the machine, and no token is ever sent over plain http. The choice is kept on that machine. A check that finds no open issues on the board counts as a failure (see `errors.log`), never as "nothing new", so a wrong connection can't look quiet.

## Use
In the session that should be woken, run `/marexec-watch`. Run it again to turn it off. The watch stays on in that session through reloads. Turn it on in one session only.

The first check only records what is already there and pings nothing. After that you only hear about new changes.

`/marexec` opens the MAREXEC pane. It has four tabs: Your turn, the other side's turn, All, and Start work. New items show with a blue dot. Click a row to open it. When the session wakes, Claude puts its summary and a suggested reply on that issue's card.
- **Post and hand to ...** posts the card's exact text to Linear as you, then moves the issue to the other side's Waiting status. Nothing else ever posts.
- **Approve and post** shows instead when the reply promises more work from your side. It posts and leaves the issue in your turn.
- **Post and close** shows instead when the issue is finished: the work is done and checked, and the other side already agreed or nothing is owed. It posts the closing note and moves the issue to Done. An issue is never handed over only so the other side can close it.
- **Edit** puts the draft in your prompt box so you can change it first.
- **Skip / Done** clears the card without posting.
- **Move to ...'s turn** moves an answered issue to the other side's Waiting status.
- **Draft a reply** on an older issue asks Claude to read it and draft one.

Cards clear on their own once their work is done somewhere else: when your side comments on the issue (from any session or agent), or when the issue leaves your Waiting status. They move to "Just handled", which clears when you read everything (Mark all read or `/marexec`) and on its own after 24 hours.

**Start work** (the button at the top of the pane) runs the `start-work` skill. It ranks the next best issues in your Waiting status, at most 6, and splits them into:
- **Needs you:** a password, a click, a decision, or your go on a server change. **Work on it together** brings the item into the chat, where Claude does its part and walks you through yours. **Done it** clears it.
- **Claude can do now:** reads, checks and drafts. **Do it** or **Do all Claude items** starts them. Claude only reads and drafts. Each draft lands on the issue's card for your approval.

Items leave the list once you act on that issue, and when the issue is closed from anywhere (the chat, Linear, the other side): at the next check its Start work item and draft go on their own. A card that was waiting on you shows once more under "Just handled" as "Now closed", then clears like any other handled card (when you read everything, or after 24 hours).

A band above the prompt box shows how long it has been since you last read, how many items are new, and a countdown to the next check, with a Check now button.

## Where things live
- What it has already seen: `~/.marexec-ping/state.json`
- Failed checks: `~/.marexec-ping/errors.log`. A failed check never counts as "nothing new", and the next check picks up from the same point.
- The Linear sign-in: `~/.marexec-ping/auth.json` (see Install).
- Remove: uninstall the mod, then delete `~/.marexec-ping/`. To also cut the access off, remove the app under Linear's Settings, Security & access, Authorized applications.

## Keeping it cheap (0.2.3)
- A comment on an issue that is already closed shows under "Just handled" with a toast. It does not wake the session, so nothing is drafted for it.
- A wake-up reads only the newest 3 comments of each changed issue, drafts nothing for a thanks or an FYI, and reports one line per issue in the chat.
- Start work reads only its shortlist (at most 8 issues), not the whole column.
- Posting text that is already on the issue (a double click, a second session) is skipped.

## Limits
- If the other side comments on a closed issue without reopening it, you get a toast and a "Just handled" row, not a drafted reply. Reopening the issue pings as usual.
- A ping can arrive up to 10 minutes after the change.
- Nothing happens while no session has the watch on.
- An issue you move into your own "waiting on us" status also pings you. The one exception: an issue created by this machine's Linear login since the last check, already in that status when the mod first sees it, does not ping. An issue you create in the other side's status that they move back without a comment inside the same check interval is the one hand-back this can miss.
- Each wake-up uses a little Claude usage.
