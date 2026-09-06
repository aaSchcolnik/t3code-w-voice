import type { RemotePreviewViewerStreamEvent } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

type ViewerStreamResult<E> = AsyncResult.AsyncResult<
  ReadonlyArray<RemotePreviewViewerStreamEvent>,
  E
>;

/**
 * Drains a `remotePreview.open` stream into the viewer.
 *
 * Reading the atom's value from a component would coalesce events, and a
 * dropped ICE candidate or `controllerChanged` is not recoverable. Subscribing
 * inside an atom delivers every emission, including the one that can land
 * before the subscription is installed. Each emission is one stream chunk, so
 * events that arrived together are replayed in order instead of collapsing to
 * the newest one.
 */
export function createRemotePreviewStreamConsumerAtom<E>(options: {
  readonly streamAtom: Atom.Atom<ViewerStreamResult<E>>;
  readonly handlerAtom: Atom.Atom<{
    readonly accept: (event: RemotePreviewViewerStreamEvent) => void;
    readonly fail: (cause: Cause.Cause<E>) => void;
  }>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.handlerAtom);
    let disposed = false;
    let emissions = 0;

    const consume = (result: ViewerStreamResult<E>) => {
      if (disposed) return;
      if (AsyncResult.isFailure(result)) {
        get.once(options.handlerAtom).fail(result.cause);
        return;
      }
      if (!AsyncResult.isSuccess(result)) return;
      const handler = get.once(options.handlerAtom);
      for (const event of result.value) handler.accept(event);
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initial = get.once(options.streamAtom);
    get.subscribe(options.streamAtom, (result) => {
      emissions += 1;
      consume(result);
    });
    queueMicrotask(() => {
      if (emissions === 0) consume(initial);
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
