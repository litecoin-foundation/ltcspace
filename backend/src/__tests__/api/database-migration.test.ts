import config from '../../config';
import DB from '../../database';
import { Common } from '../../api/common';
import migration from '../../api/database-migration';

jest.mock('../../database', () => ({ query: jest.fn() }));
jest.mock('../../repositories/BlocksRepository', () => ({}));
jest.mock('../../repositories/CpfpRepository', () => ({}));
jest.mock('../../api/transaction-utils', () => ({}));

describe('pool history index migration', () => {
  const originalNetwork = config.MEMPOOL.NETWORK;
  let schemaVersion: number;
  let statements: string[];

  beforeEach(() => {
    schemaVersion = 106;
    statements = [];
    config.MEMPOOL.NETWORK = 'mainnet';
    (DB.query as jest.Mock).mockReset().mockImplementation(async ({ sql, timeout }) => {
      statements.push(sql);
      expect(timeout).toBe(3600_000); // Analytics deadlines must not apply to DDL.
      if (sql.includes('SELECT VERSION()')) {
        return [[{ version: '10.11.14-MariaDB' }], []];
      }
      if (sql.includes('information_schema.tables')) {
        return [[{ 'COUNT(*)': 1 }], []];
      }
      if (sql.startsWith('SELECT number FROM state')) {
        return [[{ number: schemaVersion }], []];
      }
      if (sql.startsWith('UPDATE state SET number = 107')) {
        schemaVersion = 107;
      }
      return [[], []];
    });
  });

  afterEach(() => {
    config.MEMPOOL.NETWORK = originalNetwork;
    jest.restoreAllMocks();
  });

  test.each(['mainnet', 'testnet'] as const)('adds only the new index before advancing %s to 107, then skips reruns', async network => {
    config.MEMPOOL.NETWORK = network;
    await migration.$initializeOrMigrateDatabase();
    const indexStatement = statements.findIndex(sql => sql.includes('ADD INDEX IF NOT EXISTS pool_stale_height'));
    expect(indexStatement).toBeGreaterThan(-1);
    expect(statements[indexStatement]).toMatch(/\(pool_id, stale, height\)/);
    expect(statements[indexStatement]).toContain('ALGORITHM=INPLACE, LOCK=NONE');
    expect(statements.findIndex(sql => sql.startsWith('UPDATE state SET number = 107'))).toBeGreaterThan(indexStatement);
    expect(statements.filter(sql => /^ALTER|^DROP|^TRUNCATE|^DELETE|^INSERT/i.test(sql))).toEqual([statements[indexStatement]]);
    expect(schemaVersion).toBe(107);

    statements.length = 0;
    await migration.$initializeOrMigrateDatabase();
    expect(statements.some(sql => /^ALTER|^UPDATE/i.test(sql))).toBe(false);
  });

  test('leaves the version unchanged if the index fails and allows a later retry', async () => {
    const execute = (DB.query as jest.Mock).getMockImplementation()!;
    (DB.query as jest.Mock).mockImplementation(async options => {
      if (options.sql.includes('ADD INDEX IF NOT EXISTS pool_stale_height')) {
        throw new Error('Index creation failed');
      }
      return execute(options);
    });
    jest.spyOn(Common, 'sleep$').mockResolvedValue(undefined);
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Migration aborted'); });

    await expect(migration.$initializeOrMigrateDatabase()).rejects.toThrow('Migration aborted');
    expect(exit).toHaveBeenCalledWith(-1);
    expect(schemaVersion).toBe(106);
    expect(statements.some(sql => sql.startsWith('UPDATE state'))).toBe(false);

    (DB.query as jest.Mock).mockImplementation(execute);
    await migration.$initializeOrMigrateDatabase();
    expect(schemaVersion).toBe(107);
  });

  test('does not add the mining pool index to a Liquid database', async () => {
    config.MEMPOOL.NETWORK = 'liquid';
    await migration.$initializeOrMigrateDatabase();
    expect(statements.some(sql => sql.includes('pool_stale_height'))).toBe(false);
    expect(schemaVersion).toBe(107);
  });
});
