import type { Issue } from './types';

/**
 * Shared contract for spec extensions (spec 1.3 work). Each extension file is owned by one
 * workstream; validate.ts calls them through these hooks. Do not change this file's shape without
 * coordinating: every extension depends on it.
 */

/** The version that introduces the 1.3 features (calculations, interactivity, new visuals, platform). */
export const V13 = '1.3';

export interface ExtContext {
  errors: Issue[];
  warnings: Issue[];
  /** True when the reader fully understands the document's version: unknown keys are errors. */
  strict: boolean;
  /**
   * Version gate for a field introduced in `since`: returns false (and records an error or warning)
   * when the document claims an older version or the reader predates the field.
   */
  gate(path: string, since: string): boolean;
}
