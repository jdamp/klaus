## Durable image deployment

- [ ] Select a durable registry and confirm the Klaus cluster can pull from it.
- [ ] Publish the Pi 1.0 image by immutable digest and update the checked-in deployment manifest.
- [ ] Roll out the digest to the single live replica; verify a fresh image pull, readiness, Home Assistant and Kaneo MCP discovery, and restart continuity.
- [ ] Record the deployment and rollback procedure, including any registry credentials required by the cluster.
