import { useEffect, useRef, useState } from "react";
import type { GitHubStatus } from "../background/githubAuth.js";
import { api } from "./api.js";

/** Device-flow sign-in. The token never reaches this page; only status does. */
export function GitHubPanel(props: { status: GitHubStatus; onChange: () => void }) {
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(
    props.status.pending
      ? {
          userCode: props.status.pending.userCode,
          verificationUri: props.status.pending.verificationUri,
        }
      : null,
  );
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function schedulePoll(ms: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        api.pollGitHub().then(
          (p) => {
            if (p.state === "pending") schedulePoll(p.retryInMs);
            else {
              setCode(null);
              setMessage(
                p.state === "connected"
                  ? `Connected as ${p.login}.`
                  : p.state === "expired"
                    ? "The code expired. Try again."
                    : p.state === "denied"
                      ? "Access was denied on GitHub."
                      : p.state === "error"
                        ? p.message
                        : "",
              );
              props.onChange();
            }
          },
          (e: unknown) => setMessage(e instanceof Error ? e.message : "Polling failed."),
        );
      },
      Math.max(1000, ms),
    );
  }

  useEffect(() => {
    // Resume polling if a sign-in was already in progress when the page opened.
    if (code) schedulePoll(1000);
  }, []);

  async function connect() {
    setMessage("");
    try {
      const p = await api.connectGitHub();
      if (p.state === "pending") {
        setCode({ userCode: p.userCode, verificationUri: p.verificationUri });
        schedulePoll(p.retryInMs);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not start GitHub sign-in.");
    }
  }

  async function disconnect() {
    await api.disconnectGitHub();
    setMessage("Disconnected. The stored token was deleted.");
    props.onChange();
  }

  return (
    <fieldset>
      <legend>GitHub</legend>
      {props.status.connected ? (
        <>
          <p>
            Connected as <strong>{props.status.login}</strong> (scopes:{" "}
            {props.status.scopes?.join(", ") || "none"})
          </p>
          <button type="button" onClick={() => void disconnect()}>
            Disconnect GitHub
          </button>
        </>
      ) : code ? (
        <>
          <p>
            Open{" "}
            <a href={code.verificationUri} target="_blank" rel="noreferrer">
              {code.verificationUri}
            </a>{" "}
            and enter this code:
          </p>
          <p className="code" data-testid="user-code">
            {code.userCode}
          </p>
          <p>Waiting for approval…</p>
        </>
      ) : (
        <button type="button" onClick={() => void connect()}>
          Connect GitHub
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}
