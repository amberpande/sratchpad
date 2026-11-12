import { createContext, useInsertionEffect, type CSSProperties, type ReactNode } from 'react';
import type { DataClient } from './data/client';
import { ensureStyles } from './styles';

export type Theme = 'light' | 'dark' | 'auto';

export interface BIConfig {
  /** Base URL of the BI API. Default "/bi-api" (proxy it from the host app). */
  apiUrl?: string;
  /** Inject a data client (tests, custom transports). */
  client?: DataClient;
  fetch?: typeof fetch;
  locale?: string;
  currency?: string;
  theme?: Theme;
}

export const BIContext = createContext<BIConfig>({});

/** Optional app-wide defaults, so each <Dashboard> only needs an id and a token. */
export function BIProvider({ children, ...config }: BIConfig & { children: ReactNode }) {
  return <BIContext.Provider value={config}>{children}</BIContext.Provider>;
}

export function Root({
  theme = 'light',
  className,
  children,
  style,
  attrs,
}: {
  theme?: Theme;
  className?: string;
  children: ReactNode;
  /** Spec 1.2 dashboard theme as custom properties (see theme.ts). */
  style?: CSSProperties;
  attrs?: Record<string, string | undefined>;
}) {
  useInsertionEffect(() => {
    ensureStyles();
  }, []);
  return (
    <div className={className ? `bi-root ${className}` : 'bi-root'} data-bi-theme={theme} style={style} {...attrs}>
      {children}
    </div>
  );
}
