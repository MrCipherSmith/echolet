import { create } from "zustand";

interface TerminalEvent {
  id: string;
  timestamp: number;
  type: string;
  message: string;
}

interface TerminalStore {
  events: TerminalEvent[];
  addEvent: (type: string, message: string) => void;
  clearEvents: () => void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  events: [],
  addEvent: (type: string, message: string) =>
    set((state) => ({
      events: [
        ...state.events,
        {
          id: `${Date.now()}-${Math.random()}`,
          timestamp: Date.now(),
          type,
          message,
        },
      ],
    })),
  clearEvents: () => set({ events: [] }),
}));
