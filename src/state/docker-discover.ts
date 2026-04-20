import { create } from "zustand";

interface DockerDiscoverState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useDockerDiscover = create<DockerDiscoverState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
