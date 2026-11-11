import type { DataSource, SourceProfile } from '@yourorg/bi-spec';
import { useCallback, useRef, useState } from 'react';
import { isRouteMissing, type StudioApi } from '../api/studioApi';
import { profileFields, SAMPLE_ORDERS_FIELDS, sourceKey } from '../draft/fields';
import type { FieldInfo } from '../draft/types';

export type ProfileState =
  | { status: 'loading' }
  | { status: 'ready'; profile: SourceProfile; fields: FieldInfo[] }
  /** No profile from the backend; fields come from a built-in list or the draft's own queries. */
  | { status: 'fallback'; fields: FieldInfo[]; reason: string };

/** Source profiles (GET /v1/sources/profile), cached per source for the session. */
export function useProfiles(api: StudioApi) {
  const [profiles, setProfiles] = useState<Record<string, ProfileState>>({});
  const requested = useRef(new Set<string>());

  const ensure = useCallback(
    (source: DataSource) => {
      const key = sourceKey(source);
      if (requested.current.has(key)) return;
      requested.current.add(key);
      setProfiles((p) => ({ ...p, [key]: { status: 'loading' } }));
      api.getProfile(source).then(
        (profile) => setProfiles((p) => ({ ...p, [key]: { status: 'ready', profile, fields: profileFields(profile) } })),
        (error: unknown) => {
          const builtIn = source.type === 'sample' && source.ref === 'orders' ? SAMPLE_ORDERS_FIELDS : [];
          const reason = isRouteMissing(error)
            ? 'This backend can’t profile sources yet (Phase 2), so fields come from a built-in list and this dashboard’s queries.'
            : `Couldn’t profile this source: ${(error as Error).message}`;
          setProfiles((p) => ({ ...p, [key]: { status: 'fallback', fields: builtIn, reason } }));
        },
      );
    },
    [api],
  );

  /** Seed the cache, e.g. with the profile an upload returned. */
  const put = useCallback((profile: SourceProfile) => {
    const key = sourceKey(profile.source);
    requested.current.add(key);
    setProfiles((p) => ({ ...p, [key]: { status: 'ready', profile, fields: profileFields(profile) } }));
  }, []);

  const get = useCallback((source: DataSource | undefined): ProfileState | undefined => (source ? profiles[sourceKey(source)] : undefined), [profiles]);

  return { ensure, put, get };
}
