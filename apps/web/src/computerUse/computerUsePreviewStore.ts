import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { resolveStorage } from "~/lib/storage";

interface ComputerUsePresentation {
  autoShow: boolean;
  dismissed: Record<string, true>;
  setAutoShow: (enabled: boolean) => void;
  dismiss: (sessionId: string) => void;
  reopen: (sessionId: string) => void;
}
export const useComputerUsePresentation = create<ComputerUsePresentation>()(
  persist(
    (set) => ({
      autoShow: true,
      dismissed: {},
      setAutoShow: (autoShow) => set({ autoShow }),
      dismiss: (sessionId) =>
        set((state) => ({ dismissed: { ...state.dismissed, [sessionId]: true } })),
      reopen: (sessionId) =>
        set((state) => {
          const dismissed = { ...state.dismissed };
          delete dismissed[sessionId];
          return { dismissed };
        }),
    }),
    {
      name: "t3code:computer-use-preview",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
    },
  ),
);

export const useComputerUseCaptureOwners = create<{
  environments: Record<string, boolean>;
  set: (environmentId: string, owned: boolean) => void;
}>()((set) => ({
  environments: {},
  set: (environmentId, owned) =>
    set((state) => ({ environments: { ...state.environments, [environmentId]: owned } })),
}));

export const useComputerUseAppNames = create<{
  names: Record<string, string>;
  setName: (key: string, name: string) => void;
}>()((set) => ({
  names: {},
  setName: (key, name) =>
    set((state) =>
      state.names[key] === name
        ? state
        : { names: Object.fromEntries([...Object.entries(state.names), [key, name]].slice(-128)) },
    ),
}));
