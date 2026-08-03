"""`PlanGraph` — the DAG, and the order the gateway must create it in.

`materializationOrder` is executed literally against a live application: the gateway creates
records strictly in the order given, feeding each returned identifier into the fields the edges
name. An order that ignores a dependency creates records pointing at identifiers that do not exist
yet, which is why the sort raises rather than emitting a partial answer.
"""

from __future__ import annotations

import pytest

from composer.errors import PlanCycleError
from composer.protocol.models import EntitySchema, Mode, ProvenanceEntry, ProvenanceSource
from composer.solving.graph import PlanGraph, PlanNode, slug
from support.schemas import account_schema, invoice_schema, order_schema


def node(
    graph: PlanGraph,
    schema: EntitySchema,
    mode: Mode = Mode.CREATE,
    ref: str | None = None,
) -> PlanNode:
    return graph.add(
        PlanNode(
            node_id=graph.next_node_id(schema.entity_name),
            schema=schema,
            mode=mode,
            existing_external_ref=ref,
        )
    )


# ── Node ids ──────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("entity", "expected"),
    [
        ("LineItem", "line-item"),
        ("line_item", "line-item"),
        ("Order", "order"),
        ("purchase order", "purchase-order"),
        ("---", "record"),
    ],
)
def test_a_node_id_stem_reads_the_same_however_the_entity_is_spelled(
    entity: str, expected: str
) -> None:
    assert slug(entity) == expected


def test_node_ids_are_readable_because_they_are_rendered() -> None:
    """`account-1` tells the tester which record a pending reference will take its id from.

    A UUID would tell them nothing, and the provenance on a pending reference names the node
    directly.
    """
    graph = PlanGraph()
    assert node(graph, order_schema()).node_id == "order-1"
    assert node(graph, order_schema()).node_id == "order-2"
    assert node(graph, account_schema()).node_id == "account-1"


def test_a_node_id_cannot_be_used_twice() -> None:
    graph = PlanGraph()
    first = node(graph, order_schema())
    with pytest.raises(ValueError, match="already in the plan"):
        graph.add(first)


def test_an_edge_to_an_unknown_node_is_refused() -> None:
    graph = PlanGraph()
    node(graph, order_schema())
    with pytest.raises(ValueError, match="unknown node"):
        graph.connect("order-1", "account-1", "accountId")


# ── Ordering ──────────────────────────────────────────────────────────────────────────────────


def test_a_dependency_is_created_first() -> None:
    """§ 3's worked example, at the graph level: Account before Invoice.

    The invoice cannot be created until the account it points at has an identifier.
    """
    graph = PlanGraph()
    invoice = node(graph, invoice_schema())
    account = node(graph, account_schema())
    graph.connect(invoice.node_id, account.node_id, "accountId")

    assert graph.materialization_order() == ["account-1", "invoice-1"]


def test_a_plan_of_one_record_is_still_a_graph() -> None:
    graph = PlanGraph()
    node(graph, order_schema())
    assert graph.materialization_order() == ["order-1"]
    assert graph.edges() == []


def test_a_chain_is_ordered_end_to_end() -> None:
    graph = PlanGraph()
    order = node(graph, order_schema())
    invoice = node(graph, invoice_schema())
    account = node(graph, account_schema())
    graph.connect(order.node_id, invoice.node_id, "invoiceId")
    graph.connect(invoice.node_id, account.node_id, "accountId")

    assert graph.materialization_order() == ["account-1", "invoice-1", "order-1"]


def test_independent_nodes_keep_the_order_they_arrived_in() -> None:
    """The sort is stable, so the same plan produces the same order every time.

    Two independent nodes have no dependency that decides which comes first, and letting a set's
    iteration order decide would make the response non-reproducible for no reason.
    """
    graph = PlanGraph()
    node(graph, order_schema())
    node(graph, account_schema())
    node(graph, invoice_schema())

    assert graph.materialization_order() == ["order-1", "account-1", "invoice-1"]


