import { QuerySchema, type QueryInput } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/data/engine';
import { compileQuery, type Relation } from '../src/data/sql/compile';
import { duckdb, duckdbKind, quoteIdent, snowflake, snowflakeKind, type ColumnKind, type Dialect } from '../src/data/sql/dialect';

const columns = new Map<string, ColumnKind>([
  ['order_date', 'date'],
  ['created_at', 'timestamp'],
  ['region', 'string'],
  ['amount', 'number'],
  ['quantity', 'integer'],
  ['vip', 'boolean'],
  ['customer_id', 'string'],
  ['payload', 'other'],
  ['we"ird', 'string'],
]);

const compile = (dialect: Dialect, q: Omit<QueryInput, 'source'>, relation: Relation = { sql: '"DB"."S"."ORDERS"', params: [] }) =>
  compileQuery(QuerySchema.parse({ source: 's', ...q }), { dialect, relation, columns });

const revenueByMonth: Omit<QueryInput, 'source'> = {
  dimensions: [{ field: 'order_date', grain: 'month' }, { field: 'region' }],
  measures: [
    { field: 'amount', agg: 'sum', as: 'revenue' },
    { field: '*', agg: 'count' },
    { field: 'customer_id', agg: 'count_distinct' },
  ],
  filters: [
    { field: 'order_date', op: 'gte', value: '2026-01-01' },
    { field: 'region', op: 'in', value: ['EU', null, 'NA'] },
    { field: 'vip', op: 'eq', value: true },
  ],
  orderBy: [{ field: 'revenue', dir: 'desc' }],
  limit: 100,
};

