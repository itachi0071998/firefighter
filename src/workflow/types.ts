import { Config } from '../config.ts';
import { StepName, StepOutput, WorkflowContext } from '../types.ts';
import { Tools } from '../tools/index.ts';

export interface StepHelpers {
  attempt: number;
  cfg: Config;
  runId: string;
}

export interface StepDef {
  name: StepName;
  /** Critical steps halt the run when they exhaust retries. */
  critical: boolean;
  /** Gate a step on upstream results without failing the run. */
  precondition?: (ctx: WorkflowContext) => { ok: boolean; reason?: string };
  run: (ctx: WorkflowContext, tools: Tools, helpers: StepHelpers) => Promise<StepOutput>;
}

export interface StepTitle {
  gerund: string;
  failed: string;
  skipped: string;
  done: (ctx: WorkflowContext) => string;
}
