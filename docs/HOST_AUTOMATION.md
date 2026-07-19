# Host automation boundary

## Implemented now

Baton can connect one exact LDPlayer instance to one canonical conversation. The grant is durable,
revision-CAS guarded, and can be changed or revoked only while the thread is idle and no Goal is
active.

The model receives only these Baton-owned tools:

- inspect or start the granted instance;
- tap, swipe, bounded ASCII text input, and Android key events;
- capture the screen;
- run a bounded declarative UX-flow template made from the same operations plus waits and capture
  points.

There is no generic command string, raw ADB tool, arbitrary executable path, or host shell escape.
Every mutating operation is serialized by the canonical tool coordinator. If Baton stops after a
host mutation but before durably recording its result, the operation is marked as an unknown
mutation outcome and is never replayed automatically.

## Images are model context, not just files

Uploads and LDPlayer screenshots use the same content-addressed local image store. Canonical JSON
contains an immutable artifact reference and never embeds the image bytes.

Provider materialization follows the installed Codex Desktop and current Codex app-server contracts:

- current Codex user attachments become `localImage` turn inputs;
- prior Codex image history becomes `input_image` content;
- image-producing Baton tools return app-server dynamic-tool `inputImage` content;
- Claude receives an Anthropic base64 image block only at its outbound HTTP boundary;
- Gemini receives an OpenAI-compatible `image_url` part only at its outbound HTTP boundary.

Provider-private continuation records retain Baton artifact references, not base64 payloads. This is
required for bounded SQLite growth and deterministic replay even though Baton is a personal local
proxy.

The implementation was checked against the local current Codex source clone and the installed
Codex Desktop bundle, especially the Desktop attachment picker/local-image conversion and the
app-server `UserInput::LocalImage` and dynamic-tool `InputImage` schemas.

## Explicitly deferred

- **Computer Use:** TODO only. Do not expose until its screenshot/action loop, permission scope,
  cancellation, and replay semantics can be kept under Baton canonical ownership.
- **Built-in browser:** TODO only. The existing browser capabilities of outer development agents are
  not part of Baton canonical runtime.
- **Full Unicode ADB text input:** TODO. Android `input text` is deliberately limited to a safe ASCII
  subset; Unicode requires a separately installed and explicitly trusted input method.
- **Orphan image collection:** TODO. Content-addressed images that were uploaded but never attached
  to a canonical item need a retention-aware mark-and-sweep job before storage growth is unattended.

Electron migration is not required for this boundary. The React UI remains the permission and
visibility surface while the same-origin local Baton BFF owns host process access and artifacts.
