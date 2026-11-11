import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { detectFormat, sanitizeFileName, UploadError } from '../src/data/files/ingest';
import { PostgresFileSourceRegistry } from '../src/data/files/postgres-registry';
import { JsonFileSourceRegistry, MemoryFileSourceRegistry } from '../src/data/files/registry';
import { buildProfile, statsFromRows } from '../src/data/profile';
import { record, registryContract } from './contracts';

registryContract('memory', async () => new MemoryFileSourceRegistry());

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
registryContract('json manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bi-registry-'));
  dirs.push(dir);
  return new JsonFileSourceRegistry(dir);
});

it('the JSON manifest persists across instances and serializes concurrent writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bi-registry-'));
  dirs.push(dir);
  const first = new JsonFileSourceRegistry(dir);
  await Promise.all(Array.from({ length: 10 }, (_, i) => first.put(record({ id: `file_${String(i).padStart(24, '0')}` }))));
  const second = new JsonFileSourceRegistry(dir);
  expect(await second.list('t1')).toHaveLength(10);
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DATABASE_URL)('postgres', () => {
  const registries: PostgresFileSourceRegistry[] = [];
  afterAll(async () => {
    await Promise.all(registries.map((r) => r.close()));
  });
  registryContract('postgres', async () => {
    const registry = await PostgresFileSourceRegistry.connect(TEST_DATABASE_URL!);
    registries.push(registry);
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query('TRUNCATE file_sources');
    await pool.end();
    return registry;
  });
});

describe('upload validation helpers', () => {
  it('sanitizes file names', () => {
    expect(sanitizeFileName('../../etc/passwd.csv')).toBe('passwd.csv');
    expect(sanitizeFileName('C:\\Users\\me\\Q1 sales.xlsx')).toBe('Q1 sales.xlsx');
    expect(sanitizeFileName('a\u0000b\nc<>.csv')).toBe('abc.csv');
    expect(sanitizeFileName('..')).toBe('upload');
    expect(sanitizeFileName('x'.repeat(500) + '.csv')).toHaveLength(200);
  });

  it('checks extension and content together', () => {
    const text = new TextEncoder().encode('a,b\n1,2\n');
    expect(detectFormat('A.CSV', text)).toBe('csv');
    expect(detectFormat('book.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]))).toBe('xlsx');
    expect(() => detectFormat('a.csv', new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(UploadError);
    expect(() => detectFormat('a.csv', new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/);
    expect(() => detectFormat('a.exe', text)).toThrow(/Only .csv and .xlsx/);
  });
});

describe('profiler classification', () => {
  it('handles empty, prose, currency-text and calendar columns', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      empty: null,
      comment: `Customer ${i} said the delivery was quite late this time`,
      price_text: `$${(i % 7) + 1},000.00`,
      year: 2020 + (i % 5),
      email: `user${i}@example.com`,
      userId: i % 3,
      conversion_rate: i / 1500,
    }));
    const profile = buildProfile({ type: 'sample', ref: 'x' }, statsFromRows(rows, Object.keys(rows[0]!)));
    const by = Object.fromEntries(profile.columns.map((c) => [c.name, c]));
    expect(by.empty).toMatchObject({ role: 'ignore', nullRate: 1, distinctCount: 0, sampleValues: [] });
    expect(by.comment).toMatchObject({ semanticType: 'text', role: 'ignore', cardinality: 'unique' });
    expect(by.price_text).toMatchObject({ semanticType: 'categorical', format: 'currency' });
    expect(by.year).toMatchObject({ semanticType: 'categorical', role: 'dimension', format: 'integer' });
    expect(by.email).toMatchObject({ semanticType: 'id', role: 'key', cardinality: 'unique' });
    expect(by.userId).toMatchObject({ semanticType: 'id', role: 'dimension', cardinality: 'low' });
    expect(by.conversion_rate).toMatchObject({ semanticType: 'numeric', role: 'measure', format: 'percent', min: 0 });
    expect(profile.keyCandidates).toEqual(['email']);
    expect(profile.measureCandidates).toEqual(['conversion_rate']);
    expect(profile.dimensionCandidates).toEqual(['price_text', 'year', 'userId']);
  });
});
