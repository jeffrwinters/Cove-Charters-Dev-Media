# Synthetic Render Data

Store only run-scoped synthetic media and manifests beneath `data/`. Each run
must use its own exact directory and synthetic booking identifiers.

After a run, delete the exact run directory and its exact generated media paths;
never use a broad recursive cleanup target. If real, production, or otherwise
restricted data appears, disable the renderer workflow, stop further writes,
remove the exact affected paths, rotate exposed credentials, and treat the
disclosure as an incident.