def test_a_shared_dependency_is_created_once_and_first() -> None:
    graph = PlanGraph()
    first = node(graph, order_schema())
    second = node(graph, order_schema())
    account = node(graph, account_schema(), Mode.REUSE_EXISTING, "ACC-1001")
    graph.connect(first.node_id, account.node_id, "accountId")
    graph.connect(second.node_id, account.node_id, "accountId")

    assert graph.materialization_order() == ["account-1", "order-1", "order-2"]


def test_a_cycle_refuses_to_produce_an_order() -> None:
    """The one place refusing to answer is obviously right.

    A cycle cannot be built by the solver — a node's dependencies are resolved before it is added
    — but the order is an instruction executed against a live application, and a wrong one creates
    records that reference nothing.
    """
    graph = PlanGraph()
    order = node(graph, order_schema())
    account = node(graph, account_schema())
    graph.connect(order.node_id, account.node_id, "accountId")
    graph.connect(account.node_id, order.node_id, "lastOrderId")

    with pytest.raises(PlanCycleError) as caught:
        graph.materialization_order()

    assert caught.value.code == "plan_not_acyclic"
    assert sorted(caught.value.nodes) == ["account-1", "order-1"]


# ── Reuse ─────────────────────────────────────────────────────────────────────────────────────


def test_two_references_to_the_same_real_record_share_one_node() -> None:
    graph = PlanGraph()
    node(graph, account_schema(), Mode.REUSE_EXISTING, "ACC-1001")

    found = graph.reused_node_for("Account", "ACC-1001")
    assert found is not None
    assert found.node_id == "account-1"
    assert graph.reused_node_for("Account", "ACC-9999") is None
    assert graph.reused_node_for("Order", "ACC-1001") is None


def test_a_reuse_node_carries_no_fields_and_no_provenance() -> None:
    """Nothing will be written for it, so there is nothing to explain.

    It is in the graph because the *preview* needs it — a tester approving "an order for Acme
    Industrial" should see that Acme is the account that already exists rather than a second one
    about to be created — and because reverting a plan must never touch it.
    """
    graph = PlanGraph()
    reused = node(graph, account_schema(), Mode.REUSE_EXISTING, "ACC-1001").to_model()

    assert reused.mode is Mode.REUSE_EXISTING
    assert reused.existing_external_ref == "ACC-1001"
    assert reused.fields == {}
    assert reused.provenance == []


# ── Rendering into the contract's shape ───────────────────────────────────────────────────────


def test_a_node_renders_with_its_entity_and_schema_identity() -> None:
    graph = PlanGraph()
    plan_node = node(graph, order_schema())
    plan_node.fields["status"] = "pending"
    plan_node.provenance.append(
        ProvenanceEntry(
            field="status",
            value="pending",
            source=ProvenanceSource.REQUESTED,
            explanation="you asked for it",
            confidence=0.9,
        )
    )

    rendered = plan_node.to_model()
    assert rendered.node_id == "order-1"
    assert rendered.entity == "Order"
    assert rendered.entity_schema_id == order_schema().id
    assert rendered.fields == {"status": "pending"}
    assert [entry.field for entry in rendered.provenance] == ["status"]


def test_nodes_are_returned_in_arrival_order() -> None:
    graph = PlanGraph()
    node(graph, order_schema())
    node(graph, account_schema())
    assert [entry.node_id for entry in graph.nodes()] == ["order-1", "account-1"]


def test_edges_carry_the_field_that_will_hold_the_identifier() -> None:
    graph = PlanGraph()
    order = node(graph, order_schema())
    account = node(graph, account_schema())
    graph.connect(order.node_id, account.node_id, "accountId")

    edge = graph.edges()[0]
    assert (edge.from_node_id, edge.to_node_id, edge.via_field) == (
        "order-1",
        "account-1",
        "accountId",
    )
