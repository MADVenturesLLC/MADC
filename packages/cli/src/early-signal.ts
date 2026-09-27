/**
 * §3e E6/E7 pre-`main` signal backstop. `bin.ts` installs these listeners at module scope before
 * it dynamically imports the rest of the module tree (`main.ts` pulls in doctor, the one-shot and
 * the engine client), so a SIGINT/SIGTERM that arrives during module load is recorded instead of
 * default-killing the process (which would exit with no JSON and no pinned code). The command
 * (`oneShot` / `runDoctor`) takes the record when it installs its own listeners and exits 130/143
 * with its pinned output, nothing spawned. Taking also removes the backstop, so the named
 * post-listener residual (F-102: default handling between listener removal and `process.exit`)
 * is unchanged. No side effects on import: in-process importers of `main.ts` (tests) never
 * install anything.
 */
let recorded: 130 | 143 | null = null;
let installed = false;
let taken = false;

const onSigint = (): void => {
  recorded = recorded ?? 130;
};
const onSigterm = (): void => {
  recorded = 143;
};

/** Install the backstop (idempotent). `bin.ts` calls this before its heavy dynamic imports. */
export function installEarlySignal(): void {
  if (installed) return;
  installed = true;
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
}

/** Remove the backstop; the recorded exit code is returned to the first taker only. */
export function takeEarlySignal(): 130 | 143 | null {
  if (!installed) return null;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  installed = false;
  if (taken) return null;
  taken = true;
  return recorded;
}
