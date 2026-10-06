import { logger } from '@trigger.dev/sdk';

/**
 * Laptops share the production database (D7), so a scheduled task fired by a
 * local `trigger dev` would send real emails and write real rows a second
 * time. Schedules therefore run only in the PRODUCTION Trigger.dev
 * environment unless COMP_RUN_SCHEDULES_IN_DEV=true opts in explicitly.
 */

export const RUN_SCHEDULES_IN_DEV_FLAG = 'COMP_RUN_SCHEDULES_IN_DEV';

export function shouldRunScheduledTask({
  environmentType,
  env,
}: {
  environmentType: string;
  env: Record<string, string | undefined>;
}): boolean {
  if (environmentType === 'PRODUCTION') return true;
  return env[RUN_SCHEDULES_IN_DEV_FLAG] === 'true';
}

/** The slice of Trigger.dev's run context the guard reads. */
export interface ScheduledRunContext {
  environment: { type: string };
  task: { id: string };
}

/**
 * Call first in every `schedules.task` run: `if (!isScheduledRunAllowed({ ctx })) return ...`.
 * Logs why a run was skipped so a silent local schedule is explainable.
 */
export function isScheduledRunAllowed({
  ctx,
}: {
  ctx: ScheduledRunContext;
}): boolean {
  const environmentType = ctx.environment.type;
  if (shouldRunScheduledTask({ environmentType, env: process.env }))
    return true;
  logger.info(
    `Skipping scheduled run outside production; set ${RUN_SCHEDULES_IN_DEV_FLAG}=true to run schedules here`,
    { taskId: ctx.task.id, environmentType },
  );
  return false;
}
