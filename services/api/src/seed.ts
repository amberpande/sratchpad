import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify, validateDashboard } from '@yourorg/bi-spec';
import type { DashboardStore } from './store/types';

// String-based on purpose: some test environments (jsdom) replace the global URL class.
export const EXAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/dashboards');

/** Loads every examples/dashboards/*.json into a team. Idempotent: unchanged specs are skipped. */
export async function seedExamples(
  store: DashboardStore,
  { teamId, createdBy = 'seed', dir = EXAMPLES_DIR, log = console.log }: { teamId: string; createdBy?: string; dir?: string; log?: (msg: string) => void },
): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const spec: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
    const result = validateDashboard(spec, { allowNewerMinor: false });
    if (!result.ok) throw new Error(`${file} is invalid: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    const { id, title, specVersion } = result.dashboard;
    const existing = await store.get(teamId, id);
    if (existing && stableStringify(existing.spec) === stableStringify(spec)) {
      log(`seed: ${id} unchanged (v${existing.version}) for ${teamId}`);
      continue;
    }
    const record = await store.save({ teamId, id, title, specVersion, spec, createdBy });
    log(`seed: ${id} saved as v${record.version} for ${teamId}`);
  }
}
