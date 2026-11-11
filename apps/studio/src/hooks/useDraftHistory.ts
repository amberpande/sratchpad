import { useCallback, useReducer } from 'react';
import { draftReducer, type DraftAction } from '../draft/reducer';
import type { DraftSpec } from '../draft/types';

interface History {
  past: DraftSpec[];
  present: DraftSpec;
  future: DraftSpec[];
  lastKey?: string;
  lastAt: number;
}

type HistoryAction =
  | { kind: 'do'; action: DraftAction; coalesce?: string }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'reset'; draft: DraftSpec };

const LIMIT = 100;
const COALESCE_MS = 1200;

export function historyReducer(state: History, a: HistoryAction): History {
  switch (a.kind) {
    case 'do': {
      const next = draftReducer(state.present, a.action);
      if (next === state.present) return state;
      const now = Date.now();
      // Typing in one field (or the JSON view) is one undo step, not one per keystroke.
      if (a.coalesce && a.coalesce === state.lastKey && now - state.lastAt < COALESCE_MS) {
        return { ...state, present: next, future: [], lastAt: now };
      }
      return { past: [...state.past, state.present].slice(-LIMIT), present: next, future: [], lastKey: a.coalesce, lastAt: now };
    }
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { past: state.past.slice(0, -1), present: prev, future: [state.present, ...state.future], lastAt: 0 };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { past: [...state.past, state.present], present: next, future: rest, lastAt: 0 };
    }
    case 'reset':
      return { past: [], present: a.draft, future: [], lastAt: 0 };
  }
}

export function useDraftHistory(initial: DraftSpec) {
  const [state, send] = useReducer(historyReducer, { past: [], present: initial, future: [], lastAt: 0 });
  const dispatch = useCallback((action: DraftAction, coalesce?: string) => send({ kind: 'do', action, coalesce }), []);
  const undo = useCallback(() => send({ kind: 'undo' }), []);
  const redo = useCallback(() => send({ kind: 'redo' }), []);
  const reset = useCallback((draft: DraftSpec) => send({ kind: 'reset', draft }), []);
  return { draft: state.present, dispatch, undo, redo, reset, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

export type Dispatch = (action: DraftAction, coalesce?: string) => void;
