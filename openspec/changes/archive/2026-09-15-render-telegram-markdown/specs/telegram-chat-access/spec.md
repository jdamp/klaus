## MODIFIED Requirements

### Requirement: Responses return to the originating chat
The system SHALL deliver each completed assistant response to the Telegram chat that originated the accepted interaction, preserving reply context where available. It SHALL render supported Markdown semantics in completed agent responses as Telegram rich text rather than displaying their markup delimiters literally, while treating unsupported markup and raw HTML as literal text. It SHALL represent supported Markdown list items with visible bullet or ordered markers and preserve nesting through increased visual indentation. It SHALL split content that exceeds Telegram message limits into ordered, independently valid messages without changing the response's textual content or supported formatting semantics. Locally generated command and operational responses SHALL remain plain text unless they explicitly opt into rich-text rendering.

#### Scenario: Agent completes a response
- **WHEN** an agent turn completes successfully for an accepted Telegram interaction
- **THEN** the response is delivered to the originating chat and associated with the triggering message where Telegram supports it

#### Scenario: Agent completes a formatted response
- **WHEN** an agent response contains supported Markdown emphasis, code, links, headings, or lists
- **THEN** Telegram displays the equivalent rich-text semantics without the Markdown delimiters

#### Scenario: Agent response contains literal markup or raw HTML
- **WHEN** an agent response contains unsupported Markdown or raw HTML
- **THEN** Telegram displays that content as literal text and does not interpret it as Telegram markup

#### Scenario: Agent response contains nested lists
- **WHEN** an agent response contains a supported Markdown list with nested items
- **THEN** Telegram displays visible markers for each item and visually indents nested items more than their parent items

#### Scenario: Response exceeds one Telegram message
- **WHEN** a completed formatted agent response is larger than Telegram permits in a single message
- **THEN** the system sends ordered, independently valid formatted messages that preserve the complete response's text and supported formatting semantics

#### Scenario: Plain local response
- **WHEN** a local command or operational error response contains text that resembles Telegram markup
- **THEN** the system delivers it as plain text unless that response explicitly opted into rich-text rendering
