# Agent Guidelines

- Create commits frequently.
- Before archiving a change, ensure no related changes are uncommitted.
- Use conventional commit messages.
- Validate changes with tests and linting.
- Build container images with BuildKit using `buildctl build --frontend dockerfile.v0 --local context=. --local dockerfile=. --opt target=final --output type=oci,dest=/tmp/<image>.tar`; `BUILDKIT_HOST` is configured by the environment.
