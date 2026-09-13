import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, config, effectiveProviders } from '../config.ts';
import { openDb } from '../db/index.ts';
import {
  getIncident,
  getRunByIncident,
  listIncidents,
  resolveBridgeIntent,
  listBridgeIntents,
  addTimeline,
} from '../db/repo.ts';
import { runWorkflow } from '../workflow/engine.ts';
import { buildDashboardState, listDashboardIncidents } from './state.ts';
import { INCIDENT_FIXTURES, buildCheckoutIncident } from '../demo/incidents.ts';
import { getIncidentSource, resolveIncident } from '../tools/sentry.ts';
import { seedDemoRepo, isSeeded } from '../demo/seed.ts';
import { Incident } from '../types.ts';
import { logger } from '../util/log.ts';

const log = logger('server');

/** In-flight runs, so the UI can show "running" without polling the engine. */
const active = new Map<string, Promise<unknown>>();

function startRun(incident: Incident, scenario?: string): string {
  const existing = active.get(incident.id);
  if (existing) return incident.id;
  const p = runWorkflow({ incident, scenario })
    .catch((err) => {
      log.error(`run for ${incident.id} failed: ${String(err)}`);
    })
    .finally(() => {
      active.delete(incident.id);
    });
  active.set(incident.id, p);
  return incident.id;
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    const eff = effectiveProviders(config);
    res.json({
      ok: true,
      providers: eff,
      demoRepoSeeded: isSeeded(config.demoRepoPath),
      dbPath: config.dbPath,
    });
  });

  app.get('/api/incidents', (_req, res) => {
    res.json({
      incidents: listDashboardIncidents(),
      fixtures: Object.keys(INCIDENT_FIXTURES),
      source: getIncidentSource(config).provider,
    });
  });

  /** Live incidents from the configured source (Sentry when connected). */
  app.get('/api/source/incidents', async (_req, res) => {
    try {
      const source = getIncidentSource(config);
      res.json({ provider: source.provider, incidents: await source.listIncidents(10) });
    } catch (err) {
      res.status(502).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get('/api/state/:incidentId', (req: Request, res: Response) => {
    const state = buildDashboardState(req.params.incidentId);
    if (!state) return res.status(404).json({ error: 'unknown incident' });
    res.json({ ...state, running: active.has(req.params.incidentId) });
  });

  /** Latest incident, for the dashboard's default view. */
  app.get('/api/state', (_req, res) => {
    const all = listIncidents();
    if (!all.length) return res.json({ empty: true });
    const state = buildDashboardState(all[0].id);
    res.json({ ...state, running: active.has(all[0].id) });
  });

  /**
   * Ingest an incident and kick off (or resume) its workflow. Posting the same
   * incident twice collapses onto the same id and the same run — the HTTP
   * boundary is idempotent too.
   */
  app.post('/api/incidents', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const incident: Incident = body.fixture
        ? INCIDENT_FIXTURES[body.fixture]?.() ?? buildCheckoutIncident()
        : body.sourceIncidentId
          ? await resolveIncident(String(body.sourceIncidentId), config)
          : (body as Incident);
      if (!incident || !incident.title) return res.status(400).json({ error: 'invalid incident payload' });
      if (!isSeeded(config.demoRepoPath)) await seedDemoRepo();
      startRun(incident, body.fixture ?? 'api');
      res.status(202).json({ incidentId: incident.id, status: 'accepted' });
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.post('/api/incidents/:incidentId/resume', (req: Request, res: Response) => {
    const incident = getIncident(req.params.incidentId);
    if (!incident) return res.status(404).json({ error: 'unknown incident' });
    startRun(incident, 'resume');
    res.status(202).json({ incidentId: incident.id, status: 'resuming' });
  });

  app.post('/api/demo/seed', async (req: Request, res: Response) => {
    const result = await seedDemoRepo({ force: req.body?.force === true });
    res.json({ ok: true, headSha: result.headSha, commits: result.commits });
  });

  // --- Connector bridge ----------------------------------------------------
  app.get('/api/bridge', (_req, res) => res.json({ intents: listBridgeIntents() }));

  app.post('/api/bridge/:id/resolve', (req: Request, res: Response) => {
    const { externalId, externalUrl } = req.body ?? {};
    if (!externalId) return res.status(400).json({ error: 'externalId is required' });
    const intent = resolveBridgeIntent(req.params.id, String(externalId), externalUrl ?? null);
    if (!intent) return res.status(404).json({ error: 'unknown intent' });
    const run = getRunByIncident(intent.incidentId);
    if (run) addTimeline(run.id, 'info', `Bridge intent ${intent.kind} delivered externally as ${externalId}`);
    res.json({ intent });
  });

  // --- Slack outbox (mock delivery surface) --------------------------------
  app.get('/api/slack/:incidentId', (req: Request, res: Response) => {
    const file = path.join(config.dataDir, 'slack-outbox', `${req.params.incidentId}.json`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no slack message recorded' });
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  });

  const appDir = path.join(ROOT, 'app');
  app.use(express.static(appDir));
  app.get('/', (_req, res) => res.sendFile(path.join(appDir, 'index.html')));

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  openDb(config.dbPath);
  const app = createApp();
  app.listen(config.port, () => {
    const eff = effectiveProviders(config);
    log.info(`Firefighter dashboard  →  http://localhost:${config.port}`);
    log.info(
      `providers: github=${eff.github} slack=${eff.slack} tickets=${eff.tickets} llm=${eff.llm}`,
    );
    for (const n of eff.notes) log.warn(n);
  });
}
