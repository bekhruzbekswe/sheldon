## ADDED Requirements

### Requirement: Optional response_format passthrough

The `LlmClient`'s `fast()` and `deep()` methods SHALL accept an optional `responseFormat` field on the options object. When provided, the value MUST be passed verbatim as the `response_format` field in the upstream chat-completions request body. When absent, the request body MUST NOT include `response_format`.

#### Scenario: JSON schema response format is forwarded

- **WHEN** `llm.fast([...], {responseFormat: {type:'json_schema', json_schema:{name:'r', schema:{...}}}})` is called
- **THEN** the upstream request body's `response_format` field equals the provided value
- **AND** the model's response content is valid JSON matching the schema

#### Scenario: Default behavior is unchanged

- **WHEN** `llm.fast([...])` is called without `responseFormat`
- **THEN** the upstream request body has no `response_format` field