describe('compileQuery — snapshots', () => {
  it('DuckDB', () => {
    const out = compile(duckdb, revenueByMonth, { sql: 'read_parquet(?)', params: ['/data/files/file_x.parquet'] });
    expect(out.sql).toBe(
      [
        `SELECT strftime(date_trunc('month', "order_date"), '%Y-%m-%d') AS "order_date", "region" AS "region", round(CAST(sum("amount") AS DOUBLE), 6) AS "revenue", count(*) AS "count", count(DISTINCT "customer_id") AS "count_distinct_customer_id"`,
        'FROM read_parquet(?)',
        `WHERE "order_date" >= CAST(? AS DATE) AND "region" IN (?, ?) AND "vip" = ?`,
        'GROUP BY 1, 2',
        'ORDER BY 3 DESC NULLS LAST, 1 ASC NULLS LAST, 2 ASC NULLS LAST',
        'LIMIT 101',
      ].join('\n'),
    );
    expect(out.params).toEqual(['/data/files/file_x.parquet', '2026-01-01', 'EU', 'NA', true]);
    expect(out.columns).toEqual([
      { name: 'order_date', type: 'time', grain: 'month' },
      { name: 'region', type: 'string' },
      { name: 'revenue', type: 'number' },
      { name: 'count', type: 'number' },
      { name: 'count_distinct_customer_id', type: 'number' },
    ]);
    expect(out.limit).toBe(100);
  });

  it('Snowflake', () => {
    const out = compile(snowflake, revenueByMonth);
    expect(out.sql).toBe(
      [
        `SELECT TO_CHAR(DATE_TRUNC('MONTH', "order_date"), 'YYYY-MM-DD') AS "order_date", "region" AS "region", round(CAST(sum("amount") AS DOUBLE), 6) AS "revenue", count(*) AS "count", count(DISTINCT "customer_id") AS "count_distinct_customer_id"`,
        'FROM "DB"."S"."ORDERS"',
        `WHERE "order_date" >= CAST(? AS DATE) AND "region" IN (?, ?) AND "vip" = ?`,
        'GROUP BY 1, 2',
        'ORDER BY 3 DESC NULLS LAST, 1 ASC NULLS LAST, 2 ASC NULLS LAST',
        'LIMIT 101',
      ].join('\n'),
    );
    expect(out.params).toEqual(['2026-01-01', 'EU', 'NA', true]);
  });

  it('time grains per dialect (ISO weeks start Monday)', () => {
    const grain = (dialect: Dialect, g: 'day' | 'week' | 'quarter' | 'year', field = 'order_date') =>
      compile(dialect, { dimensions: [{ field, grain: g }] }).sql.split('\n')[0];
    expect(grain(duckdb, 'week')).toBe(`SELECT strftime(date_trunc('week', "order_date"), '%Y-%m-%d') AS "order_date"`);
    expect(grain(snowflake, 'week')).toBe(
      `SELECT TO_CHAR(DATEADD('day', 1 - DAYOFWEEKISO("order_date"), DATE_TRUNC('DAY', "order_date")), 'YYYY-MM-DD') AS "order_date"`,
    );
    expect(grain(snowflake, 'quarter', 'created_at')).toBe(`SELECT TO_CHAR(DATE_TRUNC('QUARTER', "created_at"), 'YYYY-MM-DD') AS "created_at"`);
    expect(grain(duckdb, 'year')).toBe(`SELECT strftime(date_trunc('year', "order_date"), '%Y-%m-%d') AS "order_date"`);
  });

  it('every filter op', () => {
    const where = (filters: QueryInput['filters']) => {
      const out = compile(duckdb, { measures: [{ field: '*', agg: 'count' }], filters });
      return { where: out.sql.split('\n').find((l) => l.startsWith('WHERE')), params: out.params };
    };
    expect(where([{ field: 'amount', op: 'neq', value: 5 }])).toEqual({ where: 'WHERE "amount" <> ?', params: [5] });
    expect(where([{ field: 'amount', op: 'gt', value: 1 }, { field: 'amount', op: 'lte', value: 9 }])).toEqual({ where: 'WHERE "amount" > ? AND "amount" <= ?', params: [1, 9] });
    expect(where([{ field: 'quantity', op: 'lt', value: 3 }])).toEqual({ where: 'WHERE "quantity" < ?', params: [3] });
    expect(where([{ field: 'region', op: 'not_in', value: ['EU', null] }])).toEqual({ where: 'WHERE "region" NOT IN (?)', params: ['EU'] });
    expect(where([{ field: 'region', op: 'not_in', value: [null] }])).toEqual({ where: 'WHERE "region" IS NOT NULL', params: [] });
    expect(where([{ field: 'region', op: 'in', value: [null] }])).toEqual({ where: 'WHERE 1 = 0', params: [] });
    expect(where([{ field: 'created_at', op: 'between', value: ['2026-01-01', '2026-01-31T23:59:59'] }])).toEqual({
      where: 'WHERE "created_at" BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)',
      params: ['2026-01-01', '2026-01-31T23:59:59'],
    });
    expect(where([{ field: 'amount', op: 'between', value: [1, null] }])).toEqual({ where: 'WHERE 1 = 0', params: [] });
    expect(where([{ field: 'payload', op: 'is_null' }, { field: 'region', op: 'not_null' }])).toEqual({
      where: 'WHERE "payload" IS NULL AND "region" IS NOT NULL',
      params: [],
    });
  });

  it('min/max render temporal values as ISO strings and booleans via bool_and/or', () => {
    const select = (dialect: Dialect) =>
      compile(dialect, {
        measures: [
          { field: 'order_date', agg: 'min' },
          { field: 'created_at', agg: 'max' },
          { field: 'vip', agg: 'max' },
          { field: 'amount', agg: 'avg' },
        ],
      }).sql.split('\n')[0];
    expect(select(duckdb)).toBe(
      `SELECT strftime(min("order_date"), '%Y-%m-%d') AS "min_order_date", strftime(max("created_at"), '%Y-%m-%dT%H:%M:%S') AS "max_created_at", bool_or("vip") AS "max_vip", round(CAST(avg("amount") AS DOUBLE), 6) AS "avg_amount"`,
    );
    expect(select(snowflake)).toBe(
      `SELECT TO_CHAR(min("order_date"), 'YYYY-MM-DD') AS "min_order_date", TO_CHAR(max("created_at"), 'YYYY-MM-DD"T"HH24:MI:SS') AS "max_created_at", BOOLOR_AGG("vip") AS "max_vip", round(CAST(avg("amount") AS DOUBLE), 6) AS "avg_amount"`,
    );
  });

  it('no dimensions: no GROUP BY and no ORDER BY', () => {
    expect(compile(duckdb, { measures: [{ field: '*', agg: 'count' }], limit: 1 }).sql).toBe('SELECT count(*) AS "count"\nFROM "DB"."S"."ORDERS"\nLIMIT 2');
  });
});

