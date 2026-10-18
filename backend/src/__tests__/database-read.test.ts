import { createPool } from 'mysql2/promise';
import config from '../config';
import DB from '../database';

jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('bounded analytics reads', () => {
  const originalTimeout = config.DATABASE.TIMEOUT;
  let connection: { query: jest.Mock; release: jest.Mock; destroy: jest.Mock };
  let pool: { getConnection: jest.Mock; on: jest.Mock; end: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    config.DATABASE.TIMEOUT = 180_000;
    connection = { query: jest.fn(), release: jest.fn(), destroy: jest.fn() };
    pool = { getConnection: jest.fn().mockResolvedValue(connection), on: jest.fn(), end: jest.fn() };
    (createPool as jest.Mock).mockReturnValue(pool);
  });

  afterEach(async () => {
    await DB.close();
    config.DATABASE.TIMEOUT = originalTimeout;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('preserves results and bindings, bounds SQL on the server, and releases a successful connection', async () => {
    const result = [[{ blockCount: 42 }], []];
    connection.query.mockResolvedValue(result);

    expect(await DB.queryRead('SELECT COUNT(*) AS blockCount FROM blocks WHERE pool_id = ?', [10])).toBe(result);
    expect(connection.query).toHaveBeenCalledWith(
      'SET STATEMENT max_statement_time=60 FOR SELECT COUNT(*) AS blockCount FROM blocks WHERE pool_id = ?', [10],
    );
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('expires queued work without executing it when a connection becomes available later', async () => {
    const pendingConnection = deferred<typeof connection>();
    pool.getConnection.mockReturnValue(pendingConnection.promise);
    const read = DB.queryRead('SELECT 1', [], 50);
    const rejection = expect(read).rejects.toThrow('DB read exceeded 0.05s');

    await jest.advanceTimersByTimeAsync(50);
    await rejection;
    pendingConnection.resolve(connection);
    await jest.advanceTimersByTimeAsync(0);

    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  test('deducts time spent waiting for a connection from the server deadline', async () => {
    const pendingConnection = deferred<typeof connection>();
    pool.getConnection.mockReturnValue(pendingConnection.promise);
    connection.query.mockResolvedValue([[], []]);
    const read = DB.queryRead('SELECT 1', [], 1000);
    await jest.advanceTimersByTimeAsync(250);
    pendingConnection.resolve(connection);
    await read;

    expect(connection.query).toHaveBeenCalledWith('SET STATEMENT max_statement_time=0.75 FOR SELECT 1', []);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  test('destroys a timed-out active connection instead of returning unfinished work to the pool', async () => {
    const pendingQuery = deferred<any>();
    connection.query.mockReturnValue(pendingQuery.promise);
    const read = DB.queryRead('SELECT 1', [], 50);
    const rejection = expect(read).rejects.toThrow('DB read exceeded 0.05s');
    await jest.advanceTimersByTimeAsync(50);
    await rejection;

    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(connection.release).not.toHaveBeenCalled();
    // The driver's later rejection must be handled without releasing the destroyed connection.
    pendingQuery.reject(new Error('Connection closed'));
    await jest.advanceTimersByTimeAsync(0);
    expect(connection.release).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('propagates server errors and releases a connection after the server stops the statement', async () => {
    const timeout = Object.assign(new Error('Query execution was interrupted'), { errno: 1969 });
    connection.query.mockRejectedValue(timeout);
    await expect(DB.queryRead('SELECT 1')).rejects.toBe(timeout);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('propagates acquisition errors without leaving a timer running', async () => {
    const error = new Error('Connection refused');
    pool.getConnection.mockRejectedValue(error);
    await expect(DB.queryRead('SELECT 1')).rejects.toBe(error);
    await jest.advanceTimersByTimeAsync(0);
    expect(connection.query).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([[5000, 5], [0, 60], [-1, 60]])('uses a bounded default with DATABASE.TIMEOUT=%s', async (configured, seconds) => {
    config.DATABASE.TIMEOUT = configured;
    connection.query.mockResolvedValue([[], []]);
    await DB.queryRead('SELECT 1');
    expect(connection.query).toHaveBeenCalledWith(`SET STATEMENT max_statement_time=${seconds} FOR SELECT 1`, undefined);
  });

  test('rejects writes and invalid deadlines before acquiring a connection', async () => {
    await expect(DB.queryRead('UPDATE blocks SET stale = 1')).rejects.toThrow('requires a SELECT');
    await expect(DB.queryRead('SELECT 1', [], 0)).rejects.toThrow('positive timeout');
    await expect(DB.queryRead('SELECT 1', [], Infinity)).rejects.toThrow('positive timeout');
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
});
