# Runtime Operations Specification

## Purpose

Define a secure and observable runtime contract for running the home agent locally and operating it as a small single-instance k3s workload.

## Requirements

### Requirement: The service runs without a public inbound endpoint
The system SHALL support receiving Telegram updates through long polling so the initial deployment does not require a public webhook or ingress endpoint.

#### Scenario: Service runs on a private homelab network
- **WHEN** the service has outbound access to Telegram and configured model and MCP endpoints
- **THEN** authorized users can interact without exposing an inbound Internet route

### Requirement: Only one active Telegram consumer processes updates
The system SHALL ensure that one logical service instance consumes Telegram updates for a configured bot at a time.

#### Scenario: k3s deployment is upgraded
- **WHEN** a new workload instance replaces the current instance
- **THEN** the deployment avoids concurrent consumers executing the same bot updates

### Requirement: Durable application data uses a persistent location
The system SHALL store SQLite state and other durable application data in a configurable persistent location that survives service and container restarts.

#### Scenario: Container is recreated
- **WHEN** the replacement instance mounts the existing persistent data location
- **THEN** conversation sessions, delivery state, tool audit metadata, and Pi provider authentication state remain available

### Requirement: Secrets are externally supplied and redacted
The system SHALL obtain Telegram and MCP credentials from mounted secrets or an equivalently protected runtime source. Pi-managed provider credentials SHALL use a protected, writable, persistent authentication location separate from conversation storage. Secret values MUST NOT appear in logs, prompts, conversational storage, or health responses.

#### Scenario: Operator inspects diagnostic output
- **WHEN** logs and health information are produced during authenticated service calls
- **THEN** credential values and authorization headers are absent or redacted

### Requirement: Pi manages model-provider authentication
The system SHALL use Pi's model runtime for provider authentication and SHALL allow provider, model, reasoning level, and authentication location to be configured. Subscription-backed OAuth and API-key-based providers SHALL be supported without application-specific provider credential parsing.

#### Scenario: Subscription credential is refreshed
- **WHEN** Pi refreshes an expiring subscription-backed provider credential
- **THEN** the refreshed state is written to the configured persistent authentication location and remains usable after restart

#### Scenario: Provider settings change
- **WHEN** an operator selects another Pi-supported provider, model, or reasoning level with valid credentials
- **THEN** the service uses those settings without requiring a code change

### Requirement: Security-critical configuration fails closed
The system SHALL refuse to process chat messages when required identity allowlists, Telegram credentials, or capability policy are missing or invalid. An optional downstream integration failure SHALL degrade only that integration.

#### Scenario: User allowlist cannot be parsed
- **WHEN** the service starts with an invalid user allowlist
- **THEN** it does not begin Telegram message processing and exposes the configuration error operationally

#### Scenario: Optional MCP server cannot connect
- **WHEN** required core configuration is valid but an optional MCP endpoint is unavailable
- **THEN** the service starts in a degraded state with that capability disabled

### Requirement: Health and diagnostics distinguish service states
The system SHALL expose liveness and readiness information that distinguishes core readiness from degraded optional dependencies without disclosing secrets or private message content.

#### Scenario: Telegram and storage are ready but an MCP server is unavailable
- **WHEN** an operator checks service health
- **THEN** the response reports the core service as operating and the affected MCP integration as degraded

### Requirement: Shutdown preserves processing integrity
The system SHALL stop accepting new work, settle or safely cancel active work, durably record relevant state, close external connections, and release the Telegram consumer during graceful shutdown.

#### Scenario: Runtime sends a termination signal
- **WHEN** the service receives a supported termination signal
- **THEN** it performs bounded graceful shutdown without silently losing a confirmed delivery or leaving an update eligible for duplicate action

### Requirement: Local and k3s runtimes share one application artifact
The system SHALL provide one application artifact that can run directly for local development and as a single-replica containerized k3s workload.

#### Scenario: Developer runs the service locally
- **WHEN** the application is started locally with valid configuration, protected credentials, and writable temporary storage
- **THEN** it provides the same chat, conversation, and capability behavior as the packaged runtime

#### Scenario: Operator deploys to k3s
- **WHEN** the application image is configured with mounted secrets, persistent application and Pi-authentication storage, and required network endpoints
- **THEN** it operates as one active Telegram consumer with equivalent behavior
