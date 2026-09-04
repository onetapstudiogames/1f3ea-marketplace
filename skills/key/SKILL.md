---
name: key
description: "Check whether your stored market key still works (status), rotate it, recover a lost one, adopt one stranded under a staging label, or show it with explicit --reveal at an interactive terminal. Use when the user asks about their merchant key, rotating, recovering, or types /1f3ea-marketplace:key."
---

# key

Never print, log, or pass along a key or recovery code yourself — only the script may do that, and
only when explicitly told to reveal.

- **`key status`** — run `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" status [--handle <handle>]`
  and print its output verbatim. One authenticated `GET /api/me` read; reports whether the
  stored key works and, when it does not, whether the market genuinely rejected it or the read
  merely could not be verified right now (a timeout, a 5xx, or anything else that is not the
  market's own rejection) -- the latter is never reported as evidence the key is dead.
- **`key rotate`** — after telling the human what this does (replaces your current key; the old
  one stops working the moment this confirms, AND every connector session, authorization code,
  and delegated grant this merchant had is revoked with it), run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" rotate [--handle <handle>]` and print its output
  verbatim. It also runs the same one authenticated `GET /api/me` read `key status` runs, to
  confirm the stored key still identifies the named handle, before touching anything. It stages
  the replacement, confirms it with the market, then promotes it in the vault — the still-valid
  old key is never destroyed before confirmation succeeds. The market's own rotation door also
  asks for `client_class`; the script defaults it from whatever the stored vault entry already
  carries, so you only need to pass `--client-class` yourself when deliberately changing it. After
  it confirms, update whatever host secret `AGENT_1F3EA_SECRET` reads and re-run `connect`, and
  re-pair any chat twin with a fresh `connect chat` code — both will otherwise start failing with
  no obvious cause.
- **`key recover generate`** — mints a fresh set of eight recovery codes for your current key. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" recover generate [--handle <handle>]` and print its
  output verbatim. It also runs the same one authenticated `GET /api/me` read `key status` runs,
  to confirm the stored key still identifies the named handle, before minting anything.
- **`key recover begin`** — only when the current key is lost and the human has one saved recovery
  code. Ask the human for it, save it to a file yourself (never type it as a bare flag), then run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" recover begin --recovery-code-file <path>
  --client-class <coding_persistent|coding_ephemeral>` and print its output verbatim (pass
  `--client-class` explicitly here — unlike rotate above, the vault entry that would otherwise
  supply it is usually exactly what was lost). Delete the temporary file afterward. Confirming
  this, like rotation, revokes every connector session, authorization code, and delegated grant the
  old key had — the same re-`connect` and re-pair steps apply. When a handle and a still-readable
  stored key are found for it, this also runs that same one authenticated `GET /api/me` read before
  anything else, to catch a mismatched vault label; when no handle or stored key can be resolved (the
  common case here), it skips that read and proceeds straight to recovery.
- **`key show`** — only with explicit human request and only at an interactive terminal. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" show --reveal [--handle <handle>]`. Never do this on
  the human's behalf without them asking for it by name, and never copy the output anywhere else.
- **`key adopt`** — only when a past run's own vault promotion failed after the market already
  confirmed a merchant server-side, so the confirmed key sits only under a staging label instead
  of its real handle. `setup`'s registration-staging refusal names this exact command and label,
  and so do `rotate`'s and `recover begin`'s own stranded-key messages (an unreadable existing
  entry, a failed final write, or a timed-out per-handle lock) — adopt works from any of the
  three, not registration alone. Run
  `node "$CLAUDE_PLUGIN_ROOT/scripts/key.mjs" adopt --handle <the base handle> --from-label <the exact staging label the refusal named>`
  and print its output verbatim. It reads the staged key, probes `GET /api/me` with it (the same
  disclosed authenticated read every other command here runs), refuses outright unless that probe
  actually authenticates as `--handle`. If something also already lives under `--handle`, it
  probes that too, and every outcome is disclosed before adopt decides anything:
  - Still authenticates as `--handle` → both copies are working keys; adopt refuses to pick one —
    read both (`key show --handle <handle> --reveal` and `key show --handle <staging label>
    --reveal`) before deleting either.
  - Authenticates as a **different** handle → that entry is not dead, it belongs to someone else;
    adopt refuses, names both handles, and points at recovering the mislabelled entry
    (`key show --reveal`, then `key adopt` under its real handle) before anything is touched.
  - The market actually **rejects** the credential — a `401` whose body is the market's own JSON
    error, the only shape `GET /api/me` can ever answer a bad key with — the shape a stranded
    rotation or recovery leaves — adopt promotes the staged key over it. A `403`, or a `401` with
    an HTML or otherwise non-matching body, is never treated as a rejection: that is what an edge,
    firewall, or proxy answers in front of a perfectly healthy origin, not what the market itself
    can produce. **This REPLACES that live entry's key: the key it overwrites is not kept anywhere,
    by this script or anywhere else, so only run adopt once you actually intend that.**
  - The entry at `--handle` exists but carries no `merchant_key` at all → nothing to lose; adopt
    says so and replaces it with no probe needed. Same replace-with-disclosure rule as the line
    above.
  - Anything else (a timeout, a DNS failure, connection refused, a 5xx, a 429, a 403, or a 401 the
    market itself could not have produced — the market simply could not be reached or answered) is
    **never** treated as dead; adopt refuses, changes nothing, and says to retry once the market is
    reachable.

  The staging copy is deleted only once the real handle actually holds the working key, and only
  on the paths above that actually promote — never printing the key itself.

Every one of these stays silent about the actual secret unless `--reveal` is passed and the
terminal is interactive — confirm that condition before ever suggesting `--reveal`.
