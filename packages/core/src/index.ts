/**
 * Shared core for the owners-manual TypeScript product (serving path).
 *
 * This is a Phase-0 scaffold placeholder: it exists so the pnpm workspace,
 * vitest, eslint, prettier, and tsc are wired and green before the real
 * document-tree schema, chunker, and agent land in later issues.
 */

export const PACKAGE_NAME = '@owners-manual/core'

/** Marks that the TypeScript workspace scaffold is wired and importable. */
export function scaffoldReady(): boolean {
  return true
}
