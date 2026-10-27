import { useCallback, useEffect, useState } from "react";
import type { PopupState } from "../background/handler.js";
import { api } from "./api.js";

export function useAppState() {
  const [state, setState] = useState<PopupState | null>(null);
  const [error, setError] = useState<string>("");
  const refresh = useCallback(() => {
    api.getState().then(
      (s) => {
        setState(s);
        setError("");
      },
      (e: unknown) => setError(e instanceof Error ? e.message : "Failed to load state."),
    );
  }, []);
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [refresh]);
  return { state, error, refresh };
}
