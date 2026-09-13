/* Firefighter dashboard — zero-build vanilla client. Polls /api/state. */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n) => `${Math.round((n || 0) * 100)}%`;
const time = (ts) => (ts ? new Date(ts).toISOString().slice(11, 19) : '');

let currentIncidentId = null;
let polling = null;

const ICONS = {
  step_started: '▶',
  step_succeeded: '✓',
  step_failed: '✗',
  step_skipped: '⊘',
  retry: '↻',
  replay: '⟳',
  info: '·',
  unsafe_blocked: '🛡',
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok && res.status !== 404) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    const p = h.providers || {};
    $('badges').innerHTML =
      [
        ['github', p.github],
        ['slack', p.slack],
        ['tickets', p.tickets],
        ['llm', p.llm],
      ]
        .map(([k, v]) => `<span class="badge">${k} <b>${esc(v)}</b></span>`)
        .join('') +
      `<span class="badge">demo repo <b>${h.demoRepoSeeded ? 'seeded' : 'not seeded'}</b></span>`;
  } catch {
    $('badges').innerHTML = '<span class="badge">server offline</span>';
  }
}

async function loadFixtures() {
  const d = await api('/api/incidents');
  const sel = $('fixture');
  sel.innerHTML = (d.fixtures || [])
    .map((f) => `<option value="${esc(f)}">${esc(f)}</option>`)
    .join('');
  if (!currentIncidentId && d.incidents && d.incidents.length) {
    currentIncidentId = d.incidents[0].incident.id;
  }
}

function renderIncident(s) {
  const i = s.incident;
  if (!i) return;
  $('incident-body').innerHTML = `
    <dl class="kv">
      <dt>ID</dt><dd><code>${esc(i.id)}</code></dd>
      <dt>Title</dt><dd><strong>${esc(i.title)}</strong></dd>
      <dt>Severity</dt><dd><span class="sev ${esc(i.severity)}">${esc(i.severity.toUpperCase())}</span></dd>
      <dt>Service</dt><dd>${esc(i.service)}</dd>
      <dt>Detected</dt><dd>${esc(i.detectedAt)}</dd>
      <dt>Source</dt><dd>${esc(i.source)}</dd>
      ${i.metrics ? `<dt>Impact</dt><dd>${esc(i.metrics.errorRatePct)}% error rate · ${esc(i.metrics.affectedRequests)} requests / ${esc(i.metrics.window)}</dd>` : ''}
    </dl>
    <pre class="trace">${esc(i.stackTrace)}</pre>`;
}

/** Short sha, the way git and the probe notes print it. */
const shortSha = (sha) => esc(String(sha || '').slice(0, 8));

/**
 * The two-sided execution proof: the failure is absent at the parent and present
 * at the change. Nothing else in the card outranks this, so it is rendered first.
 */
function renderProof(v) {
  const p = (v.probes || []).find((x) => x.verdict === 'proven');
  if (!p) return '';
  const label = p.prNumber !== null ? `#${esc(p.prNumber)}` : shortSha(p.sha);
  const probed = (v.probes || []).length;
  const ranked = v.rankedPr !== null ? `#${esc(v.rankedPr)}` : 'another change';
  return `<div class="proof">
    <div class="ph">✓ PROVEN BY EXECUTION <span class="m">${esc(v.method)}</span></div>
    <div class="pr first">
      <span class="sha">${p.parentSha ? shortSha(p.parentSha) : '(root)'}</span>
      <span class="at">before ${label}</span>
      <span class="no">failure does NOT reproduce</span>
    </div>
    <div class="pr">
      <span class="sha">${shortSha(p.sha)}</span>
      <span class="at">${label}</span>
      <span class="yes">failure DOES reproduce</span>
    </div>
    ${v.overrodeRanking ? `<div class="ov">⚠ correlation ranked ${ranked} — execution disproved it</div>` : ''}
    <div class="fo">replayed at ${probed === 1 ? '1 candidate' : `${esc(probed)} candidates`} · ${esc(v.durationMs)}ms</div>
  </div>`;
}

