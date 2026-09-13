# 🔥 Firefighter

**Production breaks. Firefighter finds which change did it — by proving it, not guessing — and
opens the revert while you're still reading the alert.**

---

## Demo

https://github.com/itachi0071998/firefighter/tree/main/docs — a 90-second screen recording of a
real run: the Sentry alert arrives, the dashboard fills in live, bisection proves the culprit, and
the revert PR, Jira ticket and Slack update appear. No narration needed; the timeline is the story.

---

## The problem

It's 3am. Checkout is throwing 500s. Twelve things shipped today and one of them did this.

The usual move is to squint at the stack trace, guess the most suspicious-looking deploy, and
revert it. That guess is wrong often enough to matter — and reverting an innocent change during an
incident costs you the one thing you don't have, which is time.

## What Firefighter does

It takes the incident and **bisects your git history to prove which commit introduced the fault.**

Not "this PR touched that file, so probably." Actually proving it:

```
replay the failing production request at the SUSPECT commit   →  must reproduce
replay the same request at that commit's PARENT               →  must NOT reproduce
```

If the failure is **absent before the change and present after it**, that change caused it. That's
a causal result. If the test doesn't hold, the candidate is innocent and Firefighter moves to the
next one — so bisection doesn't just grade the guess, it *overturns* it.

Then it does the boring, urgent part for you:

- 🎫 files the incident ticket
- 🚨 cuts a branch, runs `git revert`, **runs your test suite on the revert branch**, opens a revert PR
- 💬 posts a Slack update that leads with *"Cause (proven)"* instead of a confidence score
- 🛑 **stops there** — it never merges and never deploys. Every production change ends at a pull
  request a human approves.

### Why this isn't just a prompt

An LLM can read a stack trace and offer an opinion. It cannot *run your program at forty different
commits*. Bisection needs real execution — worktrees, a real repo, a real reproduction — and that's
the part that turns a plausible story into evidence.

## Does it work?

Here's the case built specifically to break it: **six merged PRs, every one touching the same file
as the stack trace.**

```
correlation ranked:
   58%  PR #211   ← wrong. it edited that file too, and scored highest
   33%  PR #222   ← the actual culprit, ranked SECOND
   10%  PR #225 / #224 / #223 / #221 / #220   ← all tied, indistinguishable

execution:
   ▶ PR #211   doesn't even reproduce here          →  ruled out
   ▶ PR #222   parent clean, change fails           →  ✓ PROVEN

CULPRIT PROVEN: PR #222   ·   2 candidates probed in 537ms
⚠ correlation ranked PR #211 first — execution disproved it.
```

**The scoring heuristic would have reverted the wrong PR.** That's the whole argument.

## The flow, end to end

```
   ┌─────────────┐
   │   SENTRY    │  production throws. an alert fires.
   │   (alert)   │  TypeError: Cannot read properties of null (reading 'tier')
   └──────┬──────┘
          │  error · stack trace · the request that triggered it
          ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  1. INGEST + COLLECT                                        │
   │     read the incident, then the last 30 commits, the merged │
   │     PRs and their diffs, and the deploy timeline            │
   └──────┬──────────────────────────────────────────────────────┘
          ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  2. RANK  (a hypothesis, not an answer)                     │
   │     score each change on stack-trace overlap, deploy timing │
   │     and symbol match                                        │
   │        58%  PR #211   ← ranked first, and WRONG             │
   │        33%  PR #222                                         │
   └──────┬──────────────────────────────────────────────────────┘
          ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  3. BISECT  ★ the part that makes this real                 │
   │     replay the production request at each candidate and at  │
   │     its parent, in throwaway git worktrees:                 │
   │                                                             │
   │        PR #211  doesn't reproduce here      → ruled out     │
   │        PR #222  parent clean, change FAILS  → ✓ PROVEN      │
   │                                                             │
   │     absent before, present after ⇒ this commit caused it    │
   └──────┬──────────────────────────────────────────────────────┘
          ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  4. MITIGATE                                                │
   │     file the ticket · cut a branch · git revert the proven   │
   │     commit · run the test suite ON the revert branch         │
   └──────┬──────────────────────────────────────────────────────┘
          ▼
   ┌──────────────┬──────────────┬──────────────┬───────────────┐
   │    JIRA      │   GITHUB     │    SLACK     │   DASHBOARD   │
   │  incident    │  revert PR   │  "Cause      │  live step    │
   │  ticket      │  (+ draft    │   (proven)"  │  timeline +   │
   │  created     │   fix PR in  │   posted     │  the proof    │
   │              │   full mode) │              │               │
   └──────────────┴──────┬───────┴──────────────┴───────────────┘
                         ▼
                  🛑 STOPS HERE
          a human reviews and merges. Firefighter
          never merges and never deploys.
```

