import type { DaemonContext } from './context.ts';
import { attachTriggerDispatcher } from './services/automations/dispatcher.ts';
import type { HeadlessRunner } from './services/automations/headless.ts';
import { attachAutomationSchedules } from './services/automations/schedules.ts';
import { type AutomationServiceImpl, createAutomationService } from './services/automations/service.ts';
import { createSuggestionService, type SuggestionService } from './services/automations/suggestions.ts';
import { type CompareService, createCompareService } from './services/compare/compare.ts';
import type { Classifier } from './services/supervisor/classifier.ts';
import { createSupervisor, type SupervisorImpl } from './services/supervisor/supervisor.ts';

export interface Phase7Options {
  /** The headless `claude -p` runner. Production passes none; tests pass a fake so no real `claude` runs. */
  runner?: HeadlessRunner;
  /** The `git diff` of added lines that TODO suggestions read. Tests pass a fake. */
  addedLines?: (cwd: string, base: string) => Promise<string>;
  /** The supervisor's classifier. Production passes none (headless `claude -p`); tests pass a fake. */
  classifier?: Classifier;
}

export interface Phase7 {
  automations: AutomationServiceImpl;
  suggestions: SuggestionService;
  compare: CompareService;
  supervisor: SupervisorImpl;
  /**
   * Starts suggestion collection when `automations.suggestions.enabled` and the supervisor's
   * `session.statusChanged` listener when `supervisor.enabled`, and follows config changes. Idempotent.
   */
  start(): void;
  /** Detaches schedules, triggers, suggestions and the supervisor and drops queued runs. Idempotent. */
  stop(): void;
}

/**
 * Builds the Phase 7 services and sets `ctx.automations`, `ctx.suggestions`, `ctx.compare` and
 * `ctx.supervisor`; the routes in `registerAllRoutes` read them per request. Compare mode has no
 * switch of its own: it only runs when the user launches a comparison.
 *
 * Cron schedules and event triggers are attached only once `automations.enabled` is on — here,
 * when it is on at boot (before `ctx.scheduler.start()`, so overdue cron jobs have a handler), or
 * on the first `config.changed` that turns it on. While the master switch is off again, a fired
 * job or trigger starts nothing. Suggestion collection runs only while
 * `automations.suggestions.enabled` is on, and the supervisor listens for waiting sessions only
 * while `supervisor.enabled` is on.
 */
export function createPhase7(ctx: DaemonContext, o: Phase7Options = {}): Phase7 {
  const automations = createAutomationService({ ctx, runner: o.runner });
  ctx.automations = automations;
  const suggestions = createSuggestionService({ ctx, addedLines: o.addedLines });
  ctx.suggestions = suggestions;
  const compare = createCompareService({ ctx });
  ctx.compare = compare;
  const supervisor = createSupervisor({ ctx, classifier: o.classifier });
  ctx.supervisor = supervisor;

  const masterOn = () => ctx.config().automations.enabled;
  const gated: Pick<AutomationServiceImpl, 'list' | 'get' | 'start' | 'onChange'> = {
    list: () => automations.list(),
    get: (id) => automations.get(id),
    start: (id, fire) => (masterOn() ? automations.start(id, fire) : Promise.resolve(null)),
    onChange: (fn) => automations.onChange(fn),
  };

  const stops: Array<() => void> = [];
  let triggersAttached = false;
  const attachTriggers = () => {
    if (triggersAttached || !masterOn()) return;
    triggersAttached = true;
    if (ctx.scheduler) stops.push(attachAutomationSchedules(gated, ctx.scheduler));
    stops.push(attachTriggerDispatcher(ctx, gated));
  };

  let stopSuggestions: (() => void) | null = null;
  const syncSuggestions = () => {
    const on = ctx.config().automations.suggestions.enabled;
    if (on && !stopSuggestions) stopSuggestions = suggestions.start();
    else if (!on && stopSuggestions) {
      stopSuggestions();
      stopSuggestions = null;
    }
  };

  let stopSupervisor: (() => void) | null = null;
  const syncSupervisor = () => {
    const on = ctx.config().supervisor.enabled;
    if (on && !stopSupervisor) stopSupervisor = supervisor.start();
    else if (!on && stopSupervisor) {
      stopSupervisor();
      stopSupervisor = null;
    }
  };

  let started = false;
  let stopped = false;
  attachTriggers();

  return {
    automations,
    suggestions,
    compare,
    supervisor,
    start() {
      if (started || stopped) return;
      started = true;
      syncSuggestions();
      syncSupervisor();
      stops.push(
        ctx.bus.on('config.changed', () => {
          attachTriggers();
          syncSuggestions();
          syncSupervisor();
        }),
      );
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const stop of stops.splice(0)) stop();
      stopSuggestions?.();
      stopSuggestions = null;
      stopSupervisor?.();
      stopSupervisor = null;
      automations.stop();
    },
  };
}
