## Purpose

Define reliable calendar-derived household reminders that are delivered through Telegram on schedule without requiring language-model interpretation or duplicating external calendar ownership.

## ADDED Requirements

### Requirement: Reminder events come from configured calendar entities
The system SHALL obtain events from configured Home Assistant calendar entities over a bounded future time window and periodically refresh them. Home Assistant SHALL remain the aggregation boundary for external sources such as a shared Google Calendar.

#### Scenario: Shared calendar is available through Home Assistant
- **WHEN** synchronization queries a configured Home Assistant calendar entity
- **THEN** the system caches the returned events needed to calculate upcoming reminders

#### Scenario: Calendar source is temporarily unavailable
- **WHEN** a scheduled refresh cannot reach Home Assistant
- **THEN** previously calculated future reminders remain available while the failure is reported for retry

### Requirement: Operators can define deterministic reminder rules
The system SHALL allow an operator to configure a calendar entity, event matching criteria, delivery offset or local delivery time, destination Telegram chat, message template, and enabled state for each reminder rule.

#### Scenario: Garbage collection event matches a rule
- **WHEN** a cached calendar event matches an enabled garbage-collection reminder rule
- **THEN** the system calculates the configured Telegram delivery occurrence

#### Scenario: Calendar event does not match
- **WHEN** a calendar event does not satisfy any enabled reminder rule
- **THEN** the system creates no delivery for that event

### Requirement: Scheduled reminders do not invoke the language model
The system SHALL render and enqueue configured reminder messages deterministically without starting an agent conversation or sending event content to an LLM.

#### Scenario: Reminder becomes due
- **WHEN** a calculated reminder occurrence reaches its delivery time
- **THEN** the configured message is queued for Telegram delivery without an agent invocation

### Requirement: Calendar changes update pending reminders
The system SHALL reconcile changed, moved, and cancelled calendar occurrences so that affected reminders not yet delivered are updated or cancelled.

#### Scenario: Collection event moves to another day
- **WHEN** synchronization finds that a previously cached occurrence has a different start date
- **THEN** its unsent reminder is rescheduled according to the rule

#### Scenario: Calendar event is cancelled
- **WHEN** synchronization identifies a cancelled or removed occurrence
- **THEN** any unsent reminder derived from that occurrence is cancelled

### Requirement: Reminder delivery is durable and idempotent
The system SHALL durably record reminder occurrences and Telegram delivery attempts. The same rule and calendar occurrence MUST NOT produce more than one successful delivery for a given destination and offset.

#### Scenario: Service restarts while a reminder is due
- **WHEN** the service restarts after a reminder is queued but before its successful delivery is durably confirmed
- **THEN** it resumes delivery without creating duplicate successful notifications

### Requirement: Overdue reminders follow an explicit misfire policy
The system SHALL send a slightly overdue reminder within a configured grace period and SHALL skip a stale reminder outside that period while calculating later occurrences normally.

#### Scenario: Short outage crosses reminder time
- **WHEN** the service resumes within the reminder's grace period
- **THEN** the overdue reminder remains eligible for delivery

#### Scenario: Long outage leaves a stale reminder
- **WHEN** the service resumes after the reminder's grace period has elapsed
- **THEN** the stale occurrence is marked skipped rather than delivered late

### Requirement: Calendar time semantics are preserved
The system SHALL calculate reminder times using an explicitly configured household IANA timezone and SHALL interpret all-day events consistently with Home Assistant's local calendar semantics.

#### Scenario: All-day collection event spans a daylight-saving transition
- **WHEN** a reminder is derived from an all-day event near a timezone offset change
- **THEN** the notification is scheduled at the configured household-local time