Every step above is persisted, so a crash resumes instead of restarting, and every external write
goes through an idempotency ledger — re-run it as many times as you like and you still get exactly
one ticket, one revert PR and one Slack message.

---

## It plugs into what you already run

Sentry is the incident source wired up in this prototype, but nothing is welded to it. Every
integration sits behind a small interface with a real implementation and a mock, so swapping one is
a config change, not a rewrite:

| Role | Wired today | Same interface fits |
|---|---|---|
| **Incident source** | Sentry | Datadog, PagerDuty, Rollbar, New Relic, Bugsnag, or your own webhook |
| **Code host** | GitHub (`gh` CLI or REST) | GitLab, Bitbucket — anything with branches and PRs |
| **Ticketing** | Jira, Linear | any tracker with a create-issue API |
| **Chat** | Slack (bot or webhook) | Teams, Discord, PagerDuty notes |
| **Reasoning** | deterministic analyzer (no key needed) | OpenAI or Anthropic, optional |

An incident source has to supply three things: an error, a stack trace, and ideally the request
that triggered it. Give it those and bisection works the same whatever raised the alert.

Run it with an empty `.env` and every integration falls back to a working mock, so the whole thing
is demoable offline.

---

## How a run actually goes

14 durable steps. Each one is persisted, so a crash resumes instead of restarting:

```
ingest_incident → collect_context → identify_suspect_change → verify_culprit   ← rank, then PROVE
→ create_incident_ticket
→ prepare_revert → verify_revert → create_revert_pr      ← mitigation (always)
→ reproduce_bug → generate_fix → run_fix_tests → create_fix_pr   ← remediation (FF_MODE=full)
→ notify_slack → complete
```

**Mitigate first, remediate second.** Reverting a proven-bad commit is mechanical and safe, so it's
the default. Writing a *fix* means guessing intent, so that's opt-in (`FF_MODE=full`) and ships as a
**draft** PR with a regression test — the test being the part you can actually verify.

---

## Proof, not correlation

The analyzer scores every candidate change against the stack trace, the deploy timeline and the
symbols in the failing frame, and returns a ranked list. That list is a **hypothesis**. Shipping a
revert on a hypothesis is how a bad night gets worse.

So Firefighter runs a two-sided test on the ranked candidate, using a capability it already has —
replaying the captured production request against an arbitrary checkout of the repository:

```
replay the production request at the SUSPECT commit    →  the failure MUST reproduce
replay the same request at that commit's PARENT        →  the failure MUST NOT reproduce
```

If both hold, the fault is **absent before the change and present after it**, so that change
introduced it. Nothing about that conclusion depends on how the candidate was ranked, how recently
it deployed, or how plausible its diff looked.

Before any of it runs, the incident must reproduce at `HEAD` — without a failing baseline every
probe below it would be meaningless — and each candidate that is probed gets a recorded verdict:

| Verdict | Meaning |
|---|---|
| `proven` | absent at the parent, present at the change — **this change introduced the fault** |
| `predates-this-change` | the fault already reproduces at the parent, so it is older than this change |
| `not-present-here` | the fault does not reproduce at this commit at all |
| `inconclusive` | the commit is missing from this repository, or is a root commit with no parent |

Every probe runs in a detached `git worktree`, so the working tree is never touched and probes
cannot interfere with one another. A commit is only ever replayed once, even when two candidates
share it.

### Verification also *corrects* the ranking

Probing is not a grade on the analyzer's homework — it is allowed to overturn it. If the top-ranked
candidate is disproved, the next one is probed, up to `DEFAULT_MAX_CANDIDATES` (4). When execution
proves a change the ranking did *not* put first, Firefighter re-points the investigation at the
proven change, raises its confidence to 100%, prepends a `causal` evidence item carrying the two
commits, and records `overrodeRanking: true`.

