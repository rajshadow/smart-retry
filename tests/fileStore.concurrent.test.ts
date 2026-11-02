import { FileStore } from '../src/fileStore';
import { FailedRequest } from '../src/types';
import fs from 'fs';
import path from 'path';

function request(id: string): FailedRequest {
  return {
    id,
    url: `https://example.com/${id}`,
    method: 'GET',
    error: 'Synthetic failure',
    attempts: 1,
    totalDuration: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('FileStore concurrent operations', () => {
  let directory: string;
  let logPath: string;
  let store: FileStore;

  function readIds(filePath = logPath): string[] {
    const logs: FailedRequest[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return logs.map((log) => log.id).sort();
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(__dirname, 'file-store-'));
    logPath = path.join(directory, 'failures.json');
    store = new FileStore(logPath);
  });

  afterEach(() => {
    // Only remove files and empty directories in this test's own temporary directory.
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) fs.rmdirSync(entryPath);
      else fs.unlinkSync(entryPath);
    }
    fs.rmdirSync(directory);
  });

  it('retains every concurrent save exactly once', async () => {
    const seed = request('seed');
    const requests = Array.from({ length: 10 }, (_, index) => request(`request-${index}`));
    await store.save(seed);

    // No timers or read barriers: all saves start before any is awaited.
    await Promise.all(requests.map((entry) => store.save(entry)));

    expect(readIds()).toEqual([seed, ...requests].map((entry) => entry.id).sort());
  });

  it('retains concurrent saves from separate instances sharing a file', async () => {
    const otherStore = new FileStore(path.relative(process.cwd(), logPath));
    await store.save(request('seed'));

    await Promise.all([store.save(request('first')), otherStore.save(request('second'))]);

    expect(readIds()).toEqual(['first', 'second', 'seed']);
  });

  it('removes every requested entry when removals start together', async () => {
    await store.save(request('first'));
    await store.save(request('second'));

    const removed = await Promise.all([store.remove('first'), store.remove('second')]);

    expect(removed).toEqual([true, true]);
    expect(readIds()).toEqual([]);
  });

  it('preserves a save followed by removal of an existing entry', async () => {
    await store.save(request('seed'));

    const [, removed] = await Promise.all([store.save(request('added')), store.remove('seed')]);

    expect(removed).toBe(true);
    expect(readIds()).toEqual(['added']);
  });

  it('does not resurrect an entry removed before a save', async () => {
    await store.save(request('seed'));

    const [removed] = await Promise.all([store.remove('seed'), store.save(request('added'))]);

    expect(removed).toBe(true);
    expect(readIds()).toEqual(['added']);
  });

  it('clears entries from a save started before clear', async () => {
    await store.save(request('seed'));

    await Promise.all([store.save(request('added')), store.clear()]);

    expect(readIds()).toEqual([]);
  });

  it('retains concurrent saves across rotation within the archive limit', async () => {
    // Rotate before every save; two archives leave room for all three records.
    store = new FileStore(logPath, { maxFileSizeBytes: 1, maxFiles: 2 });
    await store.save(request('seed'));

    await Promise.all([store.save(request('first')), store.save(request('second'))]);

    const files = fs.readdirSync(directory).sort();
    expect(files).toEqual(['failures.1.json', 'failures.2.json', 'failures.json']);
    const ids = files.flatMap((file) => readIds(path.join(directory, file))).sort();
    expect(ids).toEqual(['first', 'second', 'seed']);
  });

  it('continues saving after a filesystem failure', async () => {
    // Replacing the file with a directory causes real read/write failures.
    fs.unlinkSync(logPath);
    fs.mkdirSync(logPath);

    await expect(store.save(request('unwritable'))).resolves.toBeUndefined();
    await expect(store.remove('unwritable')).resolves.toBe(false);
    await expect(store.clear()).resolves.toBeUndefined();

    fs.rmdirSync(logPath);
    await store.save(request('recovered'));

    expect(readIds()).toEqual(['recovered']);
  });
});
