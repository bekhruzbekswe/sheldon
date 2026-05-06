# chunker Specification

## Purpose

Token-aware text splitter. Produces overlapping windows of ≤400 tokens (paragraph-first, sentence fallback, hard-cut last resort) using the embedder's tokenizer so chunk boundaries align with the embedding model's 512-token window. Used by L3+ to prepare scraped pages for claim extraction.

## Requirements
### Requirement: Split text into windowed chunks bounded by token count

The `chunkText(text, opts?)` function SHALL split the input into an array of `{text, tokenCount}` chunks. Each chunk's `tokenCount` MUST be ≤ `opts.maxTokens` (default 400). Consecutive chunks MUST share approximately `opts.overlapTokens` (default 80) tokens of content.

#### Scenario: Long text produces multiple chunks

- **GIVEN** an input text that tokenizes to ~3000 tokens
- **WHEN** `chunkText(text)` is called with defaults
- **THEN** the returned array has at least 7 chunks
- **AND** every chunk has `tokenCount` ≤ 400

#### Scenario: Short text fits in one chunk

- **GIVEN** an input text that tokenizes to 100 tokens
- **WHEN** `chunkText(text)` is called
- **THEN** the returned array has exactly 1 chunk
- **AND** that chunk's `text` equals the input

### Requirement: Chunk boundaries respect paragraphs and sentences

The chunker SHALL prefer paragraph boundaries (`\n\n`) when splitting. If a single paragraph exceeds `maxTokens`, the chunker MUST fall back to sentence boundaries (`.`/`!`/`?` followed by whitespace). It MUST NOT split mid-sentence except as a last resort when a single sentence exceeds `maxTokens`.

#### Scenario: Multi-paragraph text splits at paragraph boundaries

- **GIVEN** text with 5 paragraphs each ~200 tokens
- **WHEN** `chunkText(text)` runs
- **THEN** every chunk starts at a paragraph boundary in the original text

#### Scenario: Long paragraph falls back to sentence split

- **GIVEN** a single paragraph of 600 tokens with normal sentence punctuation
- **WHEN** `chunkText(text)` runs
- **THEN** the resulting chunks each end at a sentence boundary

### Requirement: Use the embedder's tokenizer

Token counts SHALL be computed using the same tokenizer used by the embedder (`Xenova/all-MiniLM-L6-v2`), so chunk sizes align with embedding model boundaries.

#### Scenario: Token count is consistent with embedder

- **WHEN** `chunkText(text)` produces a chunk reporting `tokenCount: N`
- **THEN** passing that chunk to the embedder yields a token sequence of length ≤ N

### Requirement: Emit one event per chunking call

The chunker SHALL emit a single `chunk.split` event with `layer:'L3'` and `payload` containing the source `url` (if provided), `inputChars`, `chunkCount`, and `totalTokens`.

#### Scenario: Chunking emits an event

- **WHEN** `chunkText(text, {sourceUrl: 'https://x'})` returns 5 chunks
- **THEN** one `chunk.split` event has been emitted with `payload.chunkCount: 5` and `payload.url: 'https://x'`

