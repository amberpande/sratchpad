import type { SourceSummary } from '@yourorg/bi-spec';
import { useCallback, useEffect, useState } from 'react';
import { isRouteMissing, type StudioApi } from '../api/studioApi';
import { SAMPLE_ORDERS, sourceKey } from '../draft/fields';

export type SourcesStatus = 'loading' | 'ready' | 'unsupported' | 'error';

/** GET /v1/sources, falling back to the sample dataset on a backend without the route. */
export function useSources(api: StudioApi) {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [status, setStatus] = useState<SourcesStatus>('loading');
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    api.listSources().then(
      (list) => {
        if (cancelled) return;
        setSources((prev) => merge(list, prev));
        setStatus('ready');
      },
      (error: unknown) => {
        if (cancelled) return;
        setSources((prev) => merge([SAMPLE_ORDERS], prev));
        setStatus(isRouteMissing(error) ? 'unsupported' : 'error');
        setMessage((error as Error).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const add = useCallback((summary: SourceSummary) => setSources((prev) => merge(prev, [summary])), []);
  return { sources, status, message, add };
}

function merge(a: SourceSummary[], b: SourceSummary[]): SourceSummary[] {
  const seen = new Set(a.map((s) => sourceKey(s.source)));
  return [...a, ...b.filter((s) => !seen.has(sourceKey(s.source)))];
}
