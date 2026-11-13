import type { Recommendation, RecommendationResponse, SourceSummary } from '@yourorg/bi-spec';
import { useRef, useState, type DragEvent } from 'react';
import { groupFields, sourceKey } from '../draft/fields';
import type { FieldInfo } from '../draft/types';
import type { SourcesStatus } from '../hooks/useSources';
import type { ProfileState } from '../hooks/useProfiles';
import { FIELD_MIME, type FieldDrag } from './dnd';
import { FieldTypeIcon, GripIcon } from './icons';

export type AsyncStatus = { status: 'idle' } | { status: 'busy' } | { status: 'unsupported'; message: string } | { status: 'error'; message: string };

export interface DataPanelProps {
  sources: SourceSummary[];
  sourcesStatus: SourcesStatus;
  onRefreshSources?: () => void;
  active: SourceSummary | null;
  onSelectSource: (s: SourceSummary) => void;
  onUpload: (file: File) => void;
  upload: AsyncStatus;
  profile: ProfileState | undefined;
  fields: FieldInfo[];
  /** Label of the selected widget, when a field can be added to it with a click. */
  targetLabel?: string;
  onAddField: (field: FieldInfo) => void;
  suggest: AsyncStatus;
  onSuggest: () => void;
  suggestions: RecommendationResponse | null;
  onAddCandidate: (c: Recommendation) => void;
  onCloseSuggestions: () => void;
}

