## ADDED Requirements

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
