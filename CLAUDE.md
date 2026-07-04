# Ariadne — working notes for AI assistants

Ariadne is a local-first PostgreSQL IDE built with Tauri v2 (Rust backend) and
React + TypeScript (frontend). See `docs/` for architecture and design decisions.

## Code comments (open-source standard)

This is a public, open-source codebase. All comments and doc-comments MUST be in
**English**. Never write comments in any other language.

Comment to explain **why**, not **what**. Good comments state a non-obvious
constraint, a rationale, an invariant, or a gotcha that the code itself cannot
convey. Do not narrate what the next line does, restate the code, or leave
`TODO`-style notes to yourself.

- Prefer no comment over a redundant one. Delete comments that only repeat the code.
- Keep them concise and professional — a sentence or two, not a paragraph.
- Do not reference internal ticket numbers, planning docs, or milestone codenames
  (e.g. "design 19 §X4", "P1-Y3") in code comments. Make the comment self-contained;
  if deeper context is needed, it belongs in `docs/`.
- Rust: use `//!` for module docs and `///` for item docs; `//` for inline notes.
- TS/TSX: use `//` and `/** */`; no framework-specific comment conventions needed.

## Build & verify

- Backend: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
  (needs `LIBCLANG_PATH` set for `pg_query`'s bindgen; on Windows LLVM lives at `C:\Program Files\LLVM`).
- Frontend: `npm run build` (runs `tsc` then `vite build`).
- Live-DB tests: `ARIADNE_DATABASE_URL=… cargo test -- --ignored` (read-only + TEMP tables only).
- The full gate must be green before every commit.
