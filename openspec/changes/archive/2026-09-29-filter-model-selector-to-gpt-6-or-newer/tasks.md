## 1. Filter Available Model Choices

- [x] 1.1 Add a model-ID predicate to omit recognized `gpt-N` IDs with major versions below 6 while retaining GPT-6+, nonmatching IDs, and existing sort order; verify with focused runtime coverage for the examples in the spec.
- [x] 1.2 Confirm both selector callbacks and direct `/model provider/model-id` selection use the filtered catalogue; verify older GPT IDs are rejected and retained IDs are accepted.

## 2. Document and Validate Behavior

- [x] 2.1 Update the `/model` description in README.md to explain which versioned GPT models are listed and that nonmatching IDs remain available; verify documentation matches the spec.
- [x] 2.2 Run the relevant runtime and command test suites and OpenSpec validation; verify all pass and the change artifacts validate.