/** Unproven runs keep the correlation score, so they must say so out loud. */
function renderCaveat(v) {
  if (!v || v.verified) return '';
  const reason = v.skippedReason || v.summary || 'no candidate was shown to introduce the fault';
  return `<div class="caveat"><b>⊘ not proven by execution</b> — ${esc(reason)}</div>`;
}

/** Every probe, including the ruled-out ones — the audit trail behind the verdict. */
function renderProbes(v) {
  const probes = (v && v.probes) || [];
  if (!probes.length) return '';
  return `<details class="probes">
    <summary>Verification probes (${esc(probes.length)})</summary>
    <div class="sum">${esc(v.summary)}</div>
    <table>
      <colgroup><col class="c1" /><col class="c2" /><col /></colgroup>
      <tr><th>Candidate</th><th>Verdict</th><th>Note</th></tr>
      ${probes
        .map(
          (p) => `<tr>
            <td>${p.prNumber !== null ? `#${esc(p.prNumber)}` : shortSha(p.sha)}</td>
            <td class="v-${esc(p.verdict)}">${esc(p.verdict)}</td>
            <td>${esc(p.note)}</td>
          </tr>`,
        )
        .join('')}
    </table>
  </details>`;
}

function renderSuspect(s) {
  const inv = s.investigation;
  const card = $('suspect-card');
  if (!inv) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('reasoner').textContent = inv.reasoningSource || '';

  const cv = s.culpritVerification || null;
  // Promote the heading off the rendered proof, not off the flag: a card that
  // cannot show the two-sided probe must not claim the culprit is confirmed.
  const proof = cv && cv.verified ? renderProof(cv) : '';
  $('suspect-heading').textContent = proof ? 'Confirmed culprit' : 'Suspected culprit';

  if (inv.inconclusive || !inv.suspect) {
    $('suspect-body').innerHTML = `
      <div style="color:var(--warn);font-weight:600;margin-bottom:6px">⚠ Investigation inconclusive</div>
      <div style="color:var(--dim);font-size:13px">${esc(inv.immediateMitigation || 'No change cleared the confidence floor. Human triage required — no revert was proposed.')}</div>
      ${renderCaveat(cv)}
      ${renderProbes(cv)}
      ${renderRanked(inv, cv)}`;
    return;
  }

  const sus = inv.suspect;
  // The causal bullet restates the proof block, but it is not redundant: the demo
  // script points at it by name, and its `detail` is the only place on the card
  // that names the candidates execution ruled out.
  const ev = (sus.evidence || [])
    .map(
      (e) =>
        `<li class="${e.score < 0 ? 'neg' : ''}"><b>${esc(e.kind)}</b> — ${esc(e.description)}${e.detail ? ` <span style="color:var(--faint)">(${esc(e.detail)})</span>` : ''}</li>`,
    )
    .join('');

  $('suspect-body').innerHTML = `
    ${proof}
    <div class="suspect">
      ${proof ? '' : `<div class="ring" style="--v:${Math.round((sus.confidence || 0) * 100)}"><span>${pct(sus.confidence)}</span></div>`}
      <div class="meta">
        <div class="prno">PR #${esc(sus.prNumber)}</div>
        <div class="title">${esc(sus.title)}</div>
        <div class="who">${esc(sus.author)}${sus.deployedAt ? ` · deployed ${esc(sus.deployedAt)}` : ''}</div>
      </div>
    </div>
    ${renderCaveat(cv)}
    ${ev ? `<ul class="ev">${ev}</ul>` : ''}
    <div style="margin-top:13px;border-top:1px solid var(--line);padding-top:11px">
      <div style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px">Affected functionality</div>
      <div style="font-size:13px;margin-top:3px">${esc(inv.affectedFunctionality)}</div>
      <div style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-top:9px">Root cause</div>
      <div style="font-size:13px;margin-top:3px">${esc(inv.rootCause)}</div>
    </div>
    ${renderProbes(cv)}
    ${renderRanked(inv, cv)}`;
}

