"""WisprTest composer.

Stateless FastAPI service. Given an entity schema, a constraint set and runtime state it
returns a CompositionPlan with per-field provenance. It never writes to the application under
test — materialization is the gateway's job.

Delivered by Phase 14 of docs/BUILD-PLAN.md. This phase provides the service bootstrap only.
"""

__all__: list[str] = []
