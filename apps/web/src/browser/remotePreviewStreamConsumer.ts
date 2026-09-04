import type { RemotePreviewViewerStreamEvent } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

type ViewerStreamResult<E> = AsyncResult.AsyncResult<RemotePreviewViewerStreamEvent, E>;

/**
 * Drains a `remotePreview.open` stream into the viewer.
 *
 * Reading the atom's value from a component would coalesce events, and a
 * dropped ICE candidate or `controllerChanged` is not recoverable. Subscribing
 * inside an atom delivers every emission, including the one that can land
 * before the subscription is installed.
 */
export function createRemotePreviewStreamConsumerAtom<E>(options: {
  readonly streamAtom: Atom.Atom<ViewerStreamResult<E>>;
  readonly handlerAtom: Atom.Atom<{
    readonly accept: (event: RemotePreviewViewerStreamEvent) => void;
    readonly fail: () => void;
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
        get.once(options.handlerAtom).fail();
        return;
      }
      if (!AsyncResult.isSuccess(result)) return;
      get.once(options.handlerAtom).accept(result.value);
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
