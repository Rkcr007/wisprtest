"""The plan as a DAG, and the order the gateway must create it in.

docs/TEST-DATA-ENGINE.md § 3 is blunt about why this exists even for a plan holding one record:

    The output is a DAG of records, not one record. Build for that from the start; retrofitting
    multi-entity composition later is a rewrite.

"A customer with an overdue invoice" is two records, and the invoice cannot be created until the
account it points at has an identifier. `materializationOrder` is where that fact leaves the
composer — the gateway creates records strictly in the order given, feeding each returned
identifier into the fields the edges name, and § 5 reverts in exactly the reverse.

## Reuse nodes carry no fields

A node whose `mode` is `reuse_existing` describes a record the application already holds. Nothing
will be written for it, so there is nothing to explain: its `fields` are empty and it carries no
provenance. It is in the graph because the *preview* needs it — a tester approving "an order for
Acme Industrial" should be able to see that Acme is the account that already exists rather than a
second one about to be created — and because reverting a plan must never touch it.

## The sort is stable

Kahn's algorithm with insertion-order tie-breaking, so the same plan produces the same order every
time. Two independent nodes have no dependency that determines which comes first, and letting a
set's iteration order decide would make the response non-reproducible for no reason.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from composer.errors import PlanCycleError
from composer.protocol.models import (
    CompositionEdge,
    CompositionNode,
    EntitySchema,
    Mode,
    ProvenanceEntry,
)


def slug(entity: str) -> str:
    """A node-id stem from an entity name: `LineItem` and `line_item` both give `line-item`."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", entity)
    parts = [part for part in re.split(r"[^A-Za-z0-9]+", spaced) if part]
    return "-".join(part.lower() for part in parts) or "record"


@dataclass
class PlanNode:
    """One record of the plan, before it is rendered into the contract's shape."""

    node_id: str
    schema: EntitySchema
    mode: Mode
    existing_external_ref: str | None = None
    fields: dict[str, object] = field(default_factory=dict)
    provenance: list[ProvenanceEntry] = field(default_factory=list)

    def to_model(self) -> CompositionNode:
        # Field names, not the contract's camelCase aliases: `populate_by_name` accepts either at
        # runtime, but only the field names are what the pydantic mypy plugin types the synthesised
        # `__init__` with, and an alias here typechecks as an unexpected keyword.
        return CompositionNode(
            node_id=self.node_id,
            entity=self.schema.entity_name,
            entity_schema_id=self.schema.id,
            mode=self.mode,
            existing_external_ref=self.existing_external_ref,
            fields=dict(self.fields),
            provenance=list(self.provenance),
        )


class PlanGraph:
    """Nodes, the dependencies between them, and the order they must be created in."""

    def __init__(self) -> None:
        self._nodes: dict[str, PlanNode] = {}
        self._edges: list[CompositionEdge] = []
        self._arrival: list[str] = []

    # ── Building ──────────────────────────────────────────────────────────────────────────

    def next_node_id(self, entity: str) -> str:
        """A stable, readable, plan-local identifier: `account-1`, `invoice-2`.

        Readable because it is rendered: the provenance on a pending reference names the node the
        identifier will come from, and `account-1` tells the tester which record that is where a
        UUID would tell them nothing.
        """
        stem = slug(entity)
        taken = sum(1 for node_id in self._nodes if node_id.rsplit("-", 1)[0] == stem)
        return f"{stem}-{taken + 1}"

    def add(self, node: PlanNode) -> PlanNode:
        if node.node_id in self._nodes:
            raise ValueError(f"node {node.node_id!r} is already in the plan")
        self._nodes[node.node_id] = node
        self._arrival.append(node.node_id)
        return node

    def connect(self, from_node_id: str, to_node_id: str, via_field: str) -> None:
        """`from` cannot exist until `to` does, and `via_field` will hold `to`'s identifier."""
        for node_id in (from_node_id, to_node_id):
            if node_id not in self._nodes:
                raise ValueError(f"cannot connect an edge to unknown node {node_id!r}")
        self._edges.append(
            CompositionEdge(from_node_id=from_node_id, to_node_id=to_node_id, via_field=via_field)
        )

    # ── Reading ───────────────────────────────────────────────────────────────────────────

    def node(self, node_id: str) -> PlanNode:
        return self._nodes[node_id]

    def nodes(self) -> list[PlanNode]:
        return [self._nodes[node_id] for node_id in self._arrival]

    def edges(self) -> list[CompositionEdge]:
        return list(self._edges)

    def reused_node_for(self, entity: str, external_ref: str) -> PlanNode | None:
        """An existing reuse node for the same record, so two references share one node."""
        for node in self._nodes.values():
            if (
                node.mode is Mode.REUSE_EXISTING
                and node.schema.entity_name == entity
                and node.existing_external_ref == external_ref
            ):
                return node
        return None

    def materialization_order(self) -> list[str]:
        """Dependencies first, insertion order breaking ties.

        Raises rather than emitting a partial order if the graph is cyclic. A cycle cannot be
        built by the solver — a node's dependencies are resolved before it is added — but the
        order is the instruction the gateway executes against a live application, and a wrong one
        creates records that reference nothing. It is the one place where refusing to answer is
        obviously right.
        """
        outstanding = {node_id: 0 for node_id in self._arrival}
        dependents: dict[str, list[str]] = {node_id: [] for node_id in self._arrival}

        for edge in self._edges:
            outstanding[edge.from_node_id] += 1
            dependents[edge.to_node_id].append(edge.from_node_id)

        ready = [node_id for node_id in self._arrival if outstanding[node_id] == 0]
        ordered: list[str] = []

        while ready:
            node_id = ready.pop(0)
            ordered.append(node_id)
            for dependent in dependents[node_id]:
                outstanding[dependent] -= 1
                if outstanding[dependent] == 0:
                    ready.append(dependent)
            # Re-sorting by arrival keeps the output stable when several become ready at once.
            ready.sort(key=self._arrival.index)

        if len(ordered) != len(self._arrival):
            unplaced = [node_id for node_id in self._arrival if node_id not in set(ordered)]
            raise PlanCycleError(unplaced)

        return ordered
