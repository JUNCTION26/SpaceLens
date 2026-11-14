# 8. Evidence and status on every measurement

Status: accepted

## Context

A number in a design tool looks equally trustworthy whether it was measured with a tape, read off a drawing or guessed from a photo.

## Decision

Each measurement stores a `sourceKind`, a `status` (verified, estimated, conflicting, unknown), an optional tolerance and the ids of its evidence (a photo, a PDF page with a region, a manual entry). Operations set these fields; for example a typed wall length becomes manual and verified. The Inspector shows them with what-if diffs, and generated results are tagged as estimates.

## Consequences

People can see how far to trust a number, and the drawings answerer can abstain instead of guessing. Every input path must fill the fields correctly, and the UI carries extra labels.
