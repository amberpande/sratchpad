export { Dashboard, type DashboardProps } from './Dashboard';
export { DashboardView, type DashboardViewProps } from './DashboardView';
export { BIProvider, BIContext, type BIConfig, type Theme } from './context';
export {
  BIRequestError,
  createHttpDataClient,
  HttpDataClient,
  type DataClient,
  type HttpDataClientOptions,
  type QueryRequest,
} from './data/client';
export { formatValue, humanize, type FormatContext } from './format';
export { widgetComponents } from './widgets/registry';
export { SUPPORTED_SPEC, SPEC_VERSION } from '@yourorg/bi-spec';
export { InteractionContext, useWidgetInteractions, WidgetIdContext, type InteractionEngine, type MarkSelection, type WidgetInteractions } from './interactions';
export { requestKey, type QueryRuntime } from './data/client';
export { useInteractionEngine, type NavigateRequest } from './interactionEngine';
export type { WidgetInteractionState } from './interactions';
