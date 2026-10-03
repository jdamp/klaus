# Agent Guidelines

- Create commits frequently.
- Frequently commit OpenSpec artifacts and implementation changes together so planning progress and code progress remain recoverable.
- During this early development stage, commit completed changes and push directly to `main`. Do not open pull requests for routine or minimal changes unless the user explicitly asks for one.
- Before archiving an OpenSpec change, sync all of its delta specs into the main specs unless the user explicitly instructs otherwise. Validate the synced specs before moving the change to the archive.
- Before archiving a change, ensure no related changes are uncommitted.
- Use conventional commit messages.
- Validate changes with tests and linting.
- Build container images with BuildKit using `buildctl build --frontend dockerfile.v0 --local context=. --local dockerfile=. --opt target=final --output type=oci,dest=/tmp/<image>.tar`; `BUILDKIT_HOST` is configured by the environment.