function renderRanked(inv, cv) {
  const list = inv.rankedSuspects || [];
  if (list.length < 2) return '';
  // Execution outranks correlation, so the highlight follows the proof. Without
  // one it stays on the top-ranked row, exactly as before.
  const provenPr = cv && cv.verified ? cv.culpritPr : null;
  return `<div class="ranked">
    <div style="font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">All candidates considered</div>
    ${list
      .map(
        (c, idx) =>
          `<div class="row ${(provenPr !== null && provenPr !== undefined ? c.prNumber === provenPr : idx === 0 && !inv.inconclusive) ? 'top' : ''}">
             <span style="width:46px">#${esc(c.prNumber)}</span>
             <span class="b"><i style="width:${Math.max(2, Math.round((c.confidence || 0) * 100))}%"></i></span>
             <span style="width:38px;text-align:right">${pct(c.confidence)}</span>
           </div>`,
      )
      .join('')}
  </div>`;
}

function artifactRow(icon, label, value, status, href) {
  const cls = status === 'ok' ? 's-ok' : status === 'blocked' ? 's-blk' : 's-pend';
  const text = status === 'ok' ? 'created' : status === 'blocked' ? 'blocked' : 'pending';
  const v = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(value)}</a>` : esc(value);
  return `<div class="r"><div class="i">${icon}</div>
    <div class="n"><div class="t">${esc(label)}</div><div class="v">${v}</div></div>
    <div class="s ${cls}">${text}</div></div>`;
}

function renderArtifacts(s) {
  const card = $('artifacts-card');
  if (!s.run) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const t = s.ticket, rp = s.revertPr, fp = s.fixPr, sl = s.slack;
  const fixBlocked = !fp && (s.steps || []).some((x) => x.step === 'create_fix_pr' && (x.status === 'skipped' || x.status === 'failed'));
  $('artifacts').innerHTML = [
    artifactRow('🎫', 'Incident ticket', t ? `${t.identifier} — ${t.state}` : 'not created', t ? 'ok' : 'pending', t?.url),
    artifactRow('🚨', 'Revert PR (mitigation)', rp ? `#${rp.number} — ${rp.title}` : 'not created', rp ? 'ok' : 'pending', rp?.url),
    artifactRow('🔧', 'Fix PR (remediation)', fp ? `#${fp.number} — ${fp.title}` : fixBlocked ? 'blocked — verification failed' : 'not created', fp ? 'ok' : fixBlocked ? 'blocked' : 'pending', fp?.url),
    artifactRow('💬', 'Slack notification', sl ? `${sl.channel} @ ${sl.ts}` : 'not sent', sl ? 'ok' : 'pending', sl?.permalink),
  ].join('');

  const det = $('slack-details');
  if (sl && sl.text) {
    det.hidden = false;
    $('slack-text').textContent = sl.text;
  } else {
    det.hidden = true;
  }
}

function renderTimeline(s) {
  const tl = $('timeline');
  const items = s.timeline || [];
  if (!items.length) {
    tl.innerHTML = '<div class="empty">Waiting for an incident…</div>';
    return;
  }
  const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
  // The culprit proof is the moment worth spotting in a long scroll — but only
  // when execution actually proved something; the step succeeds either way.
  const proven = !!(s.culpritVerification && s.culpritVerification.verified);
  tl.innerHTML = items
    .map(
      (e) => `<div class="e k-${esc(e.kind)}${proven && e.step === 'verify_culprit' && e.kind === 'step_succeeded' ? ' proof-line' : ''}">
        <div class="ts">${time(e.ts)}</div>
        <div class="ic">${ICONS[e.kind] || '·'}</div>
        <div class="tx">${esc(e.message)}${e.detail && e.kind === 'info' && e.message === 'Slack message rendered' ? `<div class="d">${esc(e.detail)}</div>` : ''}</div>
      </div>`,
    )
    .join('');
  if (atBottom) tl.scrollTop = tl.scrollHeight;

  const blocked = (s.steps || []).filter((x) => x.status === 'skipped' || x.status === 'failed');
  const note = $('blocked-note');
  if (blocked.length) {
    note.hidden = false;
    note.innerHTML = blocked.map((b) => `⚠ <b>${esc(b.step)}</b>: ${esc(b.error || b.status)}`).join('<br/>');
  } else {
    note.hidden = true;
  }
}

