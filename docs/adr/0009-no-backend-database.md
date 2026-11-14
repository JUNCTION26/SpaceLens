# 9. No backend database yet

Status: accepted

## Context

Models are small, belong to one person and are edited in one browser. Accounts and server-side storage would add a login system and a data-protection duty for little gain at this stage.

## Decision

Models and settings are kept in browser storage (`spacelens.model.v1`, `spacelens.settings.v1`). Sharing encodes the whole model, compressed, in the URL hash (`export/share.ts`). Uploaded plans stay in the browser.

## Consequences

There are no accounts and no server-side copy to leak. Models are not synced across devices, share links are long and carry the entire model, and clearing site data deletes the work. A database becomes the right choice when people need the same model on several devices, shared editing or comments, version history beyond one browser, or short share links with permissions. That would need authentication, per-model access control, a storage migration and an updated privacy note first.
