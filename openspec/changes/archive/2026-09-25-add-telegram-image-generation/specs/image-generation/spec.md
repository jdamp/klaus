# Spec Delta

## Purpose

Define a bounded, operator-controlled image-generation capability that remains provider-neutral to agent callers while isolating authentication, transport, and model details behind the configured backend.

## ADDED Requirements

### Requirement: Image generation is explicitly enabled and bounded
The system SHALL expose image generation to the agent only when an operator enables and configures the capability. The model-visible operation SHALL accept a non-empty text prompt within an operator-configured bound and SHALL produce at most one image per invocation. Invalid capability configuration MUST fail closed without granting image-generation authority.

#### Scenario: Image generation is not configured
- **WHEN** an agent session is created without enabled image-generation configuration
- **THEN** no image-generation tool is available to that session

#### Scenario: Enabled tool receives a valid prompt
- **WHEN** the agent invokes the enabled image-generation tool with a non-empty prompt inside the configured bound
- **THEN** the system attempts to generate exactly one image using the configured backend

#### Scenario: Prompt exceeds its bound
- **WHEN** the agent invokes image generation with a prompt larger than the configured limit
- **THEN** the system rejects the invocation before contacting the image backend or creating a delivery intent

### Requirement: The image-generation contract is provider-neutral
The model-visible tool and the application image-generation contract SHALL express provider-neutral inputs and outputs only. Agent callers MUST NOT select or supply provider identifiers, image-model identifiers, backend endpoints, authentication headers, or provider-specific generation options. Provider request and response details SHALL remain confined to the selected backend adapter and operator configuration.

#### Scenario: Agent inspects or invokes the tool
- **WHEN** an agent session receives the image-generation tool definition or a structured tool result
- **THEN** neither surface contains backend endpoints, authentication fields, provider-specific payload fields, or a caller-selectable provider or model

#### Scenario: Backend implementation is replaced
- **WHEN** an operator selects another supported image backend with equivalent capabilities
- **THEN** the agent uses the same tool input and result contract without a conversation or tool-schema migration

### Requirement: Image-provider authentication remains protected
The configured backend SHALL obtain request authentication through the protected provider-authentication runtime and MUST NOT read or parse the persisted authentication file directly. Credentials and authorization headers MUST NOT appear in model context, tool results, conversation storage, delivery payload metadata, audits, logs, or health output. Provider requests MUST use only the backend's fixed configured origin and MUST NOT forward authentication across redirects.

#### Scenario: Subscription credential is used for generation
- **WHEN** the configured image backend requires a refreshable subscription credential
- **THEN** the runtime resolves or refreshes it through protected provider authentication and the backend request is made without exposing the credential to the agent

#### Scenario: Provider attempts to redirect a request
- **WHEN** an authenticated image-generation response redirects to another destination
- **THEN** the system rejects the redirect without forwarding provider authentication

### Requirement: Generated output is validated before publication
The system SHALL enforce configured generation timeout and response-byte limits, propagate caller cancellation where supported, and validate the returned image's supported encoding and decoded byte size before publishing it. A malformed, unsupported, empty, multiple-image, or oversized result MUST NOT create an outbound image intent.

#### Scenario: Backend returns one valid bounded image
- **WHEN** the configured backend returns one supported image whose encoded response and decoded bytes fit their limits
- **THEN** the system makes the validated image available for durable publication

#### Scenario: Backend response exceeds its limit
- **WHEN** the provider response exceeds the configured byte limit while being read
- **THEN** the system stops reading, records a failed bounded outcome, and does not publish an image

#### Scenario: Returned bytes do not match the declared encoding
- **WHEN** the backend returns bytes that do not match a supported generated-image encoding
- **THEN** the system rejects the result without creating an outbound image intent

#### Scenario: Generation is cancelled before publication
- **WHEN** the surrounding turn is cancelled before a generated image is durably published
- **THEN** generation is cancelled where supported and no image is queued for delivery

### Requirement: Successful generation means durable queueing, not delivery
The image-generation tool SHALL report success only after the validated image has been durably queued for delivery to the invoking turn's trusted originating chat. Its structured result SHALL distinguish `queued` from `sent` and MUST NOT claim Telegram delivery has completed. Generated image bytes MUST NOT be copied into the tool result, tool audit record, or durable conversation history.

#### Scenario: Image is generated and queued
- **WHEN** generation succeeds and the durable image intent is stored
- **THEN** the tool returns a bounded structured result stating that one image is queued for the originating chat

#### Scenario: Durable publication fails
- **WHEN** image generation succeeds but its outbound intent cannot be durably stored
- **THEN** the tool reports failure, does not claim the image is queued or sent, and stores no generated bytes in conversation or audit content

#### Scenario: Turn is cancelled after tool completion
- **WHEN** the image tool has durably queued its result before the surrounding agent turn is cancelled
- **THEN** the completed tool outcome remains durable and the queued image remains eligible for delivery

### Requirement: Image-generation outages are isolated and observable
A configured image backend that is unauthenticated, unavailable, incompatible, or failing SHALL degrade only the image-generation capability. The system SHALL present a bounded failure to an attempted tool call and expose privacy-safe degraded health while continuing to serve text conversations and healthy capabilities.

#### Scenario: Configured image provider is unavailable
- **WHEN** a user request causes the agent to invoke image generation while its configured provider is unavailable
- **THEN** the tool reports that image generation failed without claiming success or disrupting unrelated capabilities

#### Scenario: Operator checks degraded health
- **WHEN** the image backend cannot authenticate or complete its bounded readiness check
- **THEN** health output identifies image generation as degraded without disclosing credentials, prompts, image bytes, or private provider response content
