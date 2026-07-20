# Host access and automation

## Purpose

Baton uses one generic access policy for local files, commands, network-capable programs, ADB,
emulators, Git, and future host tools. A new tool must register a capability; it must not add a
tool-specific permission column to a conversation. Electron is not required: the loopback-only
Node BFF owns host execution, while the web UI remains the control surface.

## Reference products

The design borrows contracts, not product-specific storage layouts.

| Product | Observed contract | Baton conclusion |
| --- | --- | --- |
| Codex CLI | Sandbox and approval are separate. Built-ins are `:read-only`, `:workspace`, and `:danger-full-access`; resolved permissions are snapshotted for execution. | Keep a stable profile identity and compile it into a turn snapshot. |
| Codex Desktop | The installed app maps Read only / Auto / Full access to those profiles and sends the resolved sandbox and approval policy on `thread/start` and `turn/start`. | Desktop UI state is not the authority; the started turn is. |
| Claude Code | Permission rules use Deny → Ask → Allow, while modes include `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`, and `auto`. OS sandboxing is a separate layer. | Access scope and approval are distinct concepts even when Baton currently has no interactive approval prompt. |
| Claude Desktop | The installed app passes `permissionMode`, allowed/disallowed tools, additional directories, and dangerous-skip support to its Claude Code process per session. | Do not model each external program as a special session attachment. |

Authoritative references:

- Codex manual sections “Sandboxing and approvals”, “Permission profiles”, and subagent permission
  inheritance: <https://developers.openai.com/codex/security>,
  <https://developers.openai.com/codex/config-reference>.
- Current local Codex source:
  `codex-rs/protocol/src/models.rs`, `codex-rs/protocol/src/request_permissions.rs`,
  `codex-rs/core/src/config/permissions.rs`,
  `codex-rs/core/src/config/resolved_permission_profile.rs`, and
  `codex-rs/app-server-protocol/src/protocol/v2/permissions.rs`.
- Claude Code permissions: <https://code.claude.com/docs/en/permissions>.
- Installed Codex Desktop bundles `.vite/build/src-DU0S2Fqi.js` and
  `.vite/build/main-CmXfwZWv.js`; installed Claude Desktop bundles
  `.vite/build/index.chunk-CgLXpPH8.js`, `.vite/build/index.chunk-BA3wNZ_K.js`, and
  `.vite/build/index.chunk-BIMQN2pr.js`.

## Baton profiles

| Profile | Connected-workspace tools | Commands and host access |
| --- | --- | --- |
| `read_only` | Read, list, and literal search | No command execution and no mutating legacy host tool |
| `workspace` | Read, write, exact replacement, list, and search | Direct argv only through the Codex workspace sandbox; workspace write, bounded minimal system reads, network disabled |
| `full_access` | Same deterministic workspace file tools when a folder is connected | Direct argv on the host without an OS sandbox; works without a connected folder and may invoke `adb`, `ldconsole`, PowerShell, Git, or any installed executable |

`run_command` never accepts a shell string. It accepts an argv array, uses `shell: false`, caps output,
enforces a timeout, and terminates the child process tree on cancellation or timeout. A user can still
explicitly invoke a shell executable in Full access, so this profile must be treated as equivalent to
local code execution. Baton-owned `BATON_*` and `GATEWAY_*` environment values are removed before
launch; Full access can nevertheless read user-accessible host data by design.

## Resolution and lifetime

```text
global default
    └─ session override (nullable)
          └─ effective profile resolved immediately before turn creation
                └─ immutable execution policy snapshot
```

- The global default is `workspace` on first migration.
- A session override is either a profile or `null` (“follow global”).
- An override can change only while the thread is idle. An active turn is never widened in place.
- Each root turn, Goal continuation, and queued follow-up stores `permissionProfile`, its source,
  exact allowed tool names, cwd, and legacy capability receipt in `ExecutionPolicySnapshot`.
- Changing the global default affects the next turn of sessions without an override. Historical turns
  retain their stored snapshot.
- Baton currently has no interactive Ask workflow. Operations inside the resolved profile run without
  an additional prompt; everything outside it fails closed. A future approval layer must remain
  separate from profile resolution.

## ADB, LDPlayer, and images

Full access does not require an LDPlayer “connection.” The agent discovers the host in the same way it
discovers any other installed tool, for example `adb devices -l` or `ldconsole list2`, then uses direct
argv calls. This also permits multiple emulator instances without adding per-instance permission
fields.

The older exact-instance LDPlayer grant remains a constrained convenience adapter. It supplies typed
start/tap/swipe/text/key/capture and declarative UX-flow tools, plus content-addressed screenshot
artifacts that can be attached to provider context. It is useful in `workspace` mode and for reliable
image return, but it is not the permission authority and is not required in `full_access`.

Uploads and typed emulator screenshots share the local immutable image store. Canonical JSON stores
artifact references rather than image bytes. Codex receives local/dynamic-tool images, Claude receives
an Anthropic image block at its outbound boundary, and Gemini receives an OpenAI-compatible image URL
part at its outbound boundary.

## Safety and recovery

- Every accepted tool call is durably recorded before execution and its result is recorded before the
  provider continues.
- Mutations are serialized. If Baton loses the result of a mutation, it records an unknown outcome and
  never replays it automatically.
- Profile and allowed-tool lists are part of the durable execution audit record.
- Workspace file writes keep path containment, symlink checks, atomic replace, and SHA-256 CAS even in
  Full access; arbitrary host file access is possible only through the explicitly broader command path.
- Archived conversations cannot change their override. Invalid profiles and unknown request fields are
  rejected before mutation.

## Deferred

- Computer Use remains TODO until its screenshot/action loop, cancellation, approvals, and replay
  semantics can remain under Baton canonical ownership.
- A built-in browser remains TODO. Browser capabilities of the outer development environment are not
  Baton conversation tools.
- Full-Unicode Android text input and orphan image mark-and-sweep remain TODO.
