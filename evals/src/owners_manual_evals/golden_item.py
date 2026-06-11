"""The golden-item schema and its strict parser (Python side).

A golden item (CONTEXT.md, "Golden set") is one hand-verified rubric entry: a
question, a behavior class, claim-level answer points judged per point, the
required cites that answer must pin, and mandatory source provenance ("an item
nobody can trace doesn't ship"). Paraphrase variants (CONTEXT.md, "Paraphrase
group") link to a parent item and are scored as a separate robustness delta.

The parser mirrors ``document_tree.py``'s philosophy: it *rejects* malformed
input rather than coercing it, and it resolves every required cite against the
supplied document trees at parse time using cite-matcher semantics — a required
cite that addresses no real node is a load-time failure, never a silent skip.

The dataclasses are frozen: a parsed item is a value, never mutated in place.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, get_args

from .citable_path import CitablePath, parse_citable_path
from .cite_matcher import resolves_to_node
from .document_tree import DocumentTree

#: The five behavior classes a golden item can assert (CONTEXT.md, "Golden set").
BehaviorClass = Literal[
    "answer",
    "refuse-jurisdiction",
    "refuse-out-of-scope",
    "refuse-advice-escalate",
    "flag-void-clause",
]

#: The closed set of behavior classes, in canonical order.
BEHAVIOR_CLASSES: tuple[BehaviorClass, ...] = get_args(BehaviorClass)

#: The keys a golden-item mapping may carry; reject anything else (strict).
_ITEM_KEYS = frozenset(
    {
        "id",
        "behavior_class",
        "verified",
        "question",
        "answer_points",
        "required_cites",
        "provenance",
        "paraphrase_of",
        "tags",
    }
)

#: The keys an answer-point mapping may carry.
_ANSWER_POINT_KEYS = frozenset({"id", "text"})

#: The keys a provenance mapping may carry.
_PROVENANCE_KEYS = frozenset({"source", "reference"})


@dataclass(frozen=True, slots=True)
class AnswerPoint:
    """One claim-level point judged independently (CONTEXT.md, "Golden set").
    ``id`` is unique within its item; ``text`` is the claim a judge credits."""

    id: str
    text: str


@dataclass(frozen=True, slots=True)
class Provenance:
    """Where a golden item was mined from (mandatory). ``source`` names the kind
    of authority (LTB guideline, CAT decision, designed fixture, adversarial
    design); ``reference`` pins the specific worked example."""

    source: str
    reference: str


@dataclass(frozen=True, slots=True)
class GoldenItem:
    """One validated golden-set item. ``required_cites`` have each been resolved
    against the document trees supplied at parse time. ``paraphrase_of`` is the
    parent item's id when this is a paraphrase variant, else ``None``."""

    id: str
    behavior_class: BehaviorClass
    verified: bool
    question: str
    answer_points: tuple[AnswerPoint, ...]
    required_cites: tuple[CitablePath, ...]
    provenance: Provenance
    paraphrase_of: str | None = None
    tags: tuple[tuple[str, str], ...] = ()


def parse_golden_item(value: object, *, documents: Sequence[DocumentTree]) -> GoldenItem:
    """Validate and normalize an untyped mapping into a :class:`GoldenItem`.

    Every required cite is resolved against ``documents`` with cite-matcher
    semantics; a cite that addresses no real node raises :class:`ValueError`.
    Malformed provenance, an unknown behavior class, malformed answer points, a
    non-boolean ``verified``, or any unknown key likewise raise rather than
    coerce. The input mapping is never mutated.
    """
    if not isinstance(value, dict):
        raise ValueError(f"golden item must be a mapping, got {type(value).__name__}")
    _reject_unknown_keys(value, _ITEM_KEYS, "golden item")

    item_id = _require_nonempty_str(value, "id", "golden item")
    behavior_class = _parse_behavior_class(value)
    verified = _require_bool(value, "verified", item_id)
    question = _require_nonempty_str(value, "question", f"golden item {item_id!r}")
    answer_points = _parse_answer_points(value, item_id)
    required_cites = _parse_required_cites(value, item_id=item_id, documents=documents)
    provenance = _parse_provenance(value, item_id)
    paraphrase_of = _parse_paraphrase_of(value, item_id)
    tags = _parse_tags(value, item_id)

    return GoldenItem(
        id=item_id,
        behavior_class=behavior_class,
        verified=verified,
        question=question,
        answer_points=answer_points,
        required_cites=required_cites,
        provenance=provenance,
        paraphrase_of=paraphrase_of,
        tags=tags,
    )


def _parse_behavior_class(value: dict) -> BehaviorClass:
    behavior_class = value.get("behavior_class")
    if behavior_class not in BEHAVIOR_CLASSES:
        raise ValueError(
            f"unknown behavior class {behavior_class!r}; expected one of {sorted(BEHAVIOR_CLASSES)}"
        )
    return behavior_class


