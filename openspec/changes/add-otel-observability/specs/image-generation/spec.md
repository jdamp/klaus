## ADDED Requirements

### Requirement: Image generation is represented in configured traces
When tracing is configured, the system SHALL trace an image-generation request with provider, model, timing, outcome, and bounded, redacted text prompt content. It MUST NOT export generated image bytes, encoded image content, provider credentials, or authentication headers.

#### Scenario: Image generation succeeds
- **WHEN** an enabled image-generation tool creates and queues an image
- **THEN** the trace identifies the generation call, includes its redacted text prompt, and reports success without image bytes

#### Scenario: Image generation fails
- **WHEN** a provider request fails or is cancelled
- **THEN** the trace reports the outcome without response bodies, image bytes, or credentials
