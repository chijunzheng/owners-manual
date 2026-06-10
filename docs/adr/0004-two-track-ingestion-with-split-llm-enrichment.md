# Two-track ingestion: deterministic structure, LLM enrichment split by granularity

Statute-shaped sources (e-laws HTML) are parsed deterministically into a typed document tree, and chunk boundaries are citable units produced by deterministic tree traversal. PDF sources (policy wordings, declarations, BYOD) are converted by Claude's native PDF reading through the same Agent SDK adapter, cross-checked by a deterministic `pdftotext` coverage diff so no clause can silently vanish. LLM enrichment runs at two granularities: tree-level (cross-reference graph, definitions index, amendment notes — keyed to the tree hash) before chunking, and chunk-level (situating context per the contextual-retrieval pattern — keyed to chunk hash + prompt version) after chunking, because chunk context cannot be written for chunks that don't exist yet and document facts shouldn't be invalidated by chunker changes. No LLM ever re-authors source text: deterministic skeleton, LLM flesh. Corpus builds are content-addressed — `hash(source manifest + pipeline config)` — so every eval result pins to an exact build.

The obvious default was LLM-agentic ingestion end to end (read → clean → semantically chunk → markdown). It was rejected because chunk boundaries must coincide with citable units or pin-cites break; because an LLM "cleaning" pass can silently normalize legally exact wording ("shall" → "will", dropped provisos) in ways no downstream eval reliably catches; and because nondeterministic chunking breaks content-addressed builds, turning every A/B into a comparison against a shifting corpus.

## Considered Options

- **LLM-agentic everywhere**: maximum agentic showcase; breaks citable-unit alignment, paraphrase risk on legal text, irreproducible builds.
- **Fully deterministic**: perfectly reproducible and token-free, but PDF structure recovery is fragile and there is no contextual-enrichment lift to measure — the agentic pre-processing story disappears.

## Consequences

- Ablation flags attach where enrichment is *consumed*, not produced: `chunk_context` (index-time — each arm needs a corpus rebuild and index), `xref_expansion` and `definitions_in_prompt` (query-time — flag flips against the same index, free). Amendment-note flagging ("not yet in force") is a correctness invariant: adversarially eval-tested, never ablated.
- Index-time experiment arms multiply (embeddings × granularity × context), and Atlas M0 caps search indexes (~3), so index-time arms run sequentially via rebuild; the experiment matrix leans on query-time dimensions.
- Per-stage caches keyed to their exact inputs make chunker iteration cheap: tree-level enrichments survive chunker changes; only changed chunks re-enrich.
- Intrinsic ingestion evals become CI citizens: structure-fidelity asserts (every source section appears exactly once), cite round-trips (chunk → path → lookup → identical text), text-fidelity diffs against source, table cell checks on designed fixtures, and a golden extraction set of hand-verified hard sections.
- The PDF track depends on the Agent SDK adapter from day one — ingestion, not just serving, rides the subscription credit.
