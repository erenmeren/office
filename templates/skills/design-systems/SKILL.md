---
name: design-systems
description: Use, extend or clean up a design system of tokens and shared components without forking it.
---

# Design systems

Keep the product consistent by working through the shared tokens and components.

## When to use

- A task needs a component, color, spacing or type style that may already exist.
- You are tempted to add a one-off style or copy a component.
- Consolidating duplicated components or hard-coded values.

## Steps

1. Locate the system. Use `Glob` for `**/tokens*`, `**/theme*`, `tailwind.config.*`,
   `**/components/ui/**`, and `Grep` for CSS custom properties (`--color-`, `--space-`).
2. Read the tokens: color roles (background, surface, text, muted, accent, danger),
   spacing scale, type scale, radii, shadows, breakpoints, z-index layers.
3. Search for an existing component before writing one: `Grep` for the concept
   ("Button", "Badge", "Dialog", "Empty"). Read its props and variants.
4. If an existing component almost fits, prefer composing it or using an existing variant.
   Add a new variant only when at least two places need it; name it by role
   ("danger"), not appearance ("red").
5. Never hard-code a value that has a token. If no token fits, ask whether the design
   should use the nearest token; add a token only when the task needs a new role.
6. New shared components:
   - live next to the existing ones and follow their file and export conventions;
   - accept the minimum props needed now;
   - handle focus, disabled and loading states the same way as siblings;
   - forward `className` or style overrides only if siblings do.
7. When removing duplication, `Grep` every usage, migrate all of them, and delete the old
   copy in the same change.
8. Run typecheck, lint, tests and any visual or story checks with `Bash`.

## Smells to fix or report

- Hex colors or pixel values in feature code where tokens exist.
- Two components that do the same job with different names.
- Variants named after colors or pages.
- Props that only one caller uses, added "for flexibility".

## Done when

- The change uses tokens and shared components; no new one-off values.
- Any new token or variant has a role-based name and at least one real use.
- All usages of a consolidated component are migrated.
- The report names the tokens and components used or added.
