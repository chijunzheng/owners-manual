/**
 * Renders a {@link VerifyReport} as a deterministic, human-readable report.
 *
 * The shape is the acceptance criterion's "clear report on mismatch": each
 * failing source names itself, its URL, and expected-vs-actual digests so a
 * maintainer can see at a glance whether a source drifted (re-record) or the
 * fetch broke (investigate). Pure string-building — the CLI owns stdout/stderr
 * and the exit code.
 */

import type { SourceResult, VerifyReport } from './verify.js'

function renderOk(result: Extract<SourceResult, { status: 'ok' }>): string {
  return `  ok       ${result.source.id} (${result.actual.bytes} bytes)`
}

function renderMismatch(result: Extract<SourceResult, { status: 'mismatch' }>): string {
  return [
    `  MISMATCH ${result.source.id}`,
    `             url:      ${result.source.url}`,
    `             expected: ${result.expected.sha256} (${result.expected.bytes} bytes)`,
    `             actual:   ${result.actual.sha256} (${result.actual.bytes} bytes)`,
  ].join('\n')
}

function renderError(result: Extract<SourceResult, { status: 'error' }>): string {
  return [
    `  ERROR    ${result.source.id}`,
    `             url:      ${result.source.url}`,
    `             reason:   ${result.message}`,
  ].join('\n')
}

function renderResult(result: SourceResult): string {
  switch (result.status) {
    case 'ok':
      return renderOk(result)
    case 'mismatch':
      return renderMismatch(result)
    case 'error':
      return renderError(result)
  }
}

/** Builds the full multi-line report string for a verification run. */
export function renderReport(report: VerifyReport): string {
  const lines = [
    'Corpus manifest verification',
    `  ${report.okCount} ok, ${report.failedCount} failed`,
    '',
    ...report.results.map(renderResult),
    '',
    report.ok
      ? 'OK — corpus/raw reproduced byte-identically from the manifest.'
      : `FAIL — ${report.failedCount} source(s) did not match the manifest.`,
  ]
  return lines.join('\n')
}
