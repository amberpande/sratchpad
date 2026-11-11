/**
 * The calculation expression language (spec 1.3), used by calculated measures (`calcs`) and catalog
 * metrics. It is parsed into an AST and never evaluated as code or spliced into SQL as text: the
 * SQL compilers walk the AST and emit quoted identifiers and bind parameters.
 *
 *   expr     := term (("+" | "-") term)*
 *   term     := unary (("*" | "/") unary)*
 *   unary    := "-" unary | primary
 *   primary  := number | "(" expr ")" | name | call
 *   call     := function "(" expr ("," expr)* ")" | agg "(" field ")" | "count" "(" "*" ")"
 *   name     := identifier | "quoted identifier"   (a measure, metric or earlier calc alias)
 *   field    := identifier | "quoted identifier"   (a source column; "source.column" for joins)
 *
 * Functions: abs(x), round(x[, digits]), coalesce(a, b, …), nullif(a, b), least(a, b, …), greatest(a, b, …).
 * Aggregations inside expressions: sum, avg, min, max, count, count_distinct, median, p25, p75, p90, stddev.
 * Semantics (every engine): arithmetic with a NULL is NULL; division by zero is NULL; least/greatest
 * are NULL if any argument is NULL; round is half away from zero; the result is rounded to 6 decimals.
 */

export const CALC_FUNCTIONS = ['abs', 'round', 'coalesce', 'nullif', 'least', 'greatest'] as const;
export type CalcFunction = (typeof CALC_FUNCTIONS)[number];
export const CALC_AGGREGATIONS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'median', 'p25', 'p75', 'p90', 'stddev'] as const;
export type CalcAggregation = (typeof CALC_AGGREGATIONS)[number];

export type CalcNode =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; name: string }
  | { kind: 'agg'; agg: CalcAggregation; field: string }
  | { kind: 'neg'; arg: CalcNode }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: CalcNode; right: CalcNode }
  | { kind: 'fn'; fn: CalcFunction; args: CalcNode[] };

export type CalcParseResult = { ok: true; node: CalcNode } | { ok: false; message: string };

const MAX_LENGTH = 2000;
const MAX_DEPTH = 32;
const MAX_NODES = 500;

type Token =
  | { t: 'num'; v: number; at: number }
  | { t: 'ident'; v: string; at: number }
  | { t: 'quoted'; v: string; at: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' | ','; at: number }
  | { t: 'end'; at: number };

class CalcSyntaxError extends Error {}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
      if (!m) throw new CalcSyntaxError(`Unexpected "${c}" at position ${i + 1}.`);
      const v = Number(m[0]);
      if (!Number.isFinite(v)) throw new CalcSyntaxError(`Number "${m[0]}" is out of range.`);
      out.push({ t: 'num', v, at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(text.slice(i))!;
      out.push({ t: 'ident', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= text.length) throw new CalcSyntaxError(`Unclosed quoted name starting at position ${i + 1}.`);
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += text[j];
        j++;
      }
      if (!v || v.length > 128) throw new CalcSyntaxError(`Quoted names must be 1–128 characters (position ${i + 1}).`);
      out.push({ t: 'quoted', v, at: i });
      i = j + 1;
      continue;
    }
    if ('+-*/(),'.includes(c)) {
      out.push({ t: 'op', v: c as '+', at: i });
      i++;
      continue;
    }
    throw new CalcSyntaxError(`Unexpected "${c}" at position ${i + 1}.`);
  }
  out.push({ t: 'end', at: text.length });
  return out;
}

const isFn = (name: string): name is CalcFunction => (CALC_FUNCTIONS as readonly string[]).includes(name);
const isAgg = (name: string): name is CalcAggregation => (CALC_AGGREGATIONS as readonly string[]).includes(name);

