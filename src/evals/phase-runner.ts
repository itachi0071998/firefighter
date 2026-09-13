/**
 * One eval phase = one process. Invoked by the harness as a child process with
 * FF_DB_PATH / FF_DEMO_REPO pointing at that scenario's isolated state.
 *
 * Running phases as separate processes is what makes the crash test real: the
 * harness sends the child to its death mid-workflow and then starts a fresh one.
 */
import { config } from '../config.ts';
import { openDb } from '../db/index.ts';
import { runWorkflow } from '../workflow/engine.ts';
import { INCIDENT_FIXTURES, buildCheckoutIncident } from '../demo/incidents.ts';
import { seedDemoRepo, isSeeded } from '../demo/seed.ts';
import { StepName } from '../types.ts';
import { freezeClock } from '../util/clock.ts';

async function main(): Promise<void> {
  const fixture = process.argv[2] ?? 'checkout-guest-null-country';
  const stopBefore = (process.argv[3] || undefined) as StepName | undefined;

  // Freeze the clock so ids, hashes and ordering are byte-identical run to run.
  freezeClock(process.env.FF_FREEZE_AT ?? '2026-09-13T09:20:00.000Z');

  openDb(config.dbPath);
  if (!isSeeded(config.demoRepoPath)) await seedDemoRepo();

  const incident = (INCIDENT_FIXTURES[fixture] ?? buildCheckoutIncident)();
  const outcome = await runWorkflow({ incident, scenario: fixture, stopBefore });
  process.stdout.write(
    '\n__FF_RESULT__' + JSON.stringify({ status: outcome.run.status, incidentId: outcome.run.incidentId }) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`phase-runner failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
