"use client";

import { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-red-600" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">Something went wrong</h3>
            <p className="text-gray-500 max-w-md">
              {this.state.error?.message || "Failed to load data. Please try again."}
            </p>
          </div>
          <Button
            onClick={this.handleRetry}
            variant="outline"
            className="gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Hook-based error boundary for use in client components
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  errorFallback?: React.ReactNode
) {
  return function WithErrorBoundary(props: P) {
    return (
      <ErrorBoundary fallback={errorFallback}>
        <WrappedComponent {...props} />
      </ErrorBoundary>
    );
  };
}