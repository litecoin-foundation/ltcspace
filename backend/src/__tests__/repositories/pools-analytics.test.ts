import DB from '../../database';
import poolsRepository from '../../repositories/PoolsRepository';

jest.mock('../../database', () => ({ query: jest.fn(), queryRead: jest.fn() }));
jest.mock('../../api/pools-parser', () => ({}));
jest.mock('../../api/transaction-utils', () => ({}));

describe('pool analytics caching', () => {
  const queryRead = DB.queryRead as jest.Mock;
  const rows = [{ poolId: 10, name: 'Example', blockCount: 42, avgMatchRate: null, avgFeeDelta: -0.1 }];

  beforeEach(() => {
    jest.useFakeTimers();
    (poolsRepository as any).poolsInfoCache.clear();
    queryRead.mockReset().mockResolvedValue([rows, []]);
  });

  afterEach(() => jest.useRealTimers());

  test('shares one in-flight query across concurrent callers and isolates returned rows', async () => {
    let finish!: (result: any) => void;
    queryRead.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const requests = Array.from({ length: 25 }, () => poolsRepository.$getPoolsInfo('1m'));
    expect(queryRead).toHaveBeenCalledTimes(1);
    finish([rows, []]);
    const results = await Promise.all(requests);
    results[0][0].blockCount = 999;
    results[0].pop();
    expect(results[1]).toEqual(rows);
    expect(await poolsRepository.$getPoolsInfo('1m')).toEqual(rows);
    expect(queryRead).toHaveBeenCalledTimes(1);
  });

  test('starts the 60-second TTL on completion and coalesces the next refresh', async () => {
    let finish!: (result: any) => void;
    queryRead.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = poolsRepository.$getPoolsInfo('1m');
    await jest.advanceTimersByTimeAsync(50_000);
    const waiting = poolsRepository.$getPoolsInfo('1m');
    expect(queryRead).toHaveBeenCalledTimes(1);
    finish([rows, []]);
    await Promise.all([first, waiting]);
    await jest.advanceTimersByTimeAsync(59_999);
    await poolsRepository.$getPoolsInfo('1m');
    expect(queryRead).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([poolsRepository.$getPoolsInfo('1m'), poolsRepository.$getPoolsInfo('1m')]);
    expect(queryRead).toHaveBeenCalledTimes(2);
  });

  test('evicts failed queries so a later request can recover', async () => {
    const error = new Error('Query execution was interrupted');
    queryRead.mockRejectedValueOnce(error);
    const results = await Promise.allSettled([poolsRepository.$getPoolsInfo('1m'), poolsRepository.$getPoolsInfo('1m')]);
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(queryRead).toHaveBeenCalledTimes(1);
    expect(await poolsRepository.$getPoolsInfo('1m')).toEqual(rows);
    expect(queryRead).toHaveBeenCalledTimes(2);
  });

  test('normalizes unsupported intervals into one all-time cache entry', async () => {
    await Promise.all([null, 'all', 'invalid', '1m', '1y'].map(interval => poolsRepository.$getPoolsInfo(interval)));
    expect(queryRead).toHaveBeenCalledTimes(3);
    expect((poolsRepository as any).poolsInfoCache.size).toBe(3);
  });

  test('keeps the existing aggregate formulas, audit join, filtering, and ordering', async () => {
    await poolsRepository.$getPoolsInfo('1m');
    const sql = queryRead.mock.calls[0][0] as string;
    expect(sql).toContain('FROM blocks FORCE INDEX (blockTimestamp)');
    expect(sql).toContain('STRAIGHT_JOIN pools');
    // Removing only optimizer hints must leave the original query unchanged.
    const withoutHints = sql.replace('FORCE INDEX (blockTimestamp)', '').replace('STRAIGHT_JOIN', 'JOIN');
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    expect(normalize(withoutHints)).toBe(normalize(`
      SELECT COUNT(blocks.height) As blockCount, pool_id AS poolId,
        pools.name AS name, pools.link AS link, slug,
        AVG(blocks_audits.match_rate) AS avgMatchRate,
        AVG((CAST(blocks.fees as SIGNED) - CAST(blocks_audits.expected_fees as SIGNED)) / NULLIF(CAST(blocks_audits.expected_fees as SIGNED), 0)) AS avgFeeDelta,
        unique_id as poolUniqueId
      FROM blocks JOIN pools on pools.id = pool_id
      LEFT JOIN blocks_audits ON blocks_audits.height = blocks.height
      WHERE blocks.stale = 0
        AND blocks.blockTimestamp BETWEEN DATE_SUB(NOW(), INTERVAL 1 MONTH) AND NOW()
      GROUP BY pool_id ORDER BY COUNT(blocks.height) DESC
    `));
  });

  test('does not force a timestamp range scan for all-time statistics', async () => {
    await poolsRepository.$getPoolsInfo();
    const sql = queryRead.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/FORCE INDEX|STRAIGHT_JOIN|DATE_SUB/);
    expect(sql).toContain('JOIN pools');
  });
});
