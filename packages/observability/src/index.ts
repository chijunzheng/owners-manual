/**
 * Observability surface for owners-manual: Langfuse wiring helpers and the
 * compose-contract reader. Phase-0 stand-up (issue #4); agent/eval tracing
 * builds on this in later issues.
 */
export {
  emitHelloTrace,
  resolveLangfuseHost,
  HELLO_TRACE_NAME,
  LOCAL_LANGFUSE_HOST,
  type HelloTraceResult,
} from './hello-trace.js'

export {
  loadLangfuseCompose,
  composeDataMountSpecs,
  externalDataRootEnvVar,
  REPO_ROOT_MARKER,
  type LangfuseCompose,
  type DataMountSpec,
} from './compose-contract.js'