That flag is kept rather than discarded once the incident is closed, because it is a **supervision
signal**: every `overrodeRanking: true` is a labelled example of the correlation weights being wrong
on a real incident, which is exactly the data needed to tune them. Slack surfaces it in the moment
too — *"Correlation first ranked #N; execution disproved it."*

### When it cannot be proven

Verification is deliberately **not** a critical step. If the incident carries no replayable request,
or does not reproduce at `HEAD`, Firefighter records a `skippedReason`, falls back to the
correlation ranking, and *says so* — the revert PR body leads with **"⚠️ Not proven by execution …
treat it as a lead"**, and Slack reports the confidence as "correlation only — not proven by
execution". An unproven answer is still delivered; it is just never dressed up as a proven one.

---

## Run modes

`FF_MODE` decides how far Firefighter goes.

| `FF_MODE` | What it does | Why |
|---|---|---|
| `mitigate` *(default)* | Stops after the revert PR | The culprit is **proven** and the revert is mechanical: `git revert` of a known commit, with the test suite run against the result before the PR is opened |
| `full` | Also synthesises a fix plus a regression test, opened as a **draft** PR | A synthesised patch encodes a **guess about intent**. It is a proposal, not a mitigation |

The two tracks are not shipped as equals, and that asymmetry is the point. The revert is backed by
execution on both sides of a commit; the fix is backed by an inference about what the author meant
to write. Presenting them with the same confidence would be dishonest, so remediation is opt-in, its
pull request is opened as a **draft**, and the body says plainly that the patch is a starting point
for a human.

The **regression test is the verifiable half of the fix track**: it fails on the unfixed code and
passes on the patch, and no fix PR is opened unless it and the existing suite both pass. Even if you
throw the generated patch away, the test is worth keeping.

```bash
npm run demo                       # mitigate-only: investigation, proof, ticket, revert PR, Slack
FF_MODE=full npm run demo          # also drafts the fix + regression test PR
```

The eval harness pins `FF_MODE=full` so both tracks stay covered on every run.

---

## The other part that matters: it is safe to re-run

Every external mutation passes through an idempotency ledger keyed on the incident. Kill the
process immediately after the Linear ticket is created, restart it, and you get **one** ticket,
**one** revert PR, **one** fix PR, **one** Slack message — never two. This is verified by the
eval suite: `crash-and-resume` runs each phase as a real child process and kills that process
(`exit 137`) in the narrow window *after* the ticket has been created but *before* the step is
marked succeeded — precisely where a naive agent duplicates the write on restart.

---

## Quick start

```bash
npm install
npm run demo              # seeds the demo repo, runs the incident end-to-end (mitigate-only)
FF_MODE=full npm run demo # same, plus the draft fix + regression-test PR
npm run evals             # deterministic evaluation suite + metrics
npm test                  # unit tests for the reliability and safety primitives
npm start                 # dashboard at http://localhost:8787
```

No credentials are required. Every integration ships with a mock adapter and the system runs
fully end-to-end out of the box.

---

## Verified results

Everything below is measured, not aspirational — reproduce it with the commands in the table further down.

```
npx tsc --noEmit   0 errors
npm test           47/47 pass
npm run evals      11/11 scenarios        (the suite pins FF_MODE=full, so both tracks run)

  task_success_rate                100.0%  (11/11)
  correct_suspect_identification   100.0%  (11/11)
  duplicate_write_count            0
  unsafe_action_count              0
  guard_probe_passed               true

npm run evals -- happy-path    14/14 steps · 8 writes · 0 dupes · 0 retries
  culprit     PR #142 — PROVEN by bisection, not ranked and hoped:
              the failure does not reproduce at its parent and does at the change
              (#143 deployed later, is docs-only, and is ruled out)
  ticket      INC-1
  revert PR   opened only after the test suite passed on the revert branch
  fix PR      draft, with the generated regression test (FF_MODE=full only)
  slack       #incidents
  duplicates  0
```

Bisection is cheap enough to be unconditional: on the demo repository it proves the culprit in
**~300ms** end to end — the baseline replay at `HEAD` plus the two probes around the suspect commit,
each in its own throwaway worktree.

