# MagicDrive code audit — 2026-07-27

## Scope and method

Audited the Worker routes, authentication, D1 migrations, storage drivers, MagicPool, MagicVault, share links, React state, dialogs, uploads, accessibility, and deployment build. CodeGraph was used first for repository navigation. `D:\Arch\OpenList` remains a reference for provider capability and quota-adapter patterns; MagicDrive keeps its own security and pooling model.

## Executed plan

1. Map share, pool, provider, authentication, upload, and frontend state paths.
2. Reproduce the reported MagicVault share failure and add regressions.
3. Run independent backend, share, and frontend audits.
4. Fix confirmed security, data-integrity, correctness, privacy, and accessibility faults.
5. Remove confirmed dead helpers and reduce duplicated provider behavior where safe.
6. Run TypeScript checks, all tests, production build, and Wrangler dry-run.

## Fixed findings

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | MagicVault and MagicPool use synthetic drive IDs, but shares required a physical `drives` row. | Added explicit virtual-share routing and schema constraints. |
| Critical | A later-connected drive with a matching private folder could be merged into MagicPool and deleted by a magician. | Added persisted per-folder drive membership; pool operations now touch verified members only. |
| Critical | Google OAuth state was not bound to the account that started the flow. | OAuth state now stores and verifies `userId` before credential replacement. |
| High | Deleting a user nulled MagicVault ownership while cascading away the drive credentials required to reconstruct files. | Added a database trigger blocking deletion until owned MagicVault objects are handled explicitly. |
| High | Public `/api/drives` responses exposed provider quota, capacity, and failure details and triggered probes. | Only the connection owner receives usage and health details; public/non-owner requests do not probe those providers. |
| High | Failed pool and vault uploads leaked placement reservations for ten minutes. | Reservations now release in `finally`; regressions cover failed provider writes. |
| High | Providers without quota reporting pinned MagicVault segments to the first drive. | Placement now balances by committed bytes held per owner and drive. |
| High | MagicVault folder rename updated the parent and subtree in separate statements. | Rename now uses an atomic D1 batch. |
| High | Concurrent case-variant MagicVault creates could bypass the application preflight. | Added a case-insensitive unique path index and maps constraint races to `409`. |
| High | Recreating a pooled path while deletion retry was active could lose newly uploaded data. | Path reuse is blocked until cleanup settles; retries no longer stop permanently after ten failures. |
| High | Pool upload guessed that names were free when provider listing was incomplete or unreachable. | Upload now fails safely unless every member storage completes the duplicate-name survey. |
| High | Pool rename could overwrite or shadow a name on another member drive. | Rename now requires the containing path and verifies the new name across every pool member. |
| High | Login throttling used raceable KV read-modify-write counters. | Added atomic D1 upsert counters with hashed addresses. |
| High | Vault segment routes could buffer a body larger than the expected segment. | Added exact-length bounded streaming reads before encryption. |
| High | Google multipart upload buffered the source and a second complete multipart copy. | Multipart bodies now stream without duplicating the file in Worker memory. |
| Medium | The first session drive ID was stale server state and could make a drive impossible to remove. | Removed the stale active-drive deletion restriction; selection remains client-side. |
| Medium | Google connections could not be disconnected in-app. | All owned providers now use the same guarded disconnect path. |
| Medium | Provider probes could hang drive pages and placement. | Added a ten-second probe timeout and cached failure status. |
| Medium | WebDAV XML entities broke names containing `&`, `<`, numeric entities, or literal percent data. | Added strict XML entity decoding and safe URI decoding. |
| Medium | S3/WebDAV presets lost their selected brand and appeared as generic base providers. | Added `provider_variant` and `provider_label`. |
| Medium | Physical uploads over the Worker limit failed late; XHR had no timeout; Vault pieces had no retry. | Added 95 MiB client preflight, a ten-minute timeout, and three attempts per MagicVault segment. |
| Medium | Cross-account frontend requests could leave stale shares, drives, files, or dialogs visible after account changes. | Hooks now key requests by account, reject stale responses, and clear state on logout/switch. |
| Medium | Guest share controls caused avoidable `401`s; several dialogs and controls had accessibility/state faults. | Share actions now require a session; busy dialogs, search folders, previews, announcements, mobile targets, labels, and storage preferences were corrected. |
| Low | Unused `unsupported()` and global MagicVault usage helpers remained after refactors. | Removed them. |

## Remaining architecture ceilings

- MagicVault stores one placement per segment. Provider loss can still lose files; replication, repair, and evacuation need a separate storage-format migration.
- MagicPool reports `truncated` after its bounded multi-provider listing walk. Complete large-folder pagination needs a durable namespace/index rather than a larger loop.
- Very large S3 folder deletion is still serial and request-bound. Production scale needs batched `DeleteObjects` plus a resumable deletion job.
- Direct physical uploads are capped and timed out but are not resumable or cancellable from the UI. MagicVault retries pieces but does not resume after a page reload.
- Frontend workflows still lack automated component/browser coverage.
- Provider definitions still have a small fallback copy in the connect dialog for offline/demo startup.
- `admin` and `member` remain schema roles without distinct authorization semantics.

These are explicit scale or product-format projects, not hidden correctness faults in the shipped paths. Erasure coding, P2P, shard repair, and a multi-service control plane remain outside this phase.

## Verification

```text
npm run check                         passed
npm test                              passed
npm run build                         passed
wrangler deploy --dry-run             passed
JavaScript bundle                     465.13 kB / 144.89 kB gzip
CSS bundle                            40.48 kB / 7.95 kB gzip
```

## Deployment order

Fresh databases use the single `0001_initial.sql` baseline. Apply migrations before deploying the Worker.

```powershell
npm run db:migrate:remote
npm run deploy
```
