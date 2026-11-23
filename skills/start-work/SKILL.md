---
name: start-work
description: Picks the next best MAREXEC issues to work on and sorts them into "needs you" and "Claude can do now", shown in the MAREXEC pane's Start work tab. Runs when the pane's Start work button is pressed, or when the user asks what to work on next on MAREXEC. Reads and drafts only; never posts or changes anything.
---

# Start work

Pick the next best open issues on the shared Linear team, sort each by who has to act, and put the list in the MAREXEC pane. You plan here; the person starts each piece with the pane's buttons.

## Hard limits

Reads and drafts only. Never post a comment, never change a status, priority or assignee, and never change any server, file outside the drafts, or account. Every write to Linear or any server waits for the person's own click or their word in chat.

## Steps

1. Find whose turn it is. The Start work button passes your side and the team, like `side: Joe's Team, team: Marco - Exec`. Your side's status is `Waiting on <that side>`. If nothing was passed, ask.
2. Through whichever Linear tools this session has (Linear's own connector, or Aperture's `Linear_*` tools), list the team's open issues in your side's Waiting status, asking only for id, title, priority and updatedAt. Shortlist at most 8 from that list alone (step 3's rules), then read only those: the newest 3 comments each (`limit: 3`), and the description only when the comments don't make sense alone. Don't read the rest of the column.
3. Rank them, best first. Rank higher when an issue is:
   - urgent, or labeled or titled with a due date that is close or past
   - blocking other issues
   - waiting on your side the longest
   - a quick win (under 15 minutes)
4. Keep the top 6 at most. For each, decide who acts next:
   - `you` when it needs something only the person can give: a password, login, payment, or account click; a decision or price; their go on a box change; or a word with the other side on a call. Say exactly what, in plain words ("Needs your Decodo password change").
   - `claude` when the next step is reading, checking, researching, or drafting: a reply, a box-change plan (what, check, undo), a file list, a diagnosis. Say what you'll produce ("Will draft the file list, check and undo").
   An issue whose next step is a box change is `claude` when the plan still needs writing, and `you` once the plan is posted and only the go is left.
   An issue that is already finished (the work is done and checked, and the other side agreed or said it can close, or nothing is owed) is `claude`: "Will draft a closing note". Finished issues are quick wins; list them first among the `claude` items.
5. Call `mcp__marexec-ping__marexec_plan` once with the list, in rank order.
6. In chat, give the same list in 2 to 6 short lines, then stop. Do not start the `claude` items: the person presses "Do it" or "Do all Claude items" in the pane.

## When a "Do it" prompt arrives

Do that one item, reads and drafts only. First call `mcp__marexec-ping__marexec_plan_status` with `doing`. Put any reply or plan you draft on the issue's card with `mcp__marexec-ping__marexec_draft`. Set `hand_back` to false when the reply promises more work from your side (the next move stays yours); leave it true when the next move is the other side's, so posting also hands the issue back. Set `close` to true when the issue is finished: the reply is then a short closing note (what was checked, "reopen if you see anything different") and posting it closes the issue. Never hand an issue back only so the other side can close it, and never draft a reply that only acknowledges; use an empty reply when nothing needs saying. Then call `marexec_plan_status` with `done`, plus a one-line note on what you left in the pane. If you hit something only the person can do, call it with `needs_you` and say what.
