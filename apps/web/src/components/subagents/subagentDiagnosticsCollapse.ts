export interface DiagnosticsCollapseState {
  readonly manual: boolean;
  readonly automatic: boolean;
}

export type DiagnosticsCollapseAction =
  | { readonly type: "toggle" }
  | { readonly type: "user-scroll"; readonly atTop: boolean }
  | { readonly type: "reset" };

export function updateDiagnosticsCollapse(
  state: DiagnosticsCollapseState,
  action: DiagnosticsCollapseAction,
): DiagnosticsCollapseState {
  if (action.type === "reset") return { manual: false, automatic: false };
  if (action.type === "toggle") {
    return state.manual || state.automatic
      ? { manual: false, automatic: false }
      : { manual: true, automatic: false };
  }
  if (state.manual || state.automatic === !action.atTop) return state;
  return { ...state, automatic: !action.atTop };
}
