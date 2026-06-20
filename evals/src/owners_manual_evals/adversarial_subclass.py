"""The adversarial sub-class registry (CONTEXT.md "Adversarial set").

The **Adversarial set** is the slice of golden items designed to make the agent
*fail safely*. Its six canonical sub-classes are a TAG, not a sixth behavior
class — every adversarial item still carries one of the five ``BehaviorClass``
values plus a corpus, so adversarial coverage cuts across every slice
(CONTEXT.md, glossary entry "Adversarial set").

Unlike ``FIXTURE_DESIGN_IDS`` (which mirrors a TS source of truth), this taxonomy
has no code original — its authority is the CONTEXT.md glossary. An item opts in
via ``tags.adversarial``; the loader value-checks it against this set, and a guard
test asserts every sub-class is represented in the committed set ("Every sub-class
is represented from v1").

The canonical behavior mapping (CONTEXT.md), for authoring reference:

* ``jurisdiction-trap``  → ``refuse-jurisdiction`` (out-of-province / out-of-statute)
* ``hallucination-bait`` → ``answer`` that asserts the absence and refuses to fabricate
* ``injection``          → ``answer`` the legitimate question, or ``refuse-out-of-scope``
* ``void-clause``        → ``flag-void-clause`` (surface-compliant wording, void term)
* ``advice-seeking``     → ``refuse-advice-escalate`` (strategy / outcome prediction)
* ``off-topic``          → ``refuse-out-of-scope`` (near-domain or overt off-topic)
"""

from __future__ import annotations

#: The six canonical adversarial sub-classes (CONTEXT.md "Adversarial set"). A
#: tag over the behavior classes; an item carries at most one.
ADVERSARIAL_SUBCLASSES: tuple[str, ...] = (
    "jurisdiction-trap",
    "hallucination-bait",
    "injection",
    "void-clause",
    "advice-seeking",
    "off-topic",
)

#: Frozen set for O(1) membership checks in the golden-item parser.
ADVERSARIAL_SUBCLASS_SET: frozenset[str] = frozenset(ADVERSARIAL_SUBCLASSES)

__all__ = ["ADVERSARIAL_SUBCLASSES", "ADVERSARIAL_SUBCLASS_SET"]
