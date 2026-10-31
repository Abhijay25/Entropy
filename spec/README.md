# Entropy specifications

Start with [plan.md](plan.md): it is the active, implementation-ready specification for the 4–5 hour cascade-demo MVP.

The product owner selected the cascade demo described in the pulled [original product brief](../.spec), with technical corrections and automatic patch application deferred. That original brief arrived in commit `1b3333d` as a file named `.spec`, not a directory, and is preserved unchanged.

Document precedence:

1. Current product-owner instructions.
2. [Active implementation plan](plan.md): architecture, contracts, measured behavior, work ownership, and acceptance criteria.
3. [Original product brief](../.spec): product intent and longer-term vision. Where it conflicts with the active plan, use the active plan.
4. [Archived QA proposal](archive/qa-plan.md): historical reference only; do not implement it alongside the active plan.

Put new implementation specifications and decisions in this `spec/` directory. Keep one active plan, update its contracts when scope changes, and identify superseded documents explicitly so coding agents do not combine incompatible architectures.

Coding-agent prompts and the two-person schedule are in section 12 of the active plan. Connection details belong in local environment configuration; secrets never belong in specifications.
