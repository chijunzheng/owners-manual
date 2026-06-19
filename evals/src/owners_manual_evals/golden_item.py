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
from .fixture_design import FIXTURE_DESIGN_ID_SET

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

#: The corpus slice a golden item belongs to (CONTEXT.md, "Golden set"). The four
#: base corpora (the vocabulary ``oracle.CORPORA`` keys document ids by) plus
#: ``cross-corpus`` for an item whose required cites fan out across more than one
#: corpus. This is the dashboard slice and a stratum key for the dev/holdout split.
Corpus = Literal["tenancy", "insurance", "governing", "selling", "cross-corpus"]

#: The closed set of corpus slices, in canonical order.
CORPORA: tuple[Corpus, ...] = get_args(Corpus)

#: The keys a golden-item mapping may carry; reject anything else (strict).
_ITEM_KEYS = frozenset(
    {
        "id",
        "behavior_class",
        "corpus",
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

#: The provenance source that marks an item as mined from a designed fixture;
#: such an item must name the planted conflict it instantiates via tags.fixture.
_DESIGNED_FIXTURE_SOURCE = "designed-fixture"


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
    against the document trees supplied at parse time. ``corpus`` is the slice the
    item belongs to (a stratum key for the split). ``paraphrase_of`` is the parent
    item's id when this is a paraphrase variant, else ``None``."""

    id: str
    behavior_class: BehaviorClass
    verified: bool
    question: str
    answer_points: tuple[AnswerPoint, ...]
    required_cites: tuple[CitablePath, ...]
    provenance: Provenance
    corpus: Corpus = "tenancy"
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
    corpus = _parse_corpus(value, item_id)
    verified = _require_bool(value, "verified", item_id)
    question = _require_nonempty_str(value, "question", f"golden item {item_id!r}")
    answer_points = _parse_answer_points(value, item_id)
    required_cites = _parse_required_cites(value, item_id=item_id, documents=documents)
    provenance = _parse_provenance(value, item_id)
    paraphrase_of = _parse_paraphrase_of(value, item_id)
    tags = _parse_tags(value, item_id)
    _validate_fixture_tag(provenance=provenance, tags=tags, item_id=item_id)

    return GoldenItem(
        id=item_id,
        behavior_class=behavior_class,
        verified=verified,
        question=question,
        answer_points=answer_points,
        required_cites=required_cites,
        provenance=provenance,
        corpus=corpus,
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


def _parse_corpus(value: dict, item_id: str) -> Corpus:
    if "corpus" not in value:
        raise ValueError(f"golden item {item_id!r} requires a corpus key")
    corpus = value["corpus"]
    if corpus not in CORPORA:
        raise ValueError(
            f"golden item {item_id!r} has unknown corpus {corpus!r}; "
            f"expected one of {sorted(CORPORA)}"
        )
    return corpus


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


def _validate_fixture_tag(
    *, provenance: Provenance, tags: tuple[tuple[str, str], ...], item_id: str
) -> None:
    """Tie a designed-fixture item to the planted conflict it instantiates (#22).

    Two rules:

    * a ``fixture`` tag, when present, must name a real planted-conflict id
      (``FIXTURE_DESIGN_IDS``) — a typo can never silently detach an item from
      its conflict;
    * an item whose provenance ``source`` is ``designed-fixture`` MUST carry a
      ``fixture`` tag — a fixture-mined item that names no conflict is exactly
      the untraceable case the "reference conflicts by ID" AC forbids.

    A ``fixture`` tag is permitted (and value-checked) on any source, so an item
    grounded primarily in a statute may still point at the conflict it exercises.
    """
    fixture_id = dict(tags).get("fixture")
    if fixture_id is not None and fixture_id not in FIXTURE_DESIGN_ID_SET:
        raise ValueError(
            f"golden item {item_id!r} has fixture tag {fixture_id!r}, which is not a known "
            f"planted-conflict id; expected one of {sorted(FIXTURE_DESIGN_ID_SET)}"
        )
    if provenance.source == _DESIGNED_FIXTURE_SOURCE and fixture_id is None:
        raise ValueError(
            f"golden item {item_id!r} has provenance source {_DESIGNED_FIXTURE_SOURCE!r} but no "
            f"fixture tag; a designed-fixture item must name the planted conflict it "
            f"instantiates via tags.fixture (issue #22)"
        )


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
    "Corpus",
    "CORPORA",
    "AnswerPoint",
    "Provenance",
    "GoldenItem",
    "parse_golden_item",
]