def _parse_answer_points(value: dict, item_id: str) -> tuple[AnswerPoint, ...]:
    if "answer_points" not in value:
        raise ValueError(f"golden item {item_id!r} requires an answer_points key")
    raw = value["answer_points"]
    if not isinstance(raw, list):
        raise ValueError(f"golden item {item_id!r} answer_points must be a list")
    if not raw:
        raise ValueError(f"golden item {item_id!r} requires at least one answer point")
    points = tuple(_parse_answer_point(entry, item_id) for entry in raw)
    seen: set[str] = set()
    for point in points:
        if point.id in seen:
            raise ValueError(f"golden item {item_id!r} has duplicate answer point id {point.id!r}")
        seen.add(point.id)
    return points


def _parse_answer_point(entry: object, item_id: str) -> AnswerPoint:
    if not isinstance(entry, dict):
        raise ValueError(f"golden item {item_id!r} answer point must be a mapping")
    _reject_unknown_keys(entry, _ANSWER_POINT_KEYS, f"golden item {item_id!r} answer point")
    point_id = _require_nonempty_str(entry, "id", f"golden item {item_id!r} answer point")
    text = _require_nonempty_str(entry, "text", f"golden item {item_id!r} answer point")
    return AnswerPoint(id=point_id, text=text)


def _parse_required_cites(
    value: dict, *, item_id: str, documents: Sequence[DocumentTree]
) -> tuple[CitablePath, ...]:
    if "required_cites" not in value:
        raise ValueError(f"golden item {item_id!r} requires a required_cites key")
    raw = value["required_cites"]
    if not isinstance(raw, list):
        raise ValueError(f"golden item {item_id!r} required_cites must be a list")
    cites = tuple(parse_citable_path(entry) for entry in raw)
    for cite in cites:
        if not resolves_to_node(cite, documents):
            raise ValueError(
                f"golden item {item_id!r} has a required cite that does not resolve "
                f"against the provided document trees: "
                f"{cite.document_id} / {[seg.label for seg in cite.segments]}"
            )
    return cites


def _parse_provenance(value: dict, item_id: str) -> Provenance:
    if "provenance" not in value:
        raise ValueError(f"golden item {item_id!r} requires provenance (an untraceable item)")
    raw = value["provenance"]
    if not isinstance(raw, dict):
        raise ValueError(f"golden item {item_id!r} provenance must be a mapping")
    _reject_unknown_keys(raw, _PROVENANCE_KEYS, f"golden item {item_id!r} provenance")
    source = _require_nonempty_str(raw, "source", f"golden item {item_id!r} provenance")
    reference = _require_nonempty_str(raw, "reference", f"golden item {item_id!r} provenance")
    return Provenance(source=source, reference=reference)


def _parse_paraphrase_of(value: dict, item_id: str) -> str | None:
    if "paraphrase_of" not in value:
        return None
    parent = value["paraphrase_of"]
    if not isinstance(parent, str) or not parent:
        raise ValueError(
            f"golden item {item_id!r} paraphrase_of, when present, must be a non-empty string"
        )
    if parent == item_id:
        raise ValueError(f"golden item {item_id!r} cannot be a paraphrase of itself")
    return parent


def _parse_tags(value: dict, item_id: str) -> tuple[tuple[str, str], ...]:
    if "tags" not in value:
        return ()
    raw = value["tags"]
    if not isinstance(raw, dict):
        raise ValueError(f"golden item {item_id!r} tags, when present, must be a mapping")
    tags: list[tuple[str, str]] = []
    for key, tag_value in raw.items():
        if not isinstance(key, str) or not key:
            raise ValueError(f"golden item {item_id!r} tag keys must be non-empty strings")
        if not isinstance(tag_value, str) or not tag_value:
            raise ValueError(f"golden item {item_id!r} tag {key!r} must be a non-empty string")
        tags.append((key, tag_value))
    return tuple(sorted(tags))


def _require_nonempty_str(mapping: dict, key: str, what: str) -> str:
    if key not in mapping:
        raise ValueError(f"{what} is missing required key {key!r}")
    found = mapping[key]
    if not isinstance(found, str) or not found.strip():
        raise ValueError(f"{what} {key!r} must be a non-empty string")
    return found


def _require_bool(mapping: dict, key: str, item_id: str) -> bool:
    if key not in mapping:
        raise ValueError(f"golden item {item_id!r} requires a {key!r} key")
    found = mapping[key]
    if not isinstance(found, bool):
        raise ValueError(f"golden item {item_id!r} {key!r} must be a boolean")
    return found


def _reject_unknown_keys(value: dict, allowed: frozenset[str], what: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"{what} has unknown keys: {sorted(unknown)}")


__all__ = [
    "BehaviorClass",
    "BEHAVIOR_CLASSES",
    "AnswerPoint",
    "Provenance",
    "GoldenItem",
    "parse_golden_item",
]
