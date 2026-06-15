"""The order-permutation probe (issue #18): is ``stuff`` a prefix-order artifact?

A long-context model can latch onto position rather than content — answering from
whatever sits at the start (or end) of a stuffed prompt. The probe falsifies that
for the ``stuff`` arm: it runs the arm over the golden items at several corpus-order
PERMUTATIONS (seed 0 = the canonical baseline, plus probe seeds the TS arm shuffles
to deterministically) and reports the strict-pass rate at each seed. If the rate is
stable across permutations, the arm is reading content, not position — not an
artifact. If it swings, the probe flags order sensitivity, and the four-arm result
must footnote it.

The stuff client is injected, so the probe is unit-tested offline against a fake;
the live probe drives the same ``/stuff`` route with the ``orderSeed`` body field.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .document_tree import DocumentTree
from .golden_item import GoldenItem
from .metrics import score_item
from .stuff_client import StuffResult


class _StuffClientLike(Protocol):
    def stuff(self, **kwargs: Any) -> StuffResult: ...


@dataclass(frozen=True, slots=True)
class SeedResult:
    """The strict-pass rate the ``stuff`` arm scored at one corpus-order seed."""

    seed: int
    count: int
    strict_pass_rate: float


@dataclass(frozen=True, slots=True)
class OrderProbeReport:
    """The probe's verdict: per-seed strict-pass rates and whether order matters."""

    run_name: str
    per_seed: tuple[SeedResult, ...]
    #: max − min strict-pass rate across seeds; 0.0 means perfectly order-stable.
    strict_pass_spread: float
    #: True iff the strict-pass rate moved across permutations (a prefix artifact).
    is_order_sensitive: bool

    def render(self) -> str:
        """Render the probe as a short table with the not-an-artifact verdict."""
        lines = [
            f"=== {self.run_name} — stuff order-permutation probe ===",
            "",
            f"{'order seed':<12}{'n':>4}  {'strict':>8}",
            "-" * 26,
        ]
        for r in self.per_seed:
            tag = " (baseline)" if r.seed == 0 else ""
            lines.append(f"{r.seed:<12}{r.count:>4}  {r.strict_pass_rate:>8.2%}{tag}")
        lines.append("-" * 26)
        if self.is_order_sensitive:
            verdict = (
                f"ORDER-SENSITIVE: strict pass moved {self.strict_pass_spread:.2%} across "
                "permutations — the stuff arm may be a prefix-order artifact; footnote this "
                "in the four-arm result."
            )
        else:
            verdict = (
                "NOT a prefix-order artifact: strict pass is stable across corpus-order "
                "permutations (spread 0.00%) — the arm reads content, not position."
            )
        lines.extend(["", verdict])
        return "\n".join(lines)


def run_order_probe(
    *,
    items: Sequence[GoldenItem],
    documents: Sequence[DocumentTree],
    client: _StuffClientLike,
    run_name: str,
    seeds: Sequence[int] = (0, 1, 2),
) -> OrderProbeReport:
    """Run the ``stuff`` arm over the items at each seed and report order stability.

    Seed 0 is the canonical baseline; the rest are deterministic permutations. The
    strict-pass spread (max − min) over seeds is the order-sensitivity signal.
    """
    per_seed: list[SeedResult] = []
    for seed in seeds:
        strict = 0
        for item in items:
            result = client.stuff(question=item.question, item_id=item.id, order_seed=seed)
            score = score_item(
                item,
                observed_behavior=result.behavior_class,
                candidate_cites=result.candidate_cites,
                retrieved_path_keys=result.retrieved_path_keys,
                documents=documents,
            )
            strict += 1 if score.strict_pass else 0
        rate = strict / len(items) if items else 0.0
        per_seed.append(SeedResult(seed=seed, count=len(items), strict_pass_rate=rate))

    rates = [r.strict_pass_rate for r in per_seed]
    spread = (max(rates) - min(rates)) if rates else 0.0
    return OrderProbeReport(
        run_name=run_name,
        per_seed=tuple(per_seed),
        strict_pass_spread=spread,
        is_order_sensitive=spread > 0.0,
    )


# --- live CLI wiring -------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Live entry point: run the ``stuff`` arm over golden v0 at several corpus-order
    permutations and print the order-probe report."""
    import argparse  # noqa: PLC0415
    import sys  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="order-probe",
        description="Run the stuff arm at several corpus-order permutations and report whether "
        "it is a prefix-order artifact.",
    )
    parser.add_argument("--service-url", default="http://127.0.0.1:8787")
    parser.add_argument("--include-holdout", action="store_true")
    parser.add_argument("--run-name", default="stuff-order-probe-v0")
    parser.add_argument(
        "--seeds",
        default="0,1,2",
        help="Comma-separated corpus-order seeds (0 = canonical baseline).",
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    from .env_file import load_root_env  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_documents, load_golden_v0_set  # noqa: PLC0415

    load_root_env()
    from .run_naive_rag import select_run_items  # noqa: PLC0415
    from .stuff_client import StuffClient  # noqa: PLC0415

    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()
    items = select_run_items(golden, include_holdout=args.include_holdout)
    seeds = tuple(int(s) for s in args.seeds.split(",") if s.strip() != "")

    report = run_order_probe(
        items=items,
        documents=documents,
        client=StuffClient(base_url=args.service_url),
        run_name=args.run_name,
        seeds=seeds,
    )
    print(report.render())
    return 0


__all__ = ["SeedResult", "OrderProbeReport", "run_order_probe", "main"]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
