import DB from '../../database';
import blocksRepository from '../../repositories/BlocksRepository';
import poolsRepository from '../../repositories/PoolsRepository';

jest.mock('../../database', () => ({ query: jest.fn(), queryRead: jest.fn() }));
jest.mock('../../repositories/PoolsRepository', () => ({ $getPool: jest.fn() }));
jest.mock('../../repositories/HashratesRepository', () => ({}));
jest.mock('../../repositories/BlocksSummariesRepository', () => ({}));
jest.mock('../../repositories/DifficultyAdjustmentsRepository', () => ({}));
jest.mock('../../repositories/BlocksAuditsRepository', () => ({ $getBlockAuditScore: jest.fn().mockResolvedValue(null) }));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({}));
jest.mock('../../api/bitcoin/bitcoin-client', () => ({}));
jest.mock('../../api/chain-tips', () => ({ getOrphanedBlocksAtHeight: jest.fn().mockReturnValue([]) }));
jest.mock('../../api/blocks', () => ({}));
jest.mock('../../api/transaction-utils', () => ({}));
jest.mock('../../tasks/pools-updater', () => ({}));

describe('block analytics reads', () => {
  const queryRead = DB.queryRead as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    queryRead.mockReset();
    (poolsRepository.$getPool as jest.Mock).mockResolvedValue({ id: 10 });
  });

  test('keeps global counts fresh for indexing and includes only canonical blocks', async () => {
    queryRead.mockResolvedValueOnce([[{ blockCount: 42 }], []]).mockResolvedValueOnce([[{ blockCount: 43 }], []]);
    expect(await blocksRepository.$blockCount(null)).toBe(42);
    expect(await blocksRepository.$blockCount(null)).toBe(43);
    const [sql, params] = queryRead.mock.calls[0];
    expect(sql.replace(/\s+/g, ' ').trim()).toBe('SELECT COUNT(*) as blockCount FROM blocks WHERE stale = 0');
    expect(params).toEqual([]);
  });

  test('retains pool and normalized time filters on counts', async () => {
    queryRead.mockResolvedValue([[{ blockCount: 0 }], []]);
    expect(await blocksRepository.$blockCount(10, '1m')).toBe(0);
    expect(queryRead).toHaveBeenCalledWith(expect.stringContaining(
      'WHERE stale = 0 AND pool_id = ? AND blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL 1 MONTH) AND NOW()',
    ), [10]);
  });

  test.each([undefined, 500, 0])('preserves pool history pagination and block formatting for cursor %s', async cursor => {
    queryRead.mockResolvedValue([[{
      id: 'block-hash', height: 100, poolId: 10, poolName: 'Example', poolSlug: 'example',
      feeRange: '[1,2]', feePercentiles: '[1,2,3,4,5,6,7]', medianFeeAmt: 4, weight: 4000,
    }], []]);
    const result = await blocksRepository.$getBlocksByPool('example', cursor);
    const [sql, params] = queryRead.mock.calls[0];
    expect(params).toEqual(cursor === undefined ? [10] : [10, cursor]);
    expect(sql).toContain('WHERE pool_id = ? AND stale = 0');
    expect(sql.includes('AND height < ?')).toBe(cursor !== undefined);
    expect(sql.replace(/\s+/g, ' ')).toContain('ORDER BY height DESC LIMIT 100');
    expect(result[0]).toMatchObject({
      id: 'block-hash', height: 100,
      extras: { feeRange: [1, 2], virtualSize: 1000, pool: { id: 10, name: 'Example', slug: 'example' } },
    });
  });

  test('rejects unknown pools before running the block query', async () => {
    (poolsRepository.$getPool as jest.Mock).mockResolvedValue(null);
    await expect(blocksRepository.$getBlocksByPool('missing')).rejects.toThrow('This mining pool does not exist');
    expect(queryRead).not.toHaveBeenCalled();
  });
});
