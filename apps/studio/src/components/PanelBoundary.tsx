import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one Studio panel's crash local: instead of React unmounting the whole Studio (a blank
 * screen), the panel shows what failed and a retry. The draft lives above it and is not lost.
 */
export class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[studio] ${this.props.name} panel crashed`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="note small" role="alert">
        <p>
          The {this.props.name} panel hit an error: {this.state.error.message}. Your dashboard draft is safe.
        </p>
        <button type="button" className="btn small" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