describe('compileQuery — safety', () => {
  it('quotes identifiers, so names cannot break out of the SQL', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    const out = compile(duckdb, { dimensions: [{ field: 'we"ird', as: 'x"; DROP TABLE t; --' }] });
    expect(out.sql.split('\n')[0]).toBe('SELECT "we""ird" AS "x""; DROP TABLE t; --"');
  });

  it('binds every value, never inlining it', () => {
    const evil = "EU'; DROP TABLE orders; --";
    const out = compile(snowflake, { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'region', op: 'eq', value: evil }] });
    expect(out.sql).not.toContain('DROP');
    expect(out.params).toEqual([evil]);
  });

  it('rejects unknown fields, mistyped filter values, and grains on non-dates', () => {
    const code = (q: Omit<QueryInput, 'source'>) => {
      try {
        compile(duckdb, q);
        return 'ok';
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError);
        return (e as EngineError).code;
      }
    };
    expect(code({ measures: [{ field: 'profit', agg: 'sum' }] })).toBe('unknown_field');
    expect(code({ measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'nope', op: 'is_null' }] })).toBe('unknown_field');
    expect(code({ dimensions: [{ field: 'region', grain: 'month' }] })).toBe('invalid_grain');
    expect(code({ measures: [{ field: 'region', agg: 'sum' }] })).toBe('invalid_measure');
    expect(code({ measures: [{ field: '*', agg: 'sum' }] })).toBe('invalid_measure');
    expect(code({ measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'amount', op: 'eq', value: '5' }] })).toBe('invalid_filter');
    expect(code({ measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'order_date', op: 'gte', value: 'last week' }] })).toBe('invalid_filter');
    expect(code({ measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'payload', op: 'eq', value: 'x' }] })).toBe('invalid_filter');
    expect(code({ dimensions: [{ field: 'region' }], orderBy: [{ field: 'amount', dir: 'asc' }] })).toBe('unknown_field');
  });
});

describe('type mapping', () => {
  it('maps DuckDB and Snowflake types to column kinds', () => {
    expect(['BIGINT', 'INTEGER', 'HUGEINT', 'DECIMAL(18,0)'].map(duckdbKind)).toEqual(['integer', 'integer', 'integer', 'integer']);
    expect(['DOUBLE', 'DECIMAL(10,2)', 'VARCHAR', 'BOOLEAN', 'DATE', 'TIMESTAMP WITH TIME ZONE', 'BLOB'].map(duckdbKind)).toEqual([
      'number',
      'number',
      'string',
      'boolean',
      'date',
      'timestamp',
      'other',
    ]);
    expect(snowflakeKind('NUMBER', 0)).toBe('integer');
    expect(snowflakeKind('NUMBER', 2)).toBe('number');
    expect(snowflakeKind('FLOAT')).toBe('number');
    expect(snowflakeKind('TEXT')).toBe('string');
    expect(snowflakeKind('TIMESTAMP_NTZ')).toBe('timestamp');
    expect(snowflakeKind('VARIANT')).toBe('other');
  });
});