function renderMetrics(s) {
  const card = $('metrics-card');
  if (!s.run) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const m = s.metrics || {};
  const cell = (n, l, cls) => `<div><span class="n ${cls}">${n}</span><span class="l">${l}</span></div>`;
  $('metrics').innerHTML = [
    cell(m.mutations ?? 0, 'external writes', 'neutral'),
    cell(m.duplicateWrites ?? 0, 'duplicates', (m.duplicateWrites ?? 0) === 0 ? 'good' : 'bad'),
    cell(m.replays ?? 0, 'idempotent replays', 'neutral'),
    cell(m.retries ?? 0, 'retries', (m.retries ?? 0) > 0 ? 'warn' : 'neutral'),
    cell(m.unsafeActions ?? 0, 'unsafe actions', (m.unsafeActions ?? 0) === 0 ? 'good' : 'bad'),
    cell(m.toolCalls ?? 0, 'tool calls', 'neutral'),
  ].join('');
  const blockedN = m.blockedAttempts ?? 0;
  $('safety').innerHTML = `🛡 Firefighter never merges or deploys. ${
    blockedN ? `<b style="color:var(--err);margin-left:4px">${blockedN} unsafe action(s) refused.</b>` : 'All production changes stop at a human-reviewable PR.'
  }`;
}

function renderTools(s) {
  const card = $('tools-card');
  const calls = s.toolCalls || [];
  if (!calls.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('tools-tag').textContent = `${calls.length} calls`;
  $('tools').innerHTML = calls
    .slice(-60)
    .map(
      (c) =>
        `<div class="t"><span style="width:58px">${time(c.createdAt)}</span>
         <span class="nm ${c.mutating ? 'mu' : ''}">${esc(c.tool)}</span>
         ${c.replayed ? '<span class="rp">replayed</span>' : ''}
         <span>${c.ok ? '' : '✗ '}${c.durationMs}ms</span></div>`,
    )
    .join('');
}

async function refresh() {
  try {
    const s = currentIncidentId ? await api(`/api/state/${currentIncidentId}`) : await api('/api/state');
    if (s.empty || !s.incident) {
      $('status').textContent = 'no incidents yet';
      return;
    }
    currentIncidentId = s.incident.id;
    renderIncident(s);
    renderSuspect(s);
    renderArtifacts(s);
    renderTimeline(s);
    renderMetrics(s);
    renderTools(s);
    const run = s.run;
    $('run-tag').textContent = run ? `${run.status}${run.currentStep ? ` · ${run.currentStep}` : ''}` : '';
    $('status').textContent = s.running ? '● running' : run ? `● ${run.status}` : '';
    $('status').style.color = s.running ? 'var(--info)' : run?.status === 'succeeded' ? 'var(--ok)' : run?.status === 'failed' ? 'var(--err)' : 'var(--dim)';
    $('resume').disabled = !!s.running || !run;
    $('trigger').disabled = !!s.running;
  } catch (err) {
    $('status').textContent = String(err.message || err);
  }
}

$('trigger').onclick = async () => {
  $('trigger').disabled = true;
  const r = await api('/api/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixture: $('fixture').value }),
  });
  currentIncidentId = r.incidentId;
  refresh();
};
$('resume').onclick = async () => {
  if (!currentIncidentId) return;
  $('resume').disabled = true;
  await api(`/api/incidents/${currentIncidentId}/resume`, { method: 'POST' });
  refresh();
};
$('refresh').onclick = refresh;

(async function init() {
  await loadHealth();
  await loadFixtures();
  await refresh();
  polling = setInterval(refresh, 700);
})();
