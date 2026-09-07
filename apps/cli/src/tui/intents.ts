import type { CliRequest } from "./cli-bridge";
import type { OperatorState, PaneId } from "./state";

/**
 * The input model's vocabulary, kept in its own module so `state.ts`, `cli-bridge.ts` and
 * `tui-shell.ts` need no cycle to share it.
 *
 * An `Effect` is a DESCRIPTION of something to do, never a call. `reduce` returns them and only
 * `runTuiShell` executes them, which is what lets a test drive the whole interaction model —
 * keystroke to intent to state to effect — with no process and no terminal.
 */

export type Intent =
  | { readonly kind: "select-pane"; readonly pane: PaneId }
  | { readonly kind: "select-profile"; readonly index: number }
  | { readonly kind: "select-contact"; readonly identityId: string }
  | { readonly kind: "run"; readonly request: CliRequest }
  /** Opens or closes the key list. Bound to `?`, the one key an operator will try. */
  | { readonly kind: "toggle-help" }
  | { readonly kind: "trust-confirm" }
  | { readonly kind: "trust-cancel" }
  | { readonly kind: "quit" };

export type Effect =
  | { readonly kind: "run-cli"; readonly request: CliRequest }
  | { readonly kind: "answer-trust-prompt"; readonly answer: boolean }
  | { readonly kind: "quit" };

export interface Step {
  readonly state: OperatorState;
  readonly effects: readonly Effect[];
}
