import { VersionConflictError } from '../errors';
import type { DashboardRecord, DashboardStore, DashboardSummary, SaveInput, VersionSummary } from './types';

/** In-process store for local development and tests. */
export class MemoryDashboardStore implements DashboardStore {
  private readonly versions = new Map<string, DashboardRecord[]>();

  private key(teamId: string, id: string) {
    return `${teamId}\u0000${id}`;
  }

  async get(teamId: string, id: string, version?: number): Promise<DashboardRecord | null> {
    const all = this.versions.get(this.key(teamId, id));
    if (!all?.length) return null;
    const record = version === undefined ? all[all.length - 1] : all[version - 1];
    return record ? structuredClone(record) : null;
  }

  async list(teamId: string): Promise<DashboardSummary[]> {
    const out: DashboardSummary[] = [];
    for (const all of this.versions.values()) {
      const latest = all[all.length - 1];
      if (latest && latest.teamId === teamId) {
        out.push({ id: latest.id, title: latest.title, latestVersion: latest.version, updatedAt: latest.createdAt });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async listVersions(teamId: string, id: string): Promise<VersionSummary[]> {
    return (this.versions.get(this.key(teamId, id)) ?? [])
      .map(({ version, title, specVersion, createdBy, createdAt }) => ({ version, title, specVersion, createdBy, createdAt }))
      .reverse();
  }

  async save(input: SaveInput): Promise<DashboardRecord> {
    const key = this.key(input.teamId, input.id);
    const all = this.versions.get(key) ?? [];
    const current = all.length;
    if (input.expectedVersion !== undefined && input.expectedVersion !== current) {
      throw new VersionConflictError(current, input.expectedVersion);
    }
    const record: DashboardRecord = {
      teamId: input.teamId,
      id: input.id,
      version: current + 1,
      title: input.title,
      specVersion: input.specVersion,
      spec: structuredClone(input.spec),
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    all.push(record);
    this.versions.set(key, all);
    return structuredClone(record);
  }
}
