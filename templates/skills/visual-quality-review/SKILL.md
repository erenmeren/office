---
name: visual-quality-review
description: Review rendered UI for alignment, spacing, hierarchy, consistency and polish, and report concrete fixes.
---

# Visual quality review

Find what makes an interface look unfinished, and name the exact fix.

## When to use

- Before a UI change is marked done.
- When asked to review a page, component or screenshot for polish.
- When something "looks off" and nobody can say why.

## Steps

1. Get the real rendering if possible: run the project's screenshot or Playwright tooling
   with `Bash`, or read screenshots provided with the task. Otherwise review the markup and
   styles with `Read` and reason about the rendered result.
2. Read the design tokens and two comparable existing screens, so you judge against the
   product's own standard, not personal taste.
3. Check, in this order:
   - Hierarchy: is the most important element the most prominent? One primary action?
   - Alignment: do edges line up on a shared grid? Are labels and values aligned?
   - Spacing: are gaps from the spacing scale and consistent between similar elements?
     Is related content grouped closer than unrelated content?
   - Typography: sizes and weights from the type scale, line length 60-80 characters,
     line height comfortable, no orphaned single words in headings where avoidable.
   - Color: tokens only, consistent meaning (danger is always the same red), sufficient
     contrast.
   - Consistency: same component for the same job, same icon style and size, same
     corner radius and shadow levels.
   - States: hover, focus, active, disabled, loading, empty and error look designed.
   - Content stress: long names, zero items, many items, missing images.
   - Layout stability: no shift when data loads or images arrive.
4. For each finding write: where (file and line, or screen region), what is wrong, the
   concrete fix (token or value), and severity (blocker, major, minor).
5. Do not rewrite the design. Fix only what you were asked to fix; report the rest.

## Done when

- Every category above was checked, and the report says how (screenshot or code).
- Findings are specific and actionable, ordered by severity.
- If you were asked to fix, the fixes use existing tokens and components and the checks pass.
