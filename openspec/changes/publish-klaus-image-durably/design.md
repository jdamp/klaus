## Context

See `proposal.md` for the release problem and `specs/image-publishing/spec.md` for the behavior contract. The repository already has `npm run check`, a pinned multistage Dockerfile with `verification` and `final` targets, and a single-replica k3s manifest using `Recreate`. The manifest currently names a ttl.sh image. GHCR packages are private at first publication unless their visibility is changed.

## Goals / Non-Goals

**Goals:**

- Make the same source revision pass repository and container checks before its final image is pushed.
- Give operators a durable digest to place in the manifest and record for rollback.
- Keep the cluster's image pull anonymous by making the GHCR package public.

**Non-Goals:**

- Automatically deploy from GitHub Actions or give the workflow cluster credentials.
- Put application, model, Telegram, or registry credentials into the image or repository.
- Publish images from pull request code.

## Decisions

1. **Use one GitHub Actions workflow on pull requests targeting `main` and pushes to `main`.** A quality job installs the pinned Node/npm toolchain, runs `npm ci` and `npm run check`, and grants only repository read access. A dependent container job builds the Dockerfile's `verification` target, which runs the existing container smoke test. A publish job depends on both gates and runs only for a push to `main`. GitHub job dependencies make any failure block publication. Separate, independently triggered workflows were rejected because their success is harder to tie to the exact published revision.

2. **Build and push only the Dockerfile's `final` target for `linux/amd64`.** Use Buildx and the existing Dockerfile for both verification and publication. The publish job tags `ghcr.io/<repository-owner>/klaus-agent` with the full commit SHA and reports the registry digest in the job summary. Deployments use `image@sha256:...`; the commit tag is for discovery, not a claim of immutability. Confirm the target k3s node is amd64 and verify the published digest there before rollout. A mutable `latest` deployment reference was rejected because it cannot identify the exact rollback image.

3. **Use GitHub's repository-scoped `GITHUB_TOKEN` only in the publish job.** That job receives `contents: read` and `packages: write`, logs in to `ghcr.io`, and associates the image with the source repository. The pull request jobs have no package write permission. Pin third-party actions to reviewed commit SHAs. A personal access token was rejected because it creates a separately managed publishing secret without a demonstrated need.

4. **Treat public visibility as a release prerequisite.** After the first push, set the GHCR package public in GitHub and verify an unauthenticated pull by digest before changing the manifest. The k3s manifest does not need `imagePullSecrets`. GHCR's initial private state means the first successful workflow run alone does not finish the release.

5. **Keep deployment deliberate.** Update the checked-in manifest to the verified digest and use the existing `klaus` namespace and `Recreate` rollout procedure. Document the source commit, digest, readiness and integration results, and previous digest in the release record. Automatic deployment was rejected because the repository's staged checks include live Telegram and MCP behavior that the GitHub runner cannot validate.

## Risks / Trade-offs

- **Package stays private after first push** -> Anonymous pulls fail; verify public visibility and a fresh unauthenticated pull before rollout.
- **The amd64-only image does not match a k3s node** -> Confirm node architecture is amd64 and test a fresh pull on the target node before updating the live deployment.
- **A commit tag is moved or deleted** -> Deploy and roll back by retained registry digest, not by tag; record digests in the release procedure.
- **A successful CI run does not guarantee live integrations work** -> Keep the documented readiness, Home Assistant, Kaneo, and restart checks in the manual rollout.
- **The current ttl.sh image expires** -> Publish and verify a durable baseline before cutover; record a restorable digest and data backup for rollback.

## Migration Plan

1. Add the workflow and confirm pull request runs execute both gates without publishing.
2. Merge to `main`, confirm the gates pass, and record the GHCR digest from the publish job.
3. Set the package public, verify an unauthenticated pull by digest, and confirm the image runs on the k3s node architecture.
4. Back up persistent state, update the manifest to the digest, then roll out with `Recreate` in the existing `klaus` namespace.
5. Verify fresh pull, readiness, Home Assistant and Kaneo discovery, and restart continuity; record the digest and rollback instructions.
6. To roll back, restore the previously recorded durable digest and compatible configuration and data backup, using the same `Recreate` rollout.
