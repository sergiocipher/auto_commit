import { useState } from "react";
import type { BackendStatus } from "../background/handler.js";
import { api } from "./api.js";

const DEFAULT_URL = "http://127.0.0.1:8787";

/** Pairing with the self-hosted backend. Without it the extension runs in local mode. */
export function BackendPanel(props: { status: BackendStatus; onChange: () => void }) {
  const [url, setUrl] = useState(props.status.url ?? DEFAULT_URL);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");

  async function pair() {
    setMessage("");
    try {
      await api.pairBackend(url, code);
      setCode("");
      setMessage("Paired. Uploads now go through the backend; connect GitHub there below.");
      props.onChange();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Pairing failed.");
    }
  }

  async function unpair() {
    if (!confirm("Stop using the backend? New submissions will upload from this browser.")) return;
    await api.unpairBackend();
    setMessage("Unpaired. Local mode is active.");
    props.onChange();
  }

  return (
    <fieldset>
      <legend>Backend (optional)</legend>
      {props.status.paired ? (
        <>
          <p>
            Paired with <code>{props.status.url}</code>. Submissions, history and the GitHub token
            live in your backend.
          </p>
          <button type="button" onClick={() => void unpair()}>
            Unpair
          </button>
        </>
      ) : (
        <>
          <p>
            Local mode: uploads run in this browser. To use the Docker backend, run{" "}
            <code>docker compose exec api node dist/cli.js pair</code> and enter the code here.
          </p>
          <label>
            Backend URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label>
            Pairing code
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
          </label>
          <button type="button" disabled={code.trim().length < 8} onClick={() => void pair()}>
            Pair
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}