export function parseCalcExpr(text: string): CalcParseResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, message: 'The expression is empty.' };
  if (text.length > MAX_LENGTH) return { ok: false, message: `Expressions are limited to ${MAX_LENGTH} characters.` };
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  let pos = 0;
  let nodes = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const isOp = (v: string) => peek().t === 'op' && (peek() as { v: string }).v === v;
  const expect = (v: string) => {
    const tok = next();
    if (tok.t !== 'op' || tok.v !== v) throw new CalcSyntaxError(`Expected "${v}" at position ${tok.at + 1}.`);
  };
  const make = <N extends CalcNode>(n: N): N => {
    if (++nodes > MAX_NODES) throw new CalcSyntaxError('The expression is too large.');
    return n;
  };

  const expr = (depth: number): CalcNode => {
    if (depth > MAX_DEPTH) throw new CalcSyntaxError('The expression is nested too deeply.');
    let left = term(depth);
    while (isOp('+') || isOp('-')) {
      const op = (next() as { v: '+' | '-' }).v;
      left = make({ kind: 'bin', op, left, right: term(depth) });
    }
    return left;
  };
  const term = (depth: number): CalcNode => {
    let left = unary(depth);
    while (isOp('*') || isOp('/')) {
      const op = (next() as { v: '*' | '/' }).v;
      left = make({ kind: 'bin', op, left, right: unary(depth) });
    }
    return left;
  };
  const unary = (depth: number): CalcNode => {
    if (isOp('-')) {
      next();
      if (depth > MAX_DEPTH) throw new CalcSyntaxError('The expression is nested too deeply.');
      return make({ kind: 'neg', arg: unary(depth + 1) });
    }
    return primary(depth);
  };
  const fieldArg = (): string => {
    const tok = next();
    if (tok.t === 'ident' || tok.t === 'quoted') return tok.v;
    if (tok.t === 'op' && tok.v === '*') return '*';
    throw new CalcSyntaxError(`Expected a column name at position ${tok.at + 1}.`);
  };
  const primary = (depth: number): CalcNode => {
    const tok = next();
    if (tok.t === 'num') return make({ kind: 'num', value: tok.v });
    if (tok.t === 'op' && tok.v === '(') {
      const inner = expr(depth + 1);
      expect(')');
      return inner;
    }
    if (tok.t === 'quoted') return make({ kind: 'ref', name: tok.v });
    if (tok.t === 'ident') {
      if (!isOp('(')) return make({ kind: 'ref', name: tok.v });
      const name = tok.v.toLowerCase();
      next(); // "("
      if (isAgg(name)) {
        const field = fieldArg();
        if (field === '*' && name !== 'count') throw new CalcSyntaxError(`"*" only works with count (position ${tok.at + 1}).`);
        expect(')');
        return make({ kind: 'agg', agg: name, field });
      }
      if (!isFn(name)) throw new CalcSyntaxError(`Unknown function "${tok.v}" at position ${tok.at + 1}. Functions: ${[...CALC_FUNCTIONS, ...CALC_AGGREGATIONS].join(', ')}.`);
      const args: CalcNode[] = [];
      if (!isOp(')')) {
        args.push(expr(depth + 1));
        while (isOp(',')) {
          next();
          args.push(expr(depth + 1));
        }
      }
      expect(')');
      const arity = (min: number, max: number) => {
        if (args.length < min || args.length > max) {
          throw new CalcSyntaxError(`${name}() takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min}–${max}`} argument(s), got ${args.length}.`);
        }
      };
      switch (name) {
        case 'abs':
          arity(1, 1);
          break;
        case 'round':
          arity(1, 2);
          if (args[1] && !(args[1].kind === 'num' && Number.isInteger(args[1].value) && args[1].value >= -10 && args[1].value <= 10)) {
            throw new CalcSyntaxError('round(x, digits): digits must be a whole number from -10 to 10.');
          }
          break;
        case 'nullif':
          arity(2, 2);
          break;
        case 'coalesce':
          arity(1, 16);
          break;
        case 'least':
        case 'greatest':
          arity(2, 16);
          break;
      }
      return make({ kind: 'fn', fn: name, args });
    }
    throw new CalcSyntaxError(tok.t === 'end' ? 'The expression ends too early.' : `Unexpected "${(tok as { v: string }).v}" at position ${tok.at + 1}.`);
  };

  try {
    const node = expr(0);
    const end = peek();
    if (end.t !== 'end') throw new CalcSyntaxError(`Unexpected "${(end as { v: unknown }).v}" at position ${end.at + 1}.`);
    return { ok: true, node };
  } catch (e) {
    if (e instanceof CalcSyntaxError) return { ok: false, message: e.message };
    throw e;
  }
}

function walk(node: CalcNode, visit: (n: CalcNode) => void) {
  visit(node);
  if (node.kind === 'neg') walk(node.arg, visit);
  else if (node.kind === 'bin') {
    walk(node.left, visit);
    walk(node.right, visit);
  } else if (node.kind === 'fn') node.args.forEach((a) => walk(a, visit));
}

/** Alias names (measures, metrics, earlier calcs) an expression refers to. */
export function calcRefs(node: CalcNode): string[] {
  const out = new Set<string>();
  walk(node, (n) => n.kind === 'ref' && out.add(n.name));
  return [...out];
}

/** Aggregate calls in an expression. */
export function calcAggs(node: CalcNode): Array<{ agg: CalcAggregation; field: string }> {
  const out: Array<{ agg: CalcAggregation; field: string }> = [];
  walk(node, (n) => n.kind === 'agg' && out.push({ agg: n.agg, field: n.field }));
  return out;
}

const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const quoteName = (name: string) =>
  SIMPLE_NAME.test(name) && !isFn(name.toLowerCase()) && !isAgg(name.toLowerCase()) ? name : `"${name.replace(/"/g, '""')}"`;

/** Writes an AST back as expression text (round-trips through parseCalcExpr). */
export function formatCalcExpr(node: CalcNode): string {
  switch (node.kind) {
    case 'num':
      return String(node.value);
    case 'ref':
      return quoteName(node.name);
    case 'agg':
      return `${node.agg}(${node.field === '*' ? '*' : quoteName(node.field)})`;
    case 'neg':
      return `-(${formatCalcExpr(node.arg)})`;
    case 'bin':
      return `(${formatCalcExpr(node.left)} ${node.op} ${formatCalcExpr(node.right)})`;
    case 'fn':
      return `${node.fn}(${node.args.map(formatCalcExpr).join(', ')})`;
  }
}

/** Replaces `ref` nodes (e.g. metric names) with other ASTs. */
export function substituteRefs(node: CalcNode, replace: (name: string) => CalcNode | undefined): CalcNode {
  switch (node.kind) {
    case 'ref':
      return replace(node.name) ?? node;
    case 'neg':
      return { kind: 'neg', arg: substituteRefs(node.arg, replace) };
    case 'bin':
      return { ...node, left: substituteRefs(node.left, replace), right: substituteRefs(node.right, replace) };
    case 'fn':
      return { ...node, args: node.args.map((a) => substituteRefs(a, replace)) };
    default:
      return node;
  }
}

/** Half away from zero, like SQL ROUND in DuckDB and Snowflake. */
export function roundHalfAway(value: number, digits: number): number {
  const f = 10 ** digits;
  return (Math.sign(value) * Math.round(Math.abs(value) * f)) / f;
}

/**
 * Reference evaluation of an expression (the in-memory engine). `ref` and `agg` resolve leaves;
 * non-numeric leaves are the caller's error to raise.
 */
export function evaluateCalc(node: CalcNode, env: { ref(name: string): number | null; agg(agg: CalcAggregation, field: string): number | null }): number | null {
  const ev = (n: CalcNode): number | null => evaluateCalc(n, env);
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'ref':
      return env.ref(node.name);
    case 'agg':
      return env.agg(node.agg, node.field);
    case 'neg': {
      const v = ev(node.arg);
      return v === null ? null : -v;
    }
    case 'bin': {
      const a = ev(node.left);
      const b = ev(node.right);
      if (a === null || b === null) return null;
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? null : a / b;
      }
      return null;
    }
    case 'fn': {
      const args = node.args.map(ev);
      switch (node.fn) {
        case 'abs':
          return args[0] === null ? null : Math.abs(args[0]!);
        case 'round':
          return args[0] === null ? null : roundHalfAway(args[0]!, node.args[1] ? (node.args[1] as { value: number }).value : 0);
        case 'coalesce':
          return args.find((v) => v !== null) ?? null;
        case 'nullif':
          return args[0] === null ? null : args[0] === args[1] ? null : args[0]!;
        case 'least':
        case 'greatest':
          if (args.some((v) => v === null)) return null;
          return node.fn === 'least' ? Math.min(...(args as number[])) : Math.max(...(args as number[]));
      }
    }
  }
}
