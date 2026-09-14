## ADDED Requirements

### Requirement: Active agent turns expose transient processing feedback
The system SHALL publish Telegram's native typing chat action when an accepted interaction begins active execution and SHALL refresh the action often enough to remain visible while that turn is executing. The system SHALL stop refreshing after processing settles successfully or unsuccessfully. Chat-action publication MUST be best-effort and MUST NOT change agent execution, update state, or response delivery outcomes.

#### Scenario: Accepted turn begins active execution
- **WHEN** an accepted interaction reaches the front of its chat's queue and begins executing
- **THEN** the originating chat receives a typing action without waiting for the final response

#### Scenario: Turn waits behind earlier work
- **WHEN** an accepted interaction is waiting behind another interaction in the same chat
- **THEN** the system does not publish typing actions on behalf of the waiting interaction

#### Scenario: Long-running turn remains active
- **WHEN** an executing agent turn lasts longer than one Telegram typing-action visibility period
- **THEN** the system refreshes the typing action so processing feedback remains visible

#### Scenario: Turn processing settles
- **WHEN** an executing turn completes successfully or fails
- **THEN** the system stops refreshing its typing action

#### Scenario: Telegram rejects a typing action
- **WHEN** publishing or refreshing a typing action fails
- **THEN** the system continues the turn and preserves its normal update-state and response-delivery behavior

#### Scenario: Update does not produce a turn
- **WHEN** an update is unauthorized, ignored, or already claimed
- **THEN** the system does not publish a typing action for that update
