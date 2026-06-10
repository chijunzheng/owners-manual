# MongoDB Atlas Vector Search instead of a dedicated vector database

Embeddings live in MongoDB Atlas Vector Search, in the same database as the structured collections (owner profile, session memory, corpus metadata), rather than in Pinecone/Weaviate/Chroma. One datastore gives us hybrid retrieval (vector + BM25 text index) with metadata pre-filtering on corpus and authority level in a single query path, no cross-store consistency problem between chunks and their source-document records, and a free M0 tier.

## Considered Options

- Pinecone/Weaviate: stronger pure-vector ergonomics and the names a reader might expect, but adds a second datastore to operate and sync, and the structured data was going to be in MongoDB regardless.

## Consequences

- Index definitions (vector dimensions, similarity, filter fields) are Atlas-specific; swapping vector stores later means re-ingesting.
- Embedding-model A/B requires either parallel indexes or a re-index per variant — the eval harness treats index build as a reproducible pipeline step for this reason.