function FieldRow({ field, active, targetLabel, onAdd }: { field: FieldInfo; active: SourceSummary; targetLabel?: string; onAdd: () => void }) {
  const onDragStart = (e: DragEvent) => {
    const payload: FieldDrag = { field, source: active.source };
    e.dataTransfer.setData(FIELD_MIME, JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', field.name);
    e.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <li className="field-row" draggable onDragStart={onDragStart} data-secondary={field.secondary || undefined} title={`Drag onto a widget or the canvas${field.format ? ` · ${field.format}` : ''}`}>
      <span className="field-grip">
        <GripIcon />
      </span>
      <FieldTypeIcon semanticType={field.semanticType} />
      <span className="field-name">{field.name}</span>
      {targetLabel && (
        <button type="button" className="btn ghost icon field-add" onClick={onAdd} aria-label={`Add ${field.name} to ${targetLabel}`} title={`Add to ${targetLabel}`}>
          +
        </button>
      )}
    </li>
  );
}

function FieldGroup({ title, fields, active, targetLabel, onAdd }: { title: string; fields: FieldInfo[]; active: SourceSummary; targetLabel?: string; onAdd: (f: FieldInfo) => void }) {
  if (!fields.length) return null;
  return (
    <section className="field-group">
      <h3 className="panel-label">
        {title} <span className="count">{fields.length}</span>
      </h3>
      <ul>
        {fields.map((f) => (
          <FieldRow key={f.name} field={f} active={active} targetLabel={targetLabel} onAdd={() => onAdd(f)} />
        ))}
      </ul>
    </section>
  );
}

function Suggestions({ data, onAdd, onClose }: { data: RecommendationResponse; onAdd: (c: Recommendation) => void; onClose: () => void }) {
  return (
    <section className="suggestions" aria-label="Suggested charts">
      <header>
        <h3 className="panel-label">Suggested charts</h3>
        <button type="button" className="btn ghost small" onClick={onClose}>
          Hide
        </button>
      </header>
      <p className="muted small">
        Loaded as an editable draft. {data.generatedBy === 'rules' ? 'Ranked by rules (AI ranking unavailable).' : 'Ranked by AI from the data profile.'}
      </p>
      {data.warnings.map((w, i) => (
        <p key={i} className="note small">
          {w}
        </p>
      ))}
      <ol>
        {data.candidates.map((c) => (
          <li key={c.id}>
            <div>
              <strong>{c.title}</strong>
              <span className="muted small">{c.rationale}</span>
            </div>
            <button type="button" className="btn small" onClick={() => onAdd(c)} title="Add this chart to the canvas">
              Add
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DataPanel(props: DataPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { active, profile, fields } = props;
  const groups = groupFields(fields);
  const [sourceFilter, setSourceFilter] = useState('');
  const suggestDisabled = !active || props.suggest.status === 'busy' || props.suggest.status === 'unsupported';

  return (
    <aside className="panel data-panel" aria-label="Data">
      <div className="panel-section">
        <h2 className="panel-title">Data</h2>
        <label className="field-label" htmlFor="source-select">
          Source
        </label>
        {(props.sources.length > 12 || sourceFilter) && (
          <input
            className="source-filter"
            type="search"
            placeholder={`Filter ${props.sources.length} sources…`}
            aria-label="Filter sources"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          />
        )}
        <div className="row gap-s">
        <select
          id="source-select"
          value={active ? sourceKey(active.source) : ''}
          onChange={(e) => {
            const s = props.sources.find((x) => sourceKey(x.source) === e.target.value);
            if (s) props.onSelectSource(s);
          }}
        >
          {!active && <option value="">Choose a source…</option>}
          {props.sources.filter((s) => !sourceFilter || s.name.toLowerCase().includes(sourceFilter.toLowerCase()) || (active && sourceKey(s.source) === sourceKey(active.source))).map((s) => (
            <option key={sourceKey(s.source)} value={sourceKey(s.source)}>
              {s.name} · {s.source.type}
              {s.rowCount !== undefined ? ` · ${s.rowCount.toLocaleString()} rows` : ''}
            </option>
          ))}
        </select>
        {props.onRefreshSources && (
          <button type="button" className="btn ghost icon small" title="Refresh the list (new tables appear at once)" aria-label="Refresh sources" onClick={props.onRefreshSources}>
            ↻
          </button>
        )}
        </div>
        {props.sourcesStatus === 'unsupported' && <p className="note small">This backend can’t list sources yet (Phase 2). Showing the sample dataset.</p>}
        {props.sourcesStatus === 'error' && <p className="note small">Couldn’t list sources. Showing the sample dataset.</p>}

        <div className="row gap-s wrap">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) props.onUpload(file);
              e.target.value = '';
            }}
          />
          <button type="button" className="btn small" onClick={() => fileRef.current?.click()} disabled={props.upload.status === 'busy' || props.upload.status === 'unsupported'}>
            {props.upload.status === 'busy' ? 'Uploading…' : 'Upload CSV / Excel'}
          </button>
          <button
            type="button"
            className="btn small accent"
            onClick={props.onSuggest}
            disabled={suggestDisabled}
            title={props.suggest.status === 'unsupported' ? props.suggest.message : 'Profile this source and suggest a starter dashboard'}
          >
            {props.suggest.status === 'busy' ? 'Suggesting…' : 'Suggest a dashboard'}
          </button>
        </div>
        {(props.upload.status === 'unsupported' || props.upload.status === 'error') && <p className="note small">{props.upload.message}</p>}
        {(props.suggest.status === 'unsupported' || props.suggest.status === 'error') && <p className="note small">{props.suggest.message}</p>}
      </div>

      {props.suggestions && <Suggestions data={props.suggestions} onAdd={props.onAddCandidate} onClose={props.onCloseSuggestions} />}

      <div className="panel-section grow">
        {active && profile?.status === 'ready' && (
          <p className="muted small">
            {profile.profile.rowCount.toLocaleString()} rows{profile.profile.sampled ? ' (sampled)' : ''} · {profile.profile.columns.length} columns
          </p>
        )}
        {profile?.status === 'loading' && <p className="muted small">Profiling…</p>}
        {profile?.status === 'fallback' && <p className="note small">{profile.reason}</p>}
        {active && (
          <>
            <FieldGroup title="Time" fields={groups.time} active={active} targetLabel={props.targetLabel} onAdd={props.onAddField} />
            <FieldGroup title="Measures" fields={groups.measures} active={active} targetLabel={props.targetLabel} onAdd={props.onAddField} />
            <FieldGroup title="Dimensions" fields={groups.dimensions} active={active} targetLabel={props.targetLabel} onAdd={props.onAddField} />
          </>
        )}
        {active && profile && profile.status !== 'loading' && fields.length === 0 && <p className="muted small">No fields known for this source yet.</p>}
        <p className="hint small">Drag a field onto a widget to add it, or onto empty canvas to start a new widget.</p>
      </div>
    </aside>
  );
}
