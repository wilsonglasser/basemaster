import { create } from "zustand";
import { persist } from "zustand/middleware";

const MIN = 0.5;
const MAX = 2.5;
const STEP = 0.1;
/** Boost aplicado quando entra em fullscreen (modo apresentação). */
const PRESENTATION_BOOST = 1.35;

interface UiZoomState {
  /** Zoom "normal" do usuário. */
  zoom: number;
  /** True quando a janela está em fullscreen. */
  fullscreen: boolean;
  /** Salvo antes do boost de apresentação. */
  zoomBeforeFullscreen: number | null;

  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  setZoom: (z: number) => void;
  setFullscreen: (on: boolean) => void;
  /** Zoom efetivo considerando o boost de apresentação. */
  effectiveZoom: () => number;
}

function clamp(z: number) {
  return Math.max(MIN, Math.min(MAX, Math.round(z * 100) / 100));
}

export const useUiZoom = create<UiZoomState>()(
  persist(
    (set, get) => ({
      zoom: 1,
      fullscreen: false,
      zoomBeforeFullscreen: null,

      zoomIn: () => set({ zoom: clamp(get().zoom + STEP) }),
      zoomOut: () => set({ zoom: clamp(get().zoom - STEP) }),
      zoomReset: () => set({ zoom: 1 }),
      setZoom: (z) => set({ zoom: clamp(z) }),

      setFullscreen(on) {
        const cur = get();
        if (on && !cur.fullscreen) {
          set({
            fullscreen: true,
            zoomBeforeFullscreen: cur.zoom,
            zoom: clamp(cur.zoom * PRESENTATION_BOOST),
          });
        } else if (!on && cur.fullscreen) {
          set({
            fullscreen: false,
            zoom: cur.zoomBeforeFullscreen ?? 1,
            zoomBeforeFullscreen: null,
          });
        }
      },

      effectiveZoom() {
        return get().zoom;
      },
    }),
    {
      name: "basemaster.ui-zoom",
      partialize: (s) => ({ zoom: s.zoom }),
    },
  ),
);
