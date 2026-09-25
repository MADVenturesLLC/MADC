# Code advisories (Copilot, code scanning)

## Scope

This policy applies to **MADVenturesLLC/MADC only**.

## Before-merge ask

Before asking Founder to merge, builders list open **Copilot review findings**, and **code-scanning alerts only if GitHub Code Security / code scanning is enabled** on the repo, for the PR (or for `main` when clearing debt).

**Dependabot is currently disabled on MADC; do not block on missing Dependabot alerts.** Dependabot stays out of the required pre-merge checklist until Founder enables it. Do not enable Dependabot under this policy alone.

## Severity handling

### High / critical

Fix in the **same PR**, or in a **same-act follow-up PR**, or request an **explicit Founder waiver** in the merge-ask (Founder names the waiver). Silent ignore = failed act.

### Medium / low

Fix when cheap; otherwise note disposition in the PR body.

## Fixes vs dismissals

Prefer **real fixes** over dismissals. Suppressions need a **one-line justification** in the PR body (and at the suppress site if the tool requires it). **No mass-dismiss.**

## Definition of done

**CI green alone is not DoD.** Advisories must be addressed per this policy.

## Founder override

Founder may merge anytime. If `main` gains open high/critical because Founder merged, the **next Hephaestus act** must clear or escalate them before new feature work, unless Founder waives by name.

## Out of scope

- Actions spend
- Forcing Copilot required checks
- Blocking Founder merges via rulesets
- Enabling Dependabot or Code Security without a separate Founder ask
