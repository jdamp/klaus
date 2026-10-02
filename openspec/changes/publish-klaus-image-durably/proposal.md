## Why

The checked-in k3s deployment still points at a 24-hour ttl.sh image, so a fresh pull or rollback will eventually fail. A repeatable GitHub release pipeline is needed to publish a durable image only after the project's quality checks pass.

## What Changes

- Add a GitHub Actions workflow that checks formatting, linting, types, tests, and the production build on pull requests and pushes to `main`.
- Verify the Docker image's existing smoke-test stage before publishing the final image from a successful `main` run.
- Publish the image to public GHCR with a commit SHA tag, record its immutable digest, and verify that the k3s cluster can pull it without registry credentials.
- Replace the temporary image in the checked-in k3s manifest with the published digest and document release, rollout, and rollback steps.

## Capabilities

### New Capabilities

- `image-publishing`: Defines quality-gated publication of a durable, publicly pullable Klaus container image with an immutable deployment reference.

### Modified Capabilities

None. The existing `runtime-operations` contract already covers running the same application artifact in k3s; this change specifies how that artifact is published.

## Impact

- Adds a workflow under `.github/workflows/` and uses GitHub Actions and GHCR.
- Updates `deploy/k3s/klaus-agent.yaml` and deployment documentation when a published digest is available.
- Requires the GHCR package to be set public after first publication; no k3s image pull credential is required.
