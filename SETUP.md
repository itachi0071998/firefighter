# 🔧 Setup — connecting Firefighter to real services

Firefighter runs with an **entirely empty `.env`**: every integration defaults to a mock adapter,
so nothing below is required to see the demo work. Connect a service only when you want Firefighter
to act in it for real.

Every integration is independent. Connect Jira without touching Slack; connect Slack without
touching Sentry. After each one, run the preflight and confirm the line turns green:

```bash
npm run preflight
```

> **Nothing in this guide asks Firefighter to merge or deploy.** It opens pull requests, files
> tickets and posts messages. Merging and deploying stay human.

---

## Contents

- [Jira — incident tickets](#jira--incident-tickets)
- [Slack — incident updates](#slack--incident-updates)
- [Sentry — where incidents come from](#sentry--where-incidents-come-from)
- [Verify it worked](#verify-it-worked)

---

## Jira — incident tickets

Firefighter files one **Bug** per incident in a single project, then updates that issue once the
revert PR exists. It never touches any other project.

### 1. Create a free Atlassian Cloud site

Sign up at **<https://www.atlassian.com/software/jira/free>**. You choose a site name during
signup, which becomes your base URL:

```
https://<your-site>.atlassian.net
```

That URL — the bare site root, with no trailing path — is `JIRA_BASE_URL`.

### 2. Create a project and note its KEY

In Jira, open **Projects → Create project** and pick any template. A **Jira Software** template
(Scrum or Kanban) includes a **Bug** issue type, which is the type Firefighter prefers.

While creating it you set a **Name** and a **Key**. The key is the short prefix on every issue id —
issue `INC-14` lives in project key `INC`. Use whatever you like; `INC` is the default Firefighter
expects. The key is `JIRA_PROJECT_KEY`.

> **You do not have to match the project's fields exactly.** Team-managed projects choose their own
> create screen, so a project may have no **Priority** field and no **Bug** issue type. Firefighter
> handles both: if Jira rejects `priority` or `labels` it retries without that field, and if there is
> no `Bug` type it files a `Task` instead. Each fallback is logged as a warning; the ticket is still
> created. An incident ticket without a priority beats no incident ticket.

### 3. Create an API token

Go to **<https://id.atlassian.com/manage-profile/security/api-tokens>** → **Create API token** →
give it a label (e.g. `firefighter`) → **Copy**. The token is shown **once**; if you lose it, revoke
it and create another.

The token is tied to *your* Atlassian account, so `JIRA_EMAIL` must be the email address of the
account that created it. Jira authenticates the pair `email:token` over HTTP Basic; either one alone
is rejected with `401`.

### 4. The exact `.env` lines

```bash
TICKET_PROVIDER=jira
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=paste-the-token-here
JIRA_PROJECT_KEY=INC
```

### 5. Minimum permissions

On **that project only**, the account needs:

| Permission | Why |
|---|---|
| **Browse Projects** | read the project, and read back the issue after creating it |
| **Create Issues** | file the incident ticket |

Two more are optional. After the revert PR is opened, Firefighter rewrites the ticket description
and moves it to *In Progress*, which needs **Edit Issues** and **Transition Issues**. That update is
best-effort: if it is refused, or the project has no *In Progress* transition, the failure is logged
and the incident response continues. The ticket is still filed.

If you created the site yourself you are its administrator and already have all four.

---

## Slack — incident updates

Firefighter posts one structured Block Kit update per incident. It needs exactly one scope:
`chat:write`.

### Option A — bot token (recommended)

**1. Create the app.** Go to **<https://api.slack.com/apps>** → **Create New App** → **From
scratch** → name it (e.g. `Firefighter`) → pick your workspace → **Create App**.

**2. Add the bot scope.** In the left sidebar open **OAuth & Permissions**, scroll to **Scopes**,
and under **Bot Token Scopes** — *not* User Token Scopes — add:

```
chat:write
```

**3. Install it.** Still on **OAuth & Permissions**, click **Install to Workspace** and approve.

**4. Copy the token.** Back on **OAuth & Permissions**, copy the **Bot User OAuth Token**. It starts
with **`xoxb-`**.

> ### ⚠️ The `xoxe` trap
>
> An **app-configuration token** (starts with `xoxe`, from *Your Apps → app configuration tokens*)
> is **not** a bot token. It exists to edit app manifests. It will authenticate happily and then
> fail at post time with **`missing_scope`**. A **user token** (`xoxp-`) and an app-level token
> (`xapp-`) are equally wrong here.
>
> **Only a token beginning `xoxb-` can post as your bot.** `npm run preflight` checks the prefix,
> reads the granted scopes, and says so explicitly if `chat:write` is absent.

**5. Invite the bot to the channel.** A bot with `chat:write` still cannot post to a channel it is
not in. In the target channel, type:

```
/invite @Firefighter
```

**6. Get the channel ID.** Right-click the channel in the sidebar → **View channel details** (or
click the channel name at the top of the channel). Scroll to the bottom of the **About** tab: the
**Channel ID** is there, with a copy button. It looks like `C0A1B2C3D4E`.

A channel ID is more robust than a `#name`, because renaming the channel does not break it — but
`SLACK_CHANNEL=#incidents` works too.

```bash
SLACK_PROVIDER=bot
SLACK_BOT_TOKEN=xoxb-paste-the-bot-token-here
SLACK_CHANNEL=C0A1B2C3D4E
```

### Option B — incoming webhook (lower privilege)

A webhook grants no API scopes at all and can only post to the **one channel** chosen when it was
created. Fewer permissions, less flexibility.

In your app: **Incoming Webhooks** → toggle **On** → **Add New Webhook to Workspace** → choose the
channel → **Allow** → copy the URL.

```bash
SLACK_PROVIDER=webhook
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...
```

`SLACK_CHANNEL` is ignored in this mode — the webhook's channel is fixed. **Treat the URL as a
secret**: anyone holding it can post to that channel.

> Preflight reports a webhook as configured but does **not** verify it. The only way to test a
> webhook is to post with it, and a diagnostic command should not put a message in your channel.

---

## Sentry — where incidents come from

With Sentry connected, Firefighter pulls a real unresolved issue — its stack trace, breadcrumbs and
the request that triggered it — instead of using the built-in fixtures.

### 1. Create an account, an organization and a project

Sign up at **<https://sentry.io/signup/>**. Signup creates your **organization**; you choose its
name, and its slug is derived from it.

Then create a project: **Projects → Create Project** → platform **Node.js** → name it → create.

### 2. Get the two slugs from the URL

Slugs are the lowercase, hyphenated identifiers in the address bar — **not** the display names.
Open the project and read them off the URL:

```
https://<org-slug>.sentry.io/projects/<project-slug>/
https://sentry.io/organizations/<org-slug>/projects/<project-slug>/     ← older URL shape
```

Either shape gives you the same two values: `SENTRY_ORG` and `SENTRY_PROJECT`.

### 3. Create an auth token with read scopes

Firefighter only ever reads from Sentry, so the token needs read scopes only:

```
project:read    event:read    org:read
```

`project:read` and `event:read` are the two the calls actually use — listing a project's issues and
reading an issue's latest event. `org:read` is included because organization-level tokens are
generally issued with it, and granting it costs nothing that is not already readable.

Organization auth tokens live under **Settings → Auth Tokens**; personal tokens live under your
**user settings → User Auth Tokens**. Either works. Where the scope list is editable, tick those
three and nothing else.

### 4. The exact `.env` lines

```bash
INCIDENT_SOURCE=sentry
SENTRY_AUTH_TOKEN=paste-the-token-here
SENTRY_ORG=your-org-slug
SENTRY_PROJECT=your-project-slug
SENTRY_URL=https://sentry.io
```

Two notes:

- **`SENTRY_TOKEN` is accepted as an alias for `SENTRY_AUTH_TOKEN`.** That is the name `sentry-cli`
  uses, and quietly setting the wrong one is an easy way to disable the integration without
  noticing. Either name works; you do not need both.
- **`SENTRY_URL`** is the API host. Keep the default for sentry.io. Change it for self-hosted
  Sentry, or if your organization lives on a region-specific host — use the host your browser is
  actually on.

Optionally pin one issue so a demo is reproducible:

```bash
SENTRY_ISSUE_ID=6543210987
```

If that issue is later retired, Firefighter falls back to the newest unresolved issue rather than
failing.

---

## Verify it worked

```bash
npm run preflight
# the same thing, without the npm script:
node --import tsx src/cli.ts preflight
```

One line per integration, each one a single **read-only** call. Nothing is created: no ticket, no
branch, no pull request, no Slack message. It is safe to run at any time, including mid-incident,
and it **always exits 0** — it is a diagnostic, not a gate.

```
🔥 preflight — verifying every configured credential (read-only)

  ✓ github  authenticated as octocat · octocat/checkout-service reachable, default branch main
            scopes: repo, read:org
  ✓ sentry  project acme-inc/checkout-demo readable ("Checkout Demo")
  ✓ slack   authenticated as firefighter in Acme · posting to C0A1B2C3D4E — the bot must be a
            member, invite it with /invite @firefighter.
            scopes: chat:write
  ✗ jira    authenticated as Ada Lovelace, but project "INC" was not found (404) —
            JIRA_PROJECT_KEY is the short key that prefixes issue ids (INC-12 → INC), and the
            account needs Browse Projects on it.
  – linear  TICKET_PROVIDER=jira — Linear is not in use.

  4 live, 1 mocked, 1 failing
```

| Mark | Meaning |
|---|---|
| `✓` | pointed at a real provider, and the credential works |
| `✗` | pointed at a real provider, and the credential does **not** work — the line says why, and how to fix it |
| `–` | deliberately mocked, so there is nothing to prove |

Two behaviours worth knowing:

- **A credential is verified even before you switch the provider on.** Set `JIRA_*` while
  `TICKET_PROVIDER` is still `mock` and preflight will still test it, report the result, and remind
  you that tickets are mocked until you flip the provider. That is the normal state right after
  creating an API token.
- **Nothing is printed that could leak.** Tokens never appear in the output, including inside error
  bodies echoed back by a provider.

If a provider is set to a real backend but its credentials are incomplete, Firefighter **degrades to
the mock adapter and says so** at the start of a run rather than failing an incident response. A
green preflight is how you know that will not happen.