Re-running the completed workflow three times, and killing the process mid-flight and restarting
it, both leave exactly **one** ticket, **one** revert PR, **one** fix PR and **one** Slack message.

### Against real services

The numbers above come from the deterministic suite, which is fully mocked. The same workflow has
also been run end to end against **live Sentry, GitHub, Jira and Slack** — the hardest scenario
deliberately built to defeat correlation:

| | |
|---|---|
| Incident | Sentry issue — `TypeError: Cannot read properties of null (reading 'tier')` |
| Repository | **six** merged pull requests, **all touching the same file** as the stack trace |
| Correlation ranked | **PR #211** — wrong. It had edited that file too, and scored highest |
| Execution proved | **PR #222** — absent at `7df751d9`, present at `ff19dfbb` |
| Probed | 2 candidates in **537 ms** |
| Mitigation | revert PR opened on GitHub, 6/6 tests green on the revert branch |
| Ticket | Jira issue created, transitioned to *In Progress* |
| Notified | Slack, leading with *"Cause (proven)"* rather than a confidence score |

The five innocent same-file PRs all collapsed to an identical 10% score, and the real culprit sat
at 33% — *below* an innocent change at 58%. **Ranking alone would have reverted the wrong PR during
a SEV1.** That is the entire argument for verifying by execution rather than by plausibility.



---

## Architecture

```
src/
  types.ts            shared domain contracts (every module codes against these)
  config.ts           env config + graceful provider degradation
  cli.ts              seed / demo / run / status / reset / bridge
  db/
    schema.sql        incidents, runs, steps, mutations (ledger), tool_calls,
                      timeline, bridge_intents, safety_events
    repo.ts           durable state + withIdempotency() — the reliability core
  agent/
    analyzer.ts       deterministic weighted-evidence suspect scoring
    bisect.ts         causal verification: replays the failure at a suspect and at its parent
    entrypoint.ts     resolves which module/class/method to call, and how to shape its argument
    stacktrace.ts     V8 stack parsing + production path normalisation
    fixer.ts          null-guard synthesis + regression-test generation
    llm.ts            provider selection (deterministic | openai | anthropic)
  tools/
    index.ts          THE tool registry — guard + idempotency + audit on every call
    guard.ts          structurally forbids merge/deploy/force-push
    github.ts         GitHubClient: local-git mock | gh CLI | REST API
    slack.ts          SlackClient: mock | webhook | bot | bridge
    tickets.ts        TicketClient: mock Linear | Linear | Jira | bridge
    tests.ts          real test runner, static analysis, and bug reproduction
  workflow/
    engine.ts         durable step runner: resume, retries, crash recovery
    steps.ts          the fourteen steps and their PR/ticket/Slack copy
  evals/              deterministic scenario suite + metrics
  demo/               the seeded buggy demo repository and incident fixtures
app/                  zero-build dashboard (index.html + app.js)
demo-repo/            generated: a REAL git repo with a real regression
```

### Design decisions

**The LLM reasons; deterministic code acts.** The model never gets shell access and never performs
a side effect. It sees a summarised evidence bundle and may *review* the ranked candidates; its
answer is discarded unless it names a real candidate with a valid confidence. Every side effect
happens in the explicit tool registry.

**The mock GitHub adapter is backed by real git.** `demo-repo/` is a genuine repository with real
commits, real merge history and real diffs. Reverts are produced by `git revert`, patches are real
commits, and tests run against real checked-out worktrees. Only the *API* is emulated — so the
investigation logic is exercised for real.

**Verification never touches the working tree.** Every test, lint and bisection probe happens in a
detached `git worktree`, so the demo repo stays clean and steps cannot fight over `HEAD`. That
isolation is what makes it safe to replay the same production request at several commits within one
incident response.

**Correlation proposes; execution decides.** The weighted-evidence analyzer exists to get the
verifier *close enough to start probing*, not to be right on its own. Its output is a ranked
hypothesis; only `verify_culprit` can promote a candidate to a proven culprit, and it is free to
promote one the ranking put second.

---

## Safety model

Firefighter **may**: read logs, inspect history and diffs, create tickets, create branches,
generate reverts, apply patches, open PRs, run tests, run static analysis, post to Slack.

