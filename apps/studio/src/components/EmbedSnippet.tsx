import { useState } from 'react';
import type { DraftSpec } from '../draft/types';

export function embedSnippet(draft: DraftSpec): string {
  const dateParam = Object.entries(draft.params).find(([, p]) => p.type === 'daterange');
  const params = dateParam ? ` params={{ ${dateParam[0]}: 'last_30d' }}` : '';
  return `import { Dashboard } from '@yourorg/bi-renderer';\n\n<Dashboard id="${draft.id}" token={authToken}${params} />`;
}

export function EmbedSnippet({ draft, savedVersion }: { draft: DraftSpec; savedVersion: number }) {
  const [copied, setCopied] = useState(false);
  const text = embedSnippet(draft);
  return (
    <div className="embed">
      <pre>
        <code>{text}</code>
      </pre>
      <div className="row gap-s">
        <button
          type="button"
          className="btn small"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy snippet'}
        </button>
        <span className="muted small">{savedVersion ? `Renders the latest saved version (v${savedVersion}).` : 'Save first: host apps render saved versions.'}</span>
      </div>
    </div>
  );
}
