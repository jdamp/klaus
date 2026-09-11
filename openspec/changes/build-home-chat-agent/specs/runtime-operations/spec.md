## Purpose

Define a secure and observable runtime contract for operating the home agent as a small single-instance service in either a homelab VM or a k3s workload.

## ADDED Requirements

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
- **THEN** conversation sessions, delivery state, reminder state, and audit metadata remain available

### Requirement: Secrets are externally supplied and redacted
The system SHALL obtain Telegram, model-provider, MCP, and Home Assistant credentials from mounted secrets or an equivalently protected runtime source. Secret values MUST NOT appear in logs, prompts, conversational storage, or health responses.

#### Scenario: Operator inspects diagnostic output
- **WHEN** logs and health information are produced during authenticated service calls
- **THEN** credential values and authorization headers are absent or redacted

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

#### Scenario: Telegram and storage are ready but Home Assistant is unavailable
- **WHEN** an operator checks service health
- **THEN** the response reports the core service as operating and the Home Assistant integration as degraded

### Requirement: Shutdown preserves processing integrity
The system SHALL stop accepting new work, settle or safely cancel active work, durably record relevant state, close external connections, and release the Telegram consumer during graceful shutdown.

#### Scenario: Runtime sends a termination signal
- **WHEN** the service receives a supported termination signal
- **THEN** it performs bounded graceful shutdown without silently losing a confirmed delivery or leaving an update eligible for duplicate action

### Requirement: Deployment targets share one application artifact
The system SHALL provide a containerized application artifact configurable for operation either under a VM service manager or as a single-replica k3s workload.

#### Scenario: Operator selects a deployment environment
- **WHEN** the same application image is configured with the environment's secrets, persistent data location, and network endpoints
- **THEN** it provides equivalent chat and agent behavior in the VM and k3s targets