Firefighter **may not**: merge a PR, deploy, force-push, delete or write to a protected branch,
rewrite published history, or run destructive infrastructure commands.

This is enforced three ways:

1. **Structurally** — `GitHubClient` has no merge or deploy method. The capability does not exist.
2. **At the choke point** — every mutating tool calls `assertSafeAction()` before doing anything.
3. **At the transport** — `assertSafeGitCommand()` and `assertSafeHttp()` inspect the actual argv
   and URL, so even a future code path cannot smuggle a merge through.

Every refusal is written to a `safety_events` audit table. The eval suite asserts
`unsafe_action_count === 0` in every scenario and probes the guard with known-forbidden actions.

---

## Environment variables

Everything is optional — the defaults are working mocks. See `.env.example`.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | dashboard/API port | `8787` |
| `FF_DB_PATH` | SQLite durable state | `./data/firefighter.db` |
| `FF_DEMO_REPO` | demo repository path | `./demo-repo` |
| `GITHUB_PROVIDER` | `mock` \| `gh-cli` \| `api` | `mock` |
| `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH` | real GitHub | — |
| `SLACK_PROVIDER` | `mock` \| `webhook` \| `bot` \| `bridge` | `mock` |
| `SLACK_WEBHOOK_URL`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL` | real Slack | — |
| `TICKET_PROVIDER` | `mock` \| `linear` \| `jira` \| `bridge` | `mock` |
| `LINEAR_API_KEY`, `LINEAR_TEAM_KEY` | real Linear | — |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | real Jira | — |
| `LLM_PROVIDER` | `deterministic` \| `openai` \| `anthropic` | `deterministic` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | LLM enrichment | — |
| `FF_MODE` | `mitigate` (revert PR only) \| `full` (also draft a fix PR) | `mitigate` |
| `FF_MAX_ATTEMPTS`, `FF_RETRY_BASE_MS` | retry policy | `3`, `150` |
| `FF_FAIL_INJECT` | fault injection, e.g. `notify_slack:transient:2` | — |

If a provider is selected but its credentials are missing, Firefighter logs a warning and falls
back to the mock rather than failing.

---

## Connecting real credentials

### GitHub
Authenticate the CLI, then create and push a demo repository in one step:
```bash
gh auth login
npm run github:setup -- your-org/firefighter-demo    # creates the repo, pushes the seeded history
# then in .env:
GITHUB_PROVIDER=gh-cli
GITHUB_REPO=your-org/firefighter-demo
```
`github:setup` performs **no merges and no deployments** — it only creates a repository and pushes
the already-linear seeded history. Firefighter then recovers the change set from the commit
subjects (`... (#142)`), which is GitHub's own squash-merge convention, so no pull request has to be
merged for the investigation to work. Missing PR labels are created automatically on first use.

Two behaviours are specific to a real remote:
- Pull requests Firefighter itself opened (`firefighter/*` branches) and any unmerged PR are
  excluded from the candidate set — the agent must never investigate its own output.
- If the repository has no GitHub Deployments, deploy time is approximated from commit time and
  reported as such, so the temporal signal still works.
Or use a **fine-grained PAT** scoped to a single repository with the minimum permissions:
**Contents: Read & Write** (branches and commits), **Pull requests: Read & Write** (open PRs),
**Metadata: Read**. No Actions, Workflows, Administration, or org-level access is needed.
```bash
GITHUB_PROVIDER=api GITHUB_TOKEN=github_pat_... GITHUB_REPO=your-org/your-repo
```

### Slack
Least privilege is an **Incoming Webhook** — no scopes, locked to one channel:
```bash
SLACK_PROVIDER=webhook SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```
Or a bot token with the single scope `chat:write` (add `chat:write.public` only to post to a
channel the bot has not joined):
```bash
SLACK_PROVIDER=bot SLACK_BOT_TOKEN=xoxb-... SLACK_CHANNEL=#incidents
```

### Linear
```bash
TICKET_PROVIDER=linear LINEAR_API_KEY=lin_api_... LINEAR_TEAM_KEY=ENG
```
Note: Linear personal API keys are **not scope-limited** — they inherit your full workspace access.

### Jira
```bash
TICKET_PROVIDER=jira JIRA_BASE_URL=https://your-org.atlassian.net \
JIRA_EMAIL=you@example.com JIRA_API_TOKEN=... JIRA_PROJECT_KEY=INC
```
OAuth equivalent scopes: `read:jira-work`, `write:jira-work`.

### Sentry (real incident source)
```bash
INCIDENT_SOURCE=sentry
SENTRY_AUTH_TOKEN=sntryu_...   # read-only scopes: project:read, event:read, org:read
SENTRY_ORG=your-org            # slugs from your Sentry URL
SENTRY_PROJECT=your-project
SENTRY_ISSUE_ID=               # optional: pin one issue for a reproducible demo
SENTRY_URL=https://sentry.io   # change only for self-hosted
```
`SENTRY_TOKEN` is accepted as an alias for `SENTRY_AUTH_TOKEN`. Sentry rate-limits issue endpoints
to ~5 requests/second, so the client retries on 429 honouring `Retry-After`; a pinned issue that has
since been retired falls back to the newest unresolved issue instead of failing.

**Matching the repo to the project.** The investigation correlates the Sentry stack trace against
the repository, so the two must describe the same service. `npm run seed -- --force --variant sentry`
builds a TypeScript demo service whose paths and line numbers match the frames Sentry reports; the
seeder asserts those anchors and fails loudly if an edit shifts them.
```bash
npm run sentry                          # list live unresolved issues
npm run run-incident -- <sentry-issue-id>
```
Firefighter pulls the issue plus its latest event, rebuilds a V8 stack trace from Sentry's
structured frames, and reuses the captured HTTP request as the reproduction case. Authorization,
cookie and API-key headers are stripped before anything reaches a pull request body.

### OpenAI
```bash
LLM_PROVIDER=openai OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o
```
The deterministic analyzer always runs first and remains the fallback, so an outage or a bad model
response degrades to the reproducible path instead of failing the incident response.

### Connector bridge (Slack/Jira delivered by an external agent)
Set `SLACK_PROVIDER=bridge` / `TICKET_PROVIDER=bridge`. Firefighter records the exact payload as a
durable intent instead of calling the API, and never blocks. An external process delivers it and
resolves the intent:
```bash
npx tsx src/cli.ts bridge                                  # list pending intents
npx tsx src/cli.ts bridge resolve slack:INC-1 1757754000.0017 https://...
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run demo` | Clean end-to-end demo run of the canonical incident (mitigate-only) |
| `FF_MODE=full npm run demo` | Same run, plus the draft fix + regression-test PR |
| `npm run bisect` | Just the causal verification, narrated: the ranking, then each probe and its verdict |
| `npm run bisect -- --sabotage` | Forces the *weakest* candidate to the top of the ranking, to show execution overruling it |
| `npm run seed -- --force` | Rebuild the demo repository from scratch |
| `npm run run-incident -- <fixture>` | Run one incident fixture |
| `npm run run-incident -- checkout-guest-null-country --stop-before create_revert_pr` | Partial run, to demo resume |
| `npm start` | Dashboard + API on `http://localhost:8787` |
| `npm run evals` | Full evaluation suite with metrics |
| `npm run evals -- happy-path` | One eval scenario |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript check |
| `npm run status` | Timeline + summary of the latest run |
| `npm run reset` | Wipe durable state |
| `npm run sentry` | List live incidents from the configured source |
| `npm run github:setup -- owner/name` | Create + push the demo repo to real GitHub |
| `npm run seed -- --force --variant sentry` | Build the TypeScript demo service that matches a Sentry project |

Incident fixtures: `checkout-guest-null-country`, `upstream-reset-inconclusive`,
`promo-code-undefined`.

---

## What the evals actually prove

| Scenario | What it demonstrates |
|---|---|
| `happy-path` | Full mitigation + remediation, revert PR opened before the fix PR |
| `culprit-proven-by-execution` | The blame is a **proof**: the failure reproduces at the suspect commit, does **not** reproduce at its parent, the two commits are distinct, the revert targets the *proven* PR, and a `causal` evidence item is recorded |
| `unverifiable-falls-back-to-correlation` | Nothing to replay → verification is skipped with a stated `skippedReason`, **no** causal evidence is fabricated, and the response still tickets and notifies |
| `no-false-blame` | The most recently deployed PR (#143, docs-only) is **not** blamed; exculpatory evidence recorded |
| `fix-tests-fail` | A fix that breaks the suite produces **no fix PR** — the revert still lands and Slack reports the blockage |
| `transient-api-failure` | Slack fails twice, is retried, and is delivered exactly once |
| `crash-and-resume` | Process killed right after the ticket is created; restart resumes with **no duplicate** |
| `rerun-is-idempotent` | Three full runs produce 1 ticket, 2 PRs, 1 Slack message |
| `partial-then-resume` | A run stopped before the revert PR resumes and completes without re-executing earlier steps |
| `inconclusive-investigation` | No candidate clears the confidence floor → **refuses to revert**, still files the ticket and escalates |
| `older-pr-is-culprit` | An older PR (#139) is correctly blamed over later deploys; the revert **conflicts**, which blocks only the mitigation track |

Every scenario additionally asserts the safety envelope: no duplicate writes, no unsafe action, no
merged PR, at most one ticket / two PRs / one Slack message.

---

## Known limitations

- The GitHub mock emulates the API surface Firefighter needs, not all of GitHub. PR review
  threads, checks, and merge queues are out of scope.
- Fix synthesis handles null/undefined dereference regressions well. Other bug classes fall back
  to reproducing, opening the ticket, and proposing the revert — it will not invent a fix it cannot
  verify, by design.
- Test and lint verification assume a Node.js repository (`node --test`). Other stacks need a new
  `TestRunner` implementation.
- With `GITHUB_PROVIDER=api`, verification steps still run against the local `FF_DEMO_REPO`
  checkout; running tests against an arbitrary remote repo would need a clone step.
- The LLM layer enriches the narrative and reviews the ranking; it deliberately cannot override the
  deterministic evidence list.
- **Causal verification needs a replayable request.** The two-sided test replays
  `Incident.sampleRequest`; an incident that carries no captured request (or one that does not
  reproduce at `HEAD`) cannot be bisected. Firefighter then degrades to the correlation ranking and
  labels it as unproven in the PR body, in the execution timeline and in Slack — it does not quietly
  present a guess as a proof.
- **It probes the top-ranked candidates, not the whole history.** Verification walks at most
  `DEFAULT_MAX_CANDIDATES` (4) candidates in ranked order. A culprit the analyzer ranks fifth or
  worse will not be probed, and the response falls back to correlation.
- **It assumes the fault is deterministically reproducible.** A flaky, concurrency-dependent or
  load-dependent failure may not reproduce at the suspect commit, or may reproduce at a parent that
  is in fact innocent. Such a fault will not be proven — and, correctly, will not be claimed as
  proven either.
- Remediation is off by default (`FF_MODE=mitigate`). A run that is expected to produce a fix PR and
  does not is usually just the default mode; `FF_MODE=full` enables the fix track.
- **Reverting an older change can conflict.** When later commits touched the same lines, `git revert`
  fails and Firefighter does not attempt automatic conflict resolution — it reports the conflict,
  blocks the mitigation track, and continues with the ticket, the fix track and the Slack update.
  This is exercised by the `older-pr-is-culprit` eval.
- Fix synthesis targets the failing frame. It does not attempt multi-file refactors, and it will not
  open a fix PR unless the regression test and the existing suite both pass.
- The demo repo's PR metadata lives in `demo-repo/.firefighter-meta.json`. Re-seeding with
  `--force` resets PR numbering, so pair it with `npm run reset` (which `npm run demo` does).
- `node --test <directory>` does not work on Node 24; the runner passes explicit file patterns.
  A non-Node repository needs a new `TestRunner` implementation.
- On a freshly created GitHub repo, Firefighter's own pull requests are numbered from #1, so they
  will not match the `#151`/`#152` seen in mock mode. The suspected PR numbers (#142 etc.) are
  preserved because they come from the seeded commit subjects.
- `npm run evals` always forces every provider to its mock, regardless of `.env`. Running the suite
  with live credentials must never open real pull requests or post to Slack, and it does not.
- Verification always runs against the local `FF_DEMO_REPO` clone. With a remote provider, branches
  the agent created server-side are fetched down first (`ensureLocalRef`), which requires the demo
  repo to have an `origin` remote — `github:setup` configures this.
