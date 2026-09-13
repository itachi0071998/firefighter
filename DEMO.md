# 🔥 Firefighter — 2-minute demo script

**The line:** *"Firefighter doesn't guess which change broke production — it proves it, by running
the failure on both sides of the commit. Then it mitigates first, remediates second, and never
merges."*

---

## Setup (before you present)

```bash
npm install
npm run seed -- --force      # builds the demo repo with a real regression in PR #142
npm run reset                # clean durable state
npm start                    # dashboard on http://localhost:8787
```

Open `http://localhost:8787` and leave it on screen.

Three ways to run the same incident, in increasing order of "is this real?":

```bash
npm run demo                                                       # fully mocked, deterministic
FF_MODE=full npm run demo                                          # ...plus the draft fix PR
npm run run-incident -- <your-sentry-issue-id>                     # real Sentry → real GitHub → real Slack
```

The first two need no credentials at all. The third needs the Sentry, GitHub and Slack settings from
`.env.example`, and it opens a genuine pull request against a genuine repository.

---

## The 2 minutes

### 0:00 — The setup (15s)

> "This is a checkout service. Three minutes ago PR #142 shipped country-specific tax rules.
> Thirty seconds ago a docs-only PR #143 also deployed — it's the most recent deploy.
> Right now, checkout is throwing 500s for guest users."

Point at the dashboard: **empty, waiting**.

### 0:15 — Fire the incident (10s)

Click **⚡ Trigger incident**.

> "A Sentry-style alert just came in. Firefighter takes it from here."

### 0:25 — Correlation gets you a shortlist (20s)

Watch the **execution timeline** fill in live. Narrate:

> "It's collecting recent commits, pull requests and deployments, and correlating the stack trace
> against the diffs. It ranks PR #142 first — #143 deployed more recently but it's docs-only and
> doesn't appear in the stack trace, so it's recorded as *exculpatory* evidence."

Then undercut it deliberately — this sets up the next beat:

> "And that's where every other tool stops. A ranked list is a **guess**. Nobody reverts production
> at 3am on a guess."

### 0:45 — The proof (30s) ← **this is the climax**

The next timeline line is the one to land on:

> **Culprit PROVEN — PR #142: absent at `28ca56671d`, present at `ddc3f5edcd`**

> "It did not stop at the ranking. It took the production request the alert carried — the real one,
> headers and body — and it replayed it twice. Once at PR #142's commit: the failure reproduces. Once at that commit's
> **parent**: the failure does **not** reproduce."

```
commit 28ca56671d  (before #142)   → failure does NOT reproduce
commit ddc3f5edcd  (#142)          → failure DOES reproduce
```

> "Absent before the change, present after it. That's not a correlation any more — that's the change
> that introduced the fault, established by running it. Both probes happen in throwaway git
> worktrees, and the whole proof takes about three hundred milliseconds."

Point at the suspect card: confidence is **100%**, and the top evidence line is a `causal` one
quoting the two commits.

> "Every other signal on this card — stack overlap, deploy timing, symbol match — is now just
> supporting detail. The answer came from execution."

### 1:15 — And it corrects itself (10s)

> "The ranking doesn't get the last word either. If the top candidate is disproved — the failure
> reproduces at its parent too, so the bug is older than it — Firefighter rules it out and probes
> the next one, up to four. When execution blames a change the ranking didn't put first, it
> re-points the investigation and flags `overrodeRanking`, and Slack says so out loud:
> *'Correlation first ranked #N; execution disproved it.'*"

> "That flag is kept on purpose. Every one of them is a labelled example of the heuristic being
> wrong on a real incident — which is exactly the training signal you need to fix the weights."

If someone doubts it, show it rather than assert it — this forces the *weakest* candidate to the
top of the ranking and lets execution throw it out:

```bash
npm run bisect -- --sabotage   # ranks #141 first; probing proves #142 anyway
```

### 1:25 — Mitigate first, and stop (15s)

Click through to the **Revert PR** in the artifacts panel.

> "Incident ticket filed. Then the mitigation: a branch, a real `git revert` of #142, the test suite
> run against the revert in a throwaway worktree, and a pull request."

Show the body — the **Confidence** row reads **"Proven by execution (not inferred)"**, and there is a
**Causal verification** section with those same two commits.

> "Production can be restored right now. And notice — it stopped at a pull request. It did not merge
> it. It can't: the GitHub client has no merge method."

