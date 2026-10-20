import { Component, type ReactNode } from "react";

interface BoundaryProps {
  readonly resetKeys?: ReadonlyArray<unknown>;
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly resetKeys?: ReadonlyArray<unknown> | undefined;
  readonly failed: boolean;
}

export class RenderErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  static getDerivedStateFromError() {
    return { failed: true };
  }

  // Retry changed inputs without remounting healthy children or their controls.
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    const next = props.resetKeys;
    const previous = state.resetKeys;
    const changed =
      next?.length !== previous?.length ||
      next?.some((key, index) => !Object.is(key, previous?.[index]));
    return changed ? { resetKeys: next, failed: false } : null;
  }

  override state: BoundaryState = { failed: false, resetKeys: this.props.resetKeys };

  override render() {
    const { failed } = this.state;
    return failed ? this.props.fallback : this.props.children;
  }
}
