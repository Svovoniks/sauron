import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Last line of defence: a render error must never leave the user with a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="fatal-error" role="alert">
        <h2>Something went wrong</h2>
        <p>{error.message}</p>
        <p className="fatal-error-hint">
          Your connections and saved items are stored in the app data folder and were not modified. Reload the app to
          try again.
        </p>
        <button className="button save-button" onClick={() => window.location.reload()} type="button">
          Reload
        </button>
      </div>
    );
  }
}
