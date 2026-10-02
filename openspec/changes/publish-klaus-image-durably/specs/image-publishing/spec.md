## Purpose

Define how Klaus releases a tested container image to a durable public registry and identifies the exact image used by its k3s deployment.

## ADDED Requirements

### Requirement: Repository changes pass quality gates before publication
The image publishing pipeline SHALL run formatting, linting, type checking, automated tests, the application build, and container verification before it publishes an image. A failed gate MUST prevent publication for that revision.

#### Scenario: A pull request is evaluated
- **WHEN** a pull request targets the default branch
- **THEN** the quality gates run and no image is published from that pull request

#### Scenario: A gate fails on the default branch
- **WHEN** a default-branch revision fails any quality gate or container verification
- **THEN** the pipeline does not publish an image for that revision

### Requirement: Successful default-branch revisions produce a durable public image
The pipeline SHALL publish the final Klaus container image to GHCR after all gates pass, associate it with the source revision, and report its immutable registry digest. The published image SHALL be anonymously pullable so the k3s cluster does not need a registry credential.

#### Scenario: All gates pass on the default branch
- **WHEN** a revision on the default branch passes every gate
- **THEN** GHCR contains a commit-addressed image and the pipeline reports its digest

#### Scenario: Fresh cluster pull
- **WHEN** a k3s node pulls the published image by digest without registry authentication
- **THEN** the image pull succeeds

### Requirement: Deployment and rollback use exact image identities
The checked-in k3s deployment SHALL reference a published GHCR digest instead of an expiring registry image. Release documentation SHALL identify how to record the deployed digest, verify a replacement pod, and restore a previously recorded digest.

#### Scenario: Operator deploys a new release
- **WHEN** the operator updates the deployment to a successfully published digest
- **THEN** the replacement pod pulls that exact image and the documented readiness and integration checks can be performed

#### Scenario: Operator rolls back
- **WHEN** the operator restores a previously recorded digest
- **THEN** the deployment pulls the exact previous image without relying on a mutable tag or an expiring registry
