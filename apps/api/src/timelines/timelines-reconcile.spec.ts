import { TimelinesService } from './timelines.service';
import type { TimelinesLifecycleService } from './timelines-lifecycle.service';

const mockFrameworkFindMany = jest.fn();
const mockTimelineFindMany = jest.fn();
const mockPhaseUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@db', () => ({
  db: {
    frameworkInstance: {
      findMany: (...a: unknown[]) => mockFrameworkFindMany(...a),
    },
    timelineInstance: {
      findMany: (...a: unknown[]) => mockTimelineFindMany(...a),
    },
    timelinePhase: { update: (...a: unknown[]) => mockPhaseUpdate(...a) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
  TimelinePhaseStatus: {
    PENDING: 'PENDING',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
  },
}));

jest.mock('../frameworks/frameworks-scores.helper', () => ({
  getOverviewScores: jest.fn(),
}));

jest.mock('./timelines-backfill.helper', () => ({
  backfillTimeline: jest.fn(),
}));

jest.mock('./timelines-template-resolver', () => ({
  resolveTemplate: jest.fn(),
  createInstanceFromTemplate: jest.fn(),
}));

import { getOverviewScores } from '../frameworks/frameworks-scores.helper';

type PhaseStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';

type Phase = {
  id: string;
  orderIndex: number;
  status: PhaseStatus;
  completionType: string;
  completedAt: string | null;
  regressedAt: string | Date | null;
};

type Timeline = {
  id: string;
  organizationId: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  lockedAt: string | null;
  completedAt: string | null;
  phases: Phase[];
};

type PhaseUpdate = { where: { id: string }; data: Partial<Phase> };

const ORG = 'org_1';

const phase = (
  id: string,
  completionType: string,
  status: PhaseStatus,
  regressedAt: string | null = null,
): Phase => ({
  id,
  orderIndex: Number(id.slice(1)) - 1,
  status,
  completionType,
  completedAt: status === 'COMPLETED' ? '2026-01-10T00:00:00.000Z' : null,
  regressedAt,
});

const timeline = (
  phases: Phase[],
  status: Timeline['status'] = 'ACTIVE',
): Timeline => ({
  id: 'tli_1',
  organizationId: ORG,
  status,
  lockedAt: null,
  completedAt: null,
  phases,
});

/** Overview scores as percentages of 10 for policies, tasks and people. */
function liveScores(policies: number, tasks: number, people: number) {
  (getOverviewScores as jest.Mock).mockResolvedValue({
    policies: { total: 10, published: policies / 10 },
    tasks: { total: 10, done: tasks / 10 },
    people: { total: 10, completed: people / 10 },
  });
}

/**
 * Backs the mocked db with one mutable timeline, so a reconcile pass sees the
 * writes of the previous pass the way it would against Postgres.
 */
