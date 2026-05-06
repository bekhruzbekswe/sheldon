# web-scraper Specification

## Purpose

Fetch a URL and extract its main article text via Mozilla Readability over jsdom. Designed for hostile real-world web pages: returns null and emits a `scrape.skip` event on any failure (network error, non-HTML content, paywalls, Readability misses) rather than throwing, so higher layers can degrade gracefully.

## Requirements
### Requirement: Fetch a URL and extract main article content

The `scraper.fetch(url)` function SHALL send an HTTP GET with `User-Agent: Mozilla/5.0` and a 15-second timeout, parse the response HTML through `jsdom`, run `@mozilla/readability`, and return `{ url, title, text, charCount }` where `text` is the cleaned plaintext.

#### Scenario: Article URL is extracted to plaintext

- **GIVEN** a URL pointing to a typical news article (e.g., a Wikipedia page)
- **WHEN** `scraper.fetch(url)` is called
- **THEN** the returned object has a non-empty `text` field
- **AND** `charCount` matches `text.length`

### Requirement: Non-HTML responses are skipped, not thrown

If the response `Content-Type` does not start with `text/html`, the function SHALL return `null` (skip) rather than throwing, and emit a `scrape.skip` event with the reason.

#### Scenario: PDF URL returns null

- **GIVEN** a URL whose response Content-Type is `application/pdf`
- **WHEN** `scraper.fetch(url)` is called
- **THEN** the call resolves to `null`
- **AND** one `scrape.skip` event is emitted with `payload.reason` containing "non-html"

### Requirement: Readability failure returns null

If Readability cannot extract content (parser returns null or empty article), the function SHALL return `null` rather than throwing, and emit a `scrape.skip` event with the reason.

#### Scenario: Readability gives up

- **GIVEN** an HTML page Readability can't parse
- **WHEN** `scraper.fetch(url)` is called
- **THEN** the call resolves to `null`
- **AND** one `scrape.skip` event is emitted with `payload.reason` containing "readability"

### Requirement: Network failures are skipped, not thrown

If the HTTP fetch fails (DNS, connection refused, timeout, non-2xx), the function SHALL return `null` and emit a `scrape.skip` event whose payload includes the error message.

#### Scenario: 404 is skipped

- **GIVEN** a URL that returns HTTP 404
- **WHEN** `scraper.fetch(url)` is called
- **THEN** the call resolves to `null`
- **AND** one `scrape.skip` event is emitted with `payload.reason` containing "404"

### Requirement: Emit a fetch event on success

On successful extraction the function SHALL emit a `scrape.fetch` event with `layer:'L2'`, `durationMs`, and `payload` containing `url`, `title` (truncated), and `charCount`.

#### Scenario: Successful fetch emits event

- **WHEN** a successful `scraper.fetch(url)` resolves
- **THEN** one `scrape.fetch` event is appended whose payload includes `url`, `title`, and a positive `charCount`

### Requirement: Truncate cleaned text past a budget

If the extracted text exceeds 24000 characters (~6000 tokens), it SHALL be truncated to 24000 characters and the result MUST include `truncated: true`.

#### Scenario: Long article is truncated

- **GIVEN** a page whose cleaned text would be 50000 characters
- **WHEN** `scraper.fetch(url)` is called
- **THEN** the returned object has `text.length === 24000`
- **AND** the returned object's `truncated` field is `true`

