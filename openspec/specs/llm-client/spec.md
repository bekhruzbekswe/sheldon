# llm-client Specification

## Purpose

Send chat-completion requests to an OpenAI-compatible endpoint (llama.cpp serving Qwen3.5-9B at `ai.mayoq.tech`) with selectable thinking mode and a non-default User-Agent. Provides the `fast()` (no thinking) and `deep()` (thinking on) primitives that every higher layer of Sheldon calls into.
## Requirements
### Requirement: Send chat-completion requests with selectable thinking mode

The `LlmClient` SHALL expose two methods, `fast` and `deep`, that send a chat-completion request to an OpenAI-compatible endpoint. `fast` MUST set `chat_template_kwargs.enable_thinking = false` in the request body. `deep` MUST set `chat_template_kwargs.enable_thinking = true`.

#### Scenario: Fast mode produces a response without reasoning content

- **WHEN** the caller invokes `client.fast([{role:'user', content:'2+2'}])`
- **THEN** the request body contains `chat_template_kwargs: { enable_thinking: false }`
- **AND** the returned object's `reasoning` field is empty or undefined
- **AND** the returned object's `content` field contains the model's answer

#### Scenario: Deep mode includes reasoning content

- **WHEN** the caller invokes `client.deep([{role:'user', content:'a hard math problem'}])`
- **THEN** the request body contains `chat_template_kwargs: { enable_thinking: true }`
- **AND** the returned object's `reasoning` field contains the model's chain of thought
- **AND** the returned object's `content` field contains the final answer

### Requirement: Use a non-default User-Agent header

The `LlmClient` SHALL send `User-Agent: Mozilla/5.0` on every outbound request. Using the OpenAI SDK's default User-Agent or any UA matching `OpenAI/*` MUST NOT happen.

#### Scenario: Outgoing request carries Mozilla User-Agent

- **WHEN** any LlmClient method dispatches an HTTP request
- **THEN** the request's `User-Agent` header is exactly `Mozilla/5.0`

### Requirement: Authenticate with a bearer token from environment

The `LlmClient` SHALL read its bearer token from the `LLM_API_KEY` environment variable at construction time. If the variable is missing or empty, construction MUST throw with a clear message.

#### Scenario: Missing API key fails fast

- **WHEN** `new LlmClient(...)` is constructed and `process.env.LLM_API_KEY` is unset
- **THEN** construction throws an Error whose message references `LLM_API_KEY`

#### Scenario: Bearer token is sent on each request

- **GIVEN** `LLM_API_KEY=sk-test-abc`
- **WHEN** `client.fast(...)` dispatches its HTTP request
- **THEN** the request's `Authorization` header is `Bearer sk-test-abc`

### Requirement: Read endpoint URL from environment

The `LlmClient` SHALL read its base URL from the `LLM_BASE_URL` environment variable at construction time. The URL MUST end without a trailing slash; the client appends `/v1/chat/completions`.

#### Scenario: Default URL is required

- **WHEN** `new LlmClient(...)` is constructed and `process.env.LLM_BASE_URL` is unset
- **THEN** construction throws an Error whose message references `LLM_BASE_URL`

### Requirement: Return content, reasoning, usage, and timing

Each call to `fast` or `deep` SHALL return an object containing `content` (string), `reasoning` (string, may be empty), `usage` (object with `prompt_tokens`, `completion_tokens`, `total_tokens`), and `latencyMs` (number). The client MUST NOT discard these fields even if downstream callers ignore them.

#### Scenario: All four fields are populated

- **WHEN** `client.fast(...)` resolves successfully
- **THEN** the returned object has properties `content`, `reasoning`, `usage`, `latencyMs`
- **AND** `latencyMs` is a positive number measured from request dispatch to full response receipt

### Requirement: Surface non-2xx responses as Errors

If the endpoint returns a non-2xx HTTP status, the client SHALL throw an Error containing the status code and the response body (truncated to 500 chars).

#### Scenario: 401 on bad token

- **GIVEN** `LLM_API_KEY=invalid`
- **WHEN** `client.fast(...)` dispatches its request
- **THEN** the call throws with a message containing `401` and `Invalid API Key` (or whatever body the server returns)

### Requirement: Emit a structured event for every LLM call

For each invocation of `fast()` or `deep()`, the `LlmClient` SHALL emit one event to the event log with kind `llm.fast` or `llm.deep` respectively, layer `L0`, `durationMs` set to the call latency, and `payload` containing `prompt_tokens`, `completion_tokens`, `total_tokens`, and a short text excerpt of the user's last message (≤80 chars). Failed requests MUST also emit an event with the same kind plus an `error` field in the payload before the error is thrown.

#### Scenario: Successful fast call emits an event

- **GIVEN** the event log is empty
- **WHEN** `llm.fast([{role:'user', content:'2+2'}])` resolves successfully
- **THEN** exactly one event has been emitted with `kind='llm.fast'`, `layer='L0'`, a positive `durationMs`, and a payload containing `prompt_tokens`, `completion_tokens`, `total_tokens`

#### Scenario: HTTP 401 also emits an event

- **GIVEN** an invalid API key is configured
- **WHEN** `llm.fast([...])` is called
- **THEN** one event with `kind='llm.fast'` is emitted whose payload includes an `error` field containing `401`
- **AND** the original Error is then thrown to the caller

### Requirement: Optional response_format passthrough

The `LlmClient`'s `fast()` and `deep()` methods SHALL accept an optional `responseFormat` field on the options object. When provided, the value MUST be passed verbatim as the `response_format` field in the upstream chat-completions request body. When absent, the request body MUST NOT include `response_format`.

#### Scenario: JSON schema response format is forwarded

- **WHEN** `llm.fast([...], {responseFormat: {type:'json_schema', json_schema:{name:'r', schema:{...}}}})` is called
- **THEN** the upstream request body's `response_format` field equals the provided value
- **AND** the model's response content is valid JSON matching the schema

#### Scenario: Default behavior is unchanged

- **WHEN** `llm.fast([...])` is called without `responseFormat`
- **THEN** the upstream request body has no `response_format` field