function setup(state: Timeline) {
  const clone = () => JSON.parse(JSON.stringify(state)) as Timeline;
  const applyPhaseUpdate = ({ where, data }: PhaseUpdate) => {
    const target = state.phases.find((p) => p.id === where.id);
    if (target) Object.assign(target, data);
    return Promise.resolve(target ?? null);
  };
  const tx = {
    timelinePhase: {
      findMany: jest.fn(() => Promise.resolve(clone().phases)),
      update: jest.fn(applyPhaseUpdate),
    },
    timelineInstance: {
      updateMany: jest.fn(() => {
        if (state.status !== 'COMPLETED') return Promise.resolve({ count: 0 });
        Object.assign(state, { status: 'ACTIVE', completedAt: null });
        return Promise.resolve({ count: 1 });
      }),
    },
  };

  mockFrameworkFindMany.mockResolvedValue([]);
  mockTimelineFindMany.mockImplementation(() => Promise.resolve([clone()]));
  mockPhaseUpdate.mockImplementation(applyPhaseUpdate);
  mockTransaction.mockImplementation(
    (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  );

  // Mirrors TimelinesLifecycleService.completePhase: complete, then start the next phase.
  const completePhase = jest.fn((_instanceId: string, phaseId: string) => {
    const done = state.phases.find((p) => p.id === phaseId);
    if (!done) return Promise.reject(new Error('phase not found'));
    done.status = 'COMPLETED';
    const next = state.phases.find((p) => p.orderIndex === done.orderIndex + 1);
    if (next) next.status = 'IN_PROGRESS';
    return Promise.resolve();
  });
  const lifecycle = { completePhase } as unknown as TimelinesLifecycleService;

  return { service: new TimelinesService(lifecycle), completePhase, state };
}

const statuses = (state: Timeline) => state.phases.map((p) => p.status);

describe('TimelinesService AUTO_* phase reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps GET a pure read: live percentages are overlaid, phases are not advanced', async () => {
    const { service, completePhase, state } = setup(
      timeline([phase('p1', 'AUTO_POLICIES', 'IN_PROGRESS')]),
    );
    liveScores(100, 100, 100);

    const result = await service.findAllForOrganization(ORG);

    expect(result[0].phases[0]).toEqual(
      expect.objectContaining({
        status: 'IN_PROGRESS',
        completionPercent: 100,
      }),
    );
    expect(completePhase).not.toHaveBeenCalled();
    expect(mockPhaseUpdate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(statuses(state)).toEqual(['IN_PROGRESS']);
  });

  it('cascades AUTO_* phase completions when live metrics are already 100%', async () => {
    const { service, completePhase, state } = setup(
      timeline([
        phase('p1', 'AUTO_POLICIES', 'IN_PROGRESS'),
        phase('p2', 'AUTO_TASKS', 'PENDING'),
        phase('p3', 'AUTO_PEOPLE', 'PENDING'),
        phase('p4', 'MANUAL', 'PENDING'),
      ]),
    );
    liveScores(100, 100, 100);

    await service.reconcileAutoPhasesForOrganization(ORG);

    expect(completePhase.mock.calls.map(([, phaseId]) => phaseId)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    expect(statuses(state)).toEqual([
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'IN_PROGRESS',
    ]);
    const [shown] = await service.findAllForOrganization(ORG);
    expect(shown.phases.map((p) => p.status)).toEqual(statuses(state));
  });

  it('does not auto-complete AUTO phases while a timeline is paused', async () => {
    const { service, completePhase, state } = setup(
      timeline([phase('p1', 'AUTO_POLICIES', 'IN_PROGRESS')], 'PAUSED'),
    );
    liveScores(100, 100, 100);

    await service.reconcileAutoPhasesForOrganization(ORG);

    expect(completePhase).not.toHaveBeenCalled();
    expect(statuses(state)).toEqual(['IN_PROGRESS']);
  });

  it('records regressedAt when a completed AUTO phase drops below 100%', async () => {
    const { service, state } = setup(
      timeline([phase('p1', 'AUTO_POLICIES', 'COMPLETED')]),
    );
    liveScores(80, 100, 100);

    await service.reconcileAutoPhasesForOrganization(ORG);

    expect(mockPhaseUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { regressedAt: expect.any(Date) },
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(statuses(state)).toEqual(['COMPLETED']);
    expect(state.phases[0].regressedAt).toBeTruthy();
  });

  it('re-opens AUTO_PEOPLE immediately when live people score drops below 100%', async () => {
    const { service, state } = setup(
      timeline([
        phase('p1', 'AUTO_PEOPLE', 'COMPLETED'),
        phase('p2', 'MANUAL', 'PENDING'),
      ]),
    );
    liveScores(100, 100, 50);

    await service.reconcileAutoPhasesForOrganization(ORG);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(statuses(state)).toEqual(['IN_PROGRESS', 'PENDING']);
    expect(state.phases[0].regressedAt).toBeNull();
  });

  it('re-opens a regressed AUTO phase after the 24-hour grace window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-15T00:00:00.000Z'));
    const { service, state } = setup(
      timeline([
        phase('p1', 'AUTO_POLICIES', 'COMPLETED', '2026-02-10T00:00:00.000Z'),
        phase('p2', 'MANUAL', 'COMPLETED'),
      ]),
    );
    liveScores(80, 100, 100);

    await service.reconcileAutoPhasesForOrganization(ORG);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(statuses(state)).toEqual(['IN_PROGRESS', 'PENDING']);
    expect(state.phases[0].regressedAt).toBeNull();
  });

  it('keeps a regressed AUTO phase completed inside the grace window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-02-10T12:00:00.000Z'));
    const { service, state } = setup(
      timeline([
        phase('p1', 'AUTO_POLICIES', 'COMPLETED', '2026-02-10T00:00:00.000Z'),
      ]),
    );
    liveScores(80, 100, 100);

    await service.reconcileAutoPhasesForOrganization(ORG);

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(statuses(state)).toEqual(['COMPLETED']);
  });
});
