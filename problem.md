# Problem Statement: claude-agent-sdk-pi v2 (type-safe refactor)

## What we want

We want to refactor `claude-agent-sdk-pi` into a **clean, type-safe, modular SDK wrapper** with a simple API for adding features.

### Product goals

1. **Safe by default**
   - strict TypeScript
   - no "ignore errors" style
   - robust handling for non-happy paths
2. **Simple made easy**
   - easy public API
   - feature additions should be straightforward
3. **Good OSS architecture**
   - avoid one giant file
   - SOLID-ish boundaries
   - easy for contributors to understand
4. **Plugin-friendly and typed**
   - first-class typed tool plugins
   - typed hook system for feature extensions
5. **Practical runtime constraints**
   - keep install UX simple (`pi install ...`)
   - avoid heavy startup overhead

---

## Decisions made

- Branch: `refactor/effect-type-safe-api`
- Version target: `2.0.0-alpha.0`
- API direction:
  - `createProvider({ features })`
  - typed hook pipeline (`beforeQuery`, `onStreamEvent`, `onToolCall`, `onToolResult`)
- Errors: **exposed typed errors** (not internal-only)

---

## What is done already

### 1) Versioning and strictness

- `package.json`
  - bumped to `2.0.0-alpha.0`
  - added `effect`
  - added `typescript` dev dependency
- `tsconfig.json`
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `useUnknownInCatchVariables: true`

### 2) Code split (start of de-monolith)

Created modular structure under `src/`:

- `src/core/constants.ts`
- `src/core/errors.ts`
- `src/core/features.ts`
- `src/config/providerSettings.ts`
- `src/mapping/toolNames.ts`
- `src/mapping/toolArgs.ts`
- `src/index.ts`

Root entry now re-exports from `src/`:

- `index.ts`

### 3) New typed extension API

- Added `createProvider(options)`
- Added feature runtime with typed hooks:
  - `onRegister`
  - `beforeQuery`
  - `onStreamEvent`
  - `onToolCall`
  - `onToolResult`
- Added typed tool plugin helper:
  - `createToolPlugin(...)`

### 4) Exposed typed error model

- `ClaudeAgentSdkProviderError`
- `ClaudeAgentSdkProviderErrorCode`
- `toProviderError(...)`

### 5) Docs updated

- README now includes a v2 alpha API usage example.

### 6) Build verification

- `npx tsc --noEmit` passes.

### 7) Model selection bug fix

- Fixed a routing bug where selected pi model (e.g. Haiku) was not forwarded to Claude SDK query options.
- Query options now explicitly set `model: model.id`, so the active `/model` selection is respected.

### 8) Stream engine extraction + decomposition completed

- Stream orchestration was extracted from `src/index.ts` into `src/provider/stream.ts`.
- Then further split into focused provider modules:
  - `src/provider/stream.ctx.ts`
  - `src/provider/stream.text.ts`
  - `src/provider/stream.tool.ts`
  - `src/provider/stream.thinking.ts`
  - `src/provider/stream.dispatch.ts`
  - `src/provider/stream.stop.ts`
  - `src/provider/stream.opts.ts`
- `src/index.ts` now acts mostly as wiring/composition for provider registration.

### 9) Test coverage expanded for stream and decoder behavior

- Added stream behavior tests covering:
  - text flow start/delta/end/done
  - tool call start/delta/end + `mapToolArgs` mapping
  - malformed SDK stream event boundary (`invalid_sdk_event` at stream error boundary)
  - stop reason mapping (`toolUse`, `length`, `stop`)
- Added focused unit tests for stream dispatch/reducer modules.
- Added boundary decoder tests for loose index events in `src/decoders/index.events.ts`.

### 10) Effect-first hardening pass completed across runtime modules

- Added dedicated decoder module for tool-watch hydration/parsing:
  - `src/decoders/toolWatch.entries.ts`
- Added extension event typing augmentation:
  - `src/decoders/pi.events.d.ts`
- Added SDK MCP typing augmentation to avoid unsafe schema cast at provider boundary:
  - `src/decoders/sdk.mcp.d.ts`
- Removed unsafe runtime casts and `any` leakage in:
  - `src/provider/toolWatch.ts`
  - `src/provider/stream.ts`
  - `src/provider/stream.opts.ts`
  - `src/provider/stream.tool.ts`
  - `src/core/features.ts`
  - `src/config/providerSettings.ts`
  - `src/index.ts` (event wiring + prompt/image handling)
- Current state: runtime `src/` no unsafe `as` casts and no `any` (remaining `as const` only).

### 11) Additional direct unit tests added (edge-focused)

- `tests/provider/stream.thinking.test.ts`
- `tests/provider/stream.stop.test.ts`
- `tests/provider/stream.opts.test.ts`
- Expanded `tests/provider/toolWatch.test.ts` malformed-entry coverage.
- Updated existing tests to reduce type escapes and improve typed fixtures.
- Removed remaining stream test SDK message cast by switching to typed beta stream-event fixtures.

---

## What is not done yet

1. Evaluate replacing SDK MCP typing augmentation with a stricter schema adapter (if we want to avoid declaration widening long-term).
2. Decide/finalize extraction of tool-watch event wiring from `src/index.ts` into a dedicated feature module.
3. Add migration/backward-compatibility notes beyond alpha docs.

---

## Next planned steps

1. Explore strict conversion/adapter for custom tool schemas instead of declaration-level widening.
2. Optionally extract tool-watch wiring from `src/index.ts` into a focused feature module (minimal diff).
3. Add migration/backward-compatibility notes beyond alpha docs.
4. Keep adding TDD slices for any new boundary hardening.
5. Re-run `npm test` + `npm run typecheck` after each slice.

---

## Local testing (manual)

### Quick run without installing

```bash
pi -e ./index.ts
```

`-e` / `--extension` is good for quick local iteration.

### Recommended dev workflow with reload

Place/symlink extension into an auto-discovered location:

- Global: `~/.pi/agent/extensions/`
- Project: `.pi/extensions/`

Then use:

```bash
/reload
```

inside pi to hot-reload changes.

### Type check

```bash
npx tsc --noEmit
```
