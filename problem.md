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

---

## What is not done yet

1. Full decomposition of `src/index.ts` into smaller provider/feature modules.
2. Removal of remaining loose typings (`any` hotspots) in stream/event parsing paths.
3. Runtime schema decoding for all external SDK event payloads.
4. Automated tests for feature runtime, error mapping, and tool plugin behavior.
5. Backward-compatibility/migration notes beyond alpha docs.

---

## Next planned steps

1. Extract stream engine into `src/provider/stream.ts`.
2. Move tool-watch logic into a dedicated feature module.
3. Add runtime decoders for SDK message/event boundaries.
4. Add tests for:
   - feature hook execution order
   - typed plugin decoding paths
   - provider error wrapping/exposure
5. Reduce remaining `any` usage to near-zero.

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
