## 1. Quality-gated GitHub workflow

- [x] 1.1 Add a GitHub Actions workflow for pull requests to `main` and pushes to `main` that installs the pinned Node/npm toolchain, runs `npm ci` and `npm run check`, and grants the quality job only read access; verify the workflow definition and a pull request run execute formatting, linting, type checking, tests, and build.
- [x] 1.2 Add a dependent container verification job that builds the Dockerfile's `verification` target without publishing; verify `docker build --target verification .` passes and the pull request job reports its smoke-test result.
- [ ] 1.3 Add a `main`-push-only publish job that depends on both gates, builds the `final` target, uses repository-scoped `GITHUB_TOKEN` with `packages: write`, tags the image with the full commit SHA, and reports its digest; verify a successful main run publishes the expected revision and a failed gate yields no image for that revision.
- [x] 1.4 Pin third-party workflow actions to reviewed commit SHAs and associate the image with its source repository; verify the workflow has no personal access token or cluster credentials and passes workflow syntax validation.

## 2. Public registry and deployment

- [ ] 2.1 Confirm the k3s node architecture and select a matching image platform; verify the published digest identifies an image the target node can pull and run.
- [ ] 2.2 Set the GHCR package public after its first push and verify a fresh unauthenticated pull by digest, including from the `klaus` cluster; verify no registry image pull Secret is needed.
- [ ] 2.3 Update the checked-in k3s manifest from ttl.sh to the verified GHCR digest and keep the existing single-replica `Recreate` behavior; verify deployment tests and manifest inspection pass.
- [ ] 2.4 Update deployment and operations docs with the release digest, public pull check, rollout checks, and rollback to a previously recorded durable digest; verify the instructions match the manifest and require no registry credential.

## 3. Rollout and release evidence

- [ ] 3.1 Back up persistent data, roll out the digest to the existing `klaus` namespace, and verify a fresh pull, readiness, Home Assistant and Kaneo MCP discovery, and restart continuity; record the source commit, digest, time, and results.
- [ ] 3.2 Record the previous durable digest and demonstrate the documented rollback path, or explicitly record why the first cutover lacks a previous durable image; verify the release record identifies a compatible configuration and data backup.