### 1:40 — Mitigate-only is the default (10s)

> "By default that's where it ends. The revert is *proven* and mechanical. A synthesised fix is a
> guess about what the author meant, and I'm not shipping those two things as equals."

```bash
FF_MODE=full npm start        # opt the dashboard into the remediation track
FF_MODE=full npm run demo     # ...or the terminal run
```

> "Turn it on and it also reproduces the bug, writes a patch **and a regression test**, runs the full
> suite plus static analysis, and opens a second PR — as a **draft**, whose body says it's a guess.
> The regression test is the half that's verifiable: it fails without the patch and passes with it.
> Keep the test even if you throw the patch away."

### 1:50 — The reliability punchline (15s)

Point at the **Reliability & safety** panel: `0 duplicates`, `0 unsafe actions`.

In a terminal:

```bash
npm run evals -- crash-and-resume
```

> "This scenario runs the workflow as a real child process and kills it *right after* the incident
> ticket is created — before the step is even marked done — then restarts it. One ticket. One revert
> PR. One fix PR. One Slack message. Every external write goes through an idempotency ledger, so
> replaying is always safe."

Close:

> "It proves which change broke production, mitigates it, tickets it, tells the team — autonomously.
> Merge and deploy stay with a human. Always."

---

## Backup / deeper cuts if you have more time

```bash
npm run evals                 # full suite + metrics table
npm run bisect                # just the proof, narrated probe by probe
npm run bisect -- --sabotage  # ranking deliberately wrong; execution still gets it right
npm run evals -- culprit-proven-by-execution          # the proof, asserted end to end
npm run evals -- unverifiable-falls-back-to-correlation  # nothing to replay => says "unproven"
npm run evals -- no-false-blame        # proves #143 is not blamed
npm run evals -- fix-tests-fail        # bad fix => NO fix PR opened, revert still lands
npm run evals -- inconclusive-investigation   # refuses to revert anything
npm test                      # safety guard + idempotency unit tests
npm run status                # full timeline + summary in the terminal
```

**If asked "how do you *know* it's that PR?"**
Because it was executed, not inferred. The captured production request is replayed at the suspect
commit and at its parent, each in a detached `git worktree`. The failure has to appear on one side
and not the other. If the fault also reproduces at the parent, the candidate is stamped
`predates-this-change` and ruled out, and the next ranked candidate is probed — up to four.

**If asked "what if the request can't be replayed?"**
Then it isn't proven, and Firefighter says so. With no `Incident.sampleRequest` (or no reproduction
at `HEAD`) the step records a `skippedReason`, the answer falls back to the correlation ranking, and
the revert PR body leads with **"⚠️ Not proven by execution … treat it as a lead"**. It will not
dress a guess up as a proof.

**If asked "what if the bug is flaky?"**
The two-sided test assumes the fault is deterministically reproducible. A load- or
concurrency-dependent failure may not reproduce at the suspect commit at all — in which case it is
reported as unproven rather than proven wrongly.

**If asked "what's real and what's mocked?"**
`npm run demo` mocks GitHub, Slack and the ticket tracker — but `demo-repo/` is a genuine git
repository with real commits and real diffs, so the reverts, the worktrees, the bisection probes and
the test runs are all real work against real git. The Sentry command at the top is real end to end:
a live Sentry issue, a real pull request, a real Slack message.

**If asked "what if the LLM is wrong?"**
The deterministic evidence analyzer always runs. The LLM only *reviews* the ranking; its answer is
rejected unless it names a real candidate with a valid confidence, and the evidence list is never
model-generated.

**If asked "what if it can't figure it out?"**
`npm run evals -- inconclusive-investigation` — no candidate clears the confidence floor, so it
refuses to revert, still files the ticket, and escalates to humans on Slack.

**If asked "could it ever merge by accident?"**
`GitHubClient` has no merge method — the capability doesn't exist. On top of that,
`assertSafeAction`, `assertSafeGitCommand` and `assertSafeHttp` block merges, deploys and
force-pushes at the choke point and the transport, and every refusal is audited.

---

## Terminal-only version (no browser)

```bash
npm run demo                  # mitigate-only (default)
FF_MODE=full npm run demo     # also drafts the fix + regression-test PR
```
Prints the live timeline — including the `Culprit PROVEN` line and the two commits it was proven
across — the full investigation with ranked candidates and evidence, all created artifacts, and the
reliability summary.
