import { TimelinesService } from './timelines.service';
import { BadRequestException } from '@nestjs/common';
import type { TimelinesLifecycleService } from './timelines-lifecycle.service';

const mockFrameworkFindMany = jest.fn();
const mockTimelineFindMany = jest.fn();
const mockTimelineFindFirst = jest.fn();
const mockTemplateFindUnique = jest.fn();
const mockTransaction = jest.fn();

jest.mock('@db', () => ({
  db: {
    frameworkInstance: {
      findMany: (...a: unknown[]) => mockFrameworkFindMany(...a),
    },
    timelineInstance: {
      findMany: (...a: unknown[]) => mockTimelineFindMany(...a),
      findFirst: (...a: unknown[]) => mockTimelineFindFirst(...a),
      deleteMany: jest.fn(),
    },
    timelineTemplate: {
      findUnique: (...a: unknown[]) => mockTemplateFindUnique(...a),
    },
    timelinePhase: { deleteMany: jest.fn() },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
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

import { createInstanceFromTemplate } from './timelines-template-resolver';
import { backfillTimeline } from './timelines-backfill.helper';

type Found = Awaited<ReturnType<TimelinesService['findOne']>>;
type Created = Awaited<ReturnType<TimelinesService['createFromTemplate']>>;
// Partial rows: each case sets only the fields the code under test reads.
const found = (row: object) => row as unknown as Found;
const created = (row: object) => row as unknown as Created;

// These cases never reach the lifecycle service; it is a bare stand-in.
const makeService = () =>
  new TimelinesService({} as unknown as TimelinesLifecycleService);

describe('TimelinesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects starting next cycle when current timeline is not completed', async () => {
    const service = makeService();

    jest.spyOn(service, 'findOne').mockResolvedValue(
      found({
        id: 'tli_1',
        frameworkInstanceId: 'fi_1',
        cycleNumber: 1,
        status: 'ACTIVE',
      }),
    );

    await expect(service.startNextCycle('tli_1', 'org_1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects starting next cycle when next cycle already exists', async () => {
    const service = makeService();

    jest.spyOn(service, 'findOne').mockResolvedValue(
      found({
        id: 'tli_1',
        frameworkInstanceId: 'fi_1',
        cycleNumber: 2,
        status: 'COMPLETED',
      }),
    );
    mockTimelineFindFirst.mockResolvedValue({
      id: 'existing_cycle_3',
    });

    await expect(service.startNextCycle('tli_1', 'org_1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('creates next cycle from template when eligible', async () => {
    const service = makeService();

    jest.spyOn(service, 'findOne').mockResolvedValue(
      found({
        id: 'tli_1',
        frameworkInstanceId: 'fi_1',
        cycleNumber: 2,
        status: 'COMPLETED',
      }),
    );
    mockTimelineFindFirst.mockResolvedValue(null);

    const createSpy = jest
      .spyOn(service, 'createFromTemplate')
      .mockResolvedValue(created({ id: 'tli_3', cycleNumber: 3 }));

    const result = await service.startNextCycle('tli_1', 'org_1');

    expect(createSpy).toHaveBeenCalledWith({
      organizationId: 'org_1',
      frameworkInstanceId: 'fi_1',
      cycleNumber: 3,
      trackKey: 'primary',
    });
    expect(result).toEqual({ id: 'tli_3', cycleNumber: 3 });
  });

  it('uses explicit template progression when current template defines nextTemplateKey', async () => {
    const service = makeService();

    jest.spyOn(service, 'findOne').mockResolvedValue(
      found({
        id: 'tli_2',
        frameworkInstanceId: 'fi_1',
        cycleNumber: 2,
        trackKey: 'soc2_type2',
        status: 'COMPLETED',
        template: {
          id: 'tml_soc2_y1',
          frameworkId: 'frk_soc2',
          trackKey: 'soc2_type2',
          templateKey: 'soc2_type2_year1',
          nextTemplateKey: 'soc2_type2_renewal',
        },
      }),
    );

    mockTimelineFindFirst.mockResolvedValue(null);
    mockTemplateFindUnique.mockResolvedValue({
      id: 'tml_soc2_renewal',
      phases: [],
    });
    (createInstanceFromTemplate as jest.Mock).mockResolvedValue({
      id: 'tli_3',
      cycleNumber: 3,
    });

    const createSpy = jest
      .spyOn(service, 'createFromTemplate')
      .mockResolvedValue(created({ id: 'fallback', cycleNumber: 3 }));

    const result = await service.startNextCycle('tli_2', 'org_1');

    expect(mockTemplateFindUnique).toHaveBeenCalledWith({
      where: {
        frameworkId_templateKey: {
          frameworkId: 'frk_soc2',
          templateKey: 'soc2_type2_renewal',
        },
      },
      include: { phases: { orderBy: { orderIndex: 'asc' } } },
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ id: 'tli_3', cycleNumber: 3 }),
    );
  });

  it('checks for existing next cycle within the same track only', async () => {
    const service = makeService();

    jest.spyOn(service, 'findOne').mockResolvedValue(
      found({
        id: 'tli_type2_1',
        frameworkInstanceId: 'fi_1',
        cycleNumber: 1,
        trackKey: 'soc2_type2',
        status: 'COMPLETED',
        template: {
          id: 'tml_soc2_type2_y1',
          frameworkId: 'frk_soc2',
          trackKey: 'soc2_type2',
          templateKey: 'soc2_type2_year1',
          nextTemplateKey: 'soc2_type2_renewal',
        },
      }),
    );
    mockTimelineFindFirst.mockResolvedValue(null);
    mockTemplateFindUnique.mockResolvedValue({
      id: 'tml_soc2_renewal',
      trackKey: 'soc2_type2',
      phases: [],
    });
    (createInstanceFromTemplate as jest.Mock).mockResolvedValue({
      id: 'tli_type2_2',
      cycleNumber: 2,
      trackKey: 'soc2_type2',
    });

    await service.startNextCycle('tli_type2_1', 'org_1');

    expect(mockTimelineFindFirst).toHaveBeenCalledWith({
      where: {
        frameworkInstanceId: 'fi_1',
        trackKey: 'soc2_type2',
        cycleNumber: 2,
      },
    });
  });

  it('resets timeline instance and phases back to draft baseline', async () => {
    const service = makeService();

    const tx = {
      timelinePhase: { update: jest.fn() },
      timelineInstance: { update: jest.fn() },
    };
    mockTransaction.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx),
    );

    const refreshed = { id: 'tli_1', status: 'DRAFT' };
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValueOnce(
        found({
          id: 'tli_1',
          phases: [{ id: 'p1' }, { id: 'p2' }],
        }),
      )
      .mockResolvedValueOnce(found(refreshed));

    const result = await service.resetInstance('tli_1', 'org_1');

    expect(tx.timelinePhase.update).toHaveBeenCalledTimes(2);
    expect(tx.timelinePhase.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ regressedAt: null }),
    });
    expect(tx.timelineInstance.update).toHaveBeenCalledWith({
      where: { id: 'tli_1' },
      data: {
        status: 'DRAFT',
        startDate: null,
        pausedAt: null,
        lockedAt: null,
        lockedById: null,
        unlockedAt: null,
        unlockedById: null,
        unlockReason: null,
        completedAt: null,
      },
    });
    expect(result).toEqual(refreshed);
  });

  it('recreate clears grace periods by bypassing regression grace on refresh', async () => {
    const service = makeService();

    mockTimelineFindMany.mockResolvedValue([{ id: 'tli_1' }]);
    mockFrameworkFindMany.mockResolvedValue([
      {
        id: 'fi_1',
        frameworkId: 'frk_1',
        framework: { id: 'frk_1', name: 'SOC 2' },
        timelineInstances: [],
      },
    ]);

    const reconcileSpy = jest
      .spyOn(service, 'reconcileAutoPhasesForOrganization')
      .mockResolvedValue(undefined);
    const findAllSpy = jest
      .spyOn(service, 'findAllForOrganization')
      .mockResolvedValue([]);

    await service.recreateAllForOrganization('org_1');

    expect(backfillTimeline).toHaveBeenCalledWith({
      organizationId: 'org_1',
      frameworkInstance: expect.objectContaining({ id: 'fi_1' }),
      forceRefresh: true,
    });
    expect(reconcileSpy).toHaveBeenCalledWith('org_1', {
      bypassRegressionGrace: true,
    });
    // The refreshed list is read only after the reconcile pass has run.
    expect(reconcileSpy.mock.invocationCallOrder[0]).toBeLessThan(
      findAllSpy.mock.invocationCallOrder[0],
    );
    expect(findAllSpy).toHaveBeenLastCalledWith('org_1');
  });
});
