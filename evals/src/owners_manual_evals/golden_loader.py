"""The golden-set loader (Python side).

Loads YAML golden items (issue #30), validating each item strictly with
``parse_golden_item`` and then enforcing the cross-item invariants a single item
cannot see on its own:

* item ids are unique across the set;
* every paraphrase variant names a parent that is present in the set, and that
  parent is itself a real item, not another paraphrase (a variant inherits a
  side from a true parent, so chains are rejected);
* required cites resolve against the supplied document trees (delegated to the
  per-item parser, which fails the load if any cite is unresolvable).

When a directory is loaded, every ``*.yaml`` / ``*.yml`` file is parsed and
per-file-validated in sorted path order, then concatenated into one set over
which the cross-item invariants run exactly once — so a paraphrase variant may
live in a different file from its parent. The genuinely per-file checks (shape,
unknown keys, version, a non-empty items list, per-item parsing) still fire on
each file individually.

The loader also exposes the dev/holdout split (re-exported from
``golden_split``) and verified-only filtering for an eval run: unverified items
load — schema tests need to see every feature — but :func:`eval_run_items`
excludes them by default, so an unverified item can never enter a real eval run.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import yaml

from .document_tree import DocumentTree
from .golden_item import GoldenItem, parse_golden_item
from .golden_split import Side, assign_split

#: The keys a golden-set document may carry at the top level; reject anything else.
_SET_KEYS = frozenset({"version", "items"})


@dataclass(frozen=True, slots=True)
class GoldenSet:
    """A validated collection of golden items from one source. ``items`` preserves
    authoring order; every item has passed per-item and cross-item validation."""

    version: int
    items: tuple[GoldenItem, ...]


def load_golden_items_from_text(text: str, *, documents: Sequence[DocumentTree]) -> GoldenSet:
    """Parse and validate a golden set from a YAML string."""
    raw = yaml.safe_load(text)
    return _build_set(raw, documents=documents)


def load_golden_items(path: Path | str, *, documents: Sequence[DocumentTree]) -> GoldenSet:
    """Load a golden set from a YAML file, or from every ``*.yaml`` / ``*.yml``
    file in a directory (loaded in sorted path order and concatenated into one
    validated set)."""
    resolved = Path(path)
    if resolved.is_dir():
        return _load_directory(resolved, documents=documents)
    text = resolved.read_text(encoding="utf-8")
    return load_golden_items_from_text(text, documents=documents)


def _load_directory(directory: Path, *, documents: Sequence[DocumentTree]) -> GoldenSet:
    files = sorted(path for path in directory.iterdir() if path.suffix in (".yaml", ".yml"))
    if not files:
        raise ValueError(f"golden-set directory {directory} contains no .yaml/.yml files")

    version: int | None = None
    items: list[GoldenItem] = []
    for path in files:
        # Each file is parsed and per-file-validated on its own, but the
        # cross-item invariants are deferred: a paraphrase group may straddle
        # files, so duplicate-id and paraphrase-parent checks run once over the
        # merged set below — the directory is one validated set, not N.
        file_version, file_items = _parse_set(
            yaml.safe_load(path.read_text(encoding="utf-8")), documents=documents
        )
        if version is None:
            version = file_version
        elif file_version != version:
            raise ValueError(
                f"golden-set files disagree on version: {version} vs {file_version} in {path}"
            )
        items.extend(file_items)

    assert version is not None  # files is non-empty, so the loop ran at least once
    return _finalize_set(version=version, items=tuple(items))


def _build_set(raw: object, *, documents: Sequence[DocumentTree]) -> GoldenSet:
    version, items = _parse_set(raw, documents=documents)
    return _finalize_set(version=version, items=items)


def _parse_set(
    raw: object, *, documents: Sequence[DocumentTree]
) -> tuple[int, tuple[GoldenItem, ...]]:
    """Run the genuinely per-document checks and parse each item.

    Validates the set's shape (mapping, no unknown keys, integer version >= 1,
    a non-empty list under ``items``) and parses every entry with
    ``parse_golden_item`` (which resolves required cites). Returns the version
    and parsed items without enforcing the cross-item invariants — those are the
    caller's job via :func:`_finalize_set`, so a directory can defer them until
    its files are merged."""
    if not isinstance(raw, dict):
        raise ValueError(f"golden set must be a mapping, got {type(raw).__name__}")
    _reject_unknown_keys(raw, _SET_KEYS, "golden set")

    version = raw.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ValueError("golden set requires an integer version >= 1")

    if "items" not in raw:
        raise ValueError("golden set requires an items key")
    raw_items = raw["items"]
    if not isinstance(raw_items, list):
        raise ValueError("golden set items must be a list")
    if not raw_items:
        raise ValueError("golden set requires at least one item")

    items = tuple(parse_golden_item(entry, documents=documents) for entry in raw_items)
    return version, items


def _finalize_set(*, version: int, items: tuple[GoldenItem, ...]) -> GoldenSet:
    # Cross-item invariants over the final set; emptiness is rejected upstream in
    # ``_parse_set`` (per file) and the empty-directory guard in ``_load_directory``.
    _reject_duplicate_ids(items)
    _validate_paraphrase_parents(items)
    _validate_corpus_matches_cites(items)
    return GoldenSet(version=version, items=items)


def _reject_duplicate_ids(items: tuple[GoldenItem, ...]) -> None:
    seen: set[str] = set()
    for item in items:
        if item.id in seen:
            raise ValueError(f"golden set has a duplicate item id: {item.id!r}")
        seen.add(item.id)


def _validate_paraphrase_parents(items: tuple[GoldenItem, ...]) -> None:
    by_id = {item.id: item for item in items}
    for item in items:
        if item.paraphrase_of is None:
            continue
        parent = by_id.get(item.paraphrase_of)
        if parent is None:
            raise ValueError(
                f"golden item {item.id!r} is a paraphrase of absent parent {item.paraphrase_of!r}"
            )
        if parent.paraphrase_of is not None:
            raise ValueError(
                f"golden item {item.id!r} is a paraphrase of {parent.id!r}, which is "
                f"itself a paraphrase; paraphrase variants must hang off a true parent"
            )


def _validate_corpus_matches_cites(items: tuple[GoldenItem, ...]) -> None:
    """A cite-bearing item's declared corpus must agree with the corpora its
    required cites resolve to: a single-corpus item carries that corpus, a
    multi-corpus item carries ``cross-corpus``. Cite-less refusal items are
    exempt — their corpus cannot be derived from cites, so it is taken on trust
    (Codex PR #60). A cite whose document id is not in the corpus map (e.g. a
    legacy sample tree) is skipped rather than failing the load."""
    from .oracle import corpus_of_document_id  # noqa: PLC0415

    for item in items:
        cite_corpora: set[str] = set()
        for cite in item.required_cites:
            try:
                cite_corpora.add(corpus_of_document_id(cite.document_id))
            except ValueError:
                continue
        if not cite_corpora:
            continue
        expected = "cross-corpus" if len(cite_corpora) > 1 else next(iter(cite_corpora))
        if item.corpus != expected:
            raise ValueError(
                f"golden item {item.id!r} declares corpus {item.corpus!r} but its required "
                f"cites resolve to {expected!r} (cite corpora: {sorted(cite_corpora)}). A "
                f"cited item's corpus must match its cites; use 'cross-corpus' when they "
                f"span more than one."
            )


def eval_run_items(golden_set: GoldenSet) -> tuple[GoldenItem, ...]:
    """The items eligible for a real eval run: verified only. A verified
    paraphrase whose parent is unverified is dropped too — the robustness delta
    is parent-vs-paraphrase, so a variant with no runnable parent cannot enter
    the run. Unverified items are excluded by default and can never run."""
    verified_ids = {item.id for item in golden_set.items if item.verified}
    runnable: list[GoldenItem] = []
    for item in golden_set.items:
        if not item.verified:
            continue
        if item.paraphrase_of is not None and item.paraphrase_of not in verified_ids:
            continue
        runnable.append(item)
    return tuple(runnable)


def _reject_unknown_keys(value: dict, allowed: frozenset[str], what: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"{what} has unknown keys: {sorted(unknown)}")


__all__ = [
    "GoldenSet",
    "Side",
    "assign_split",
    "eval_run_items",
    "load_golden_items",
    "load_golden_items_from_text",
]
