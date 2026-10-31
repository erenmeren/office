---
name: accessibility
description: Make interface changes usable with keyboard, screen readers and low vision, to WCAG 2.2 AA.
---

# Accessibility

Accessibility is correctness, not polish. Check it on every UI change.

## When to use

- Any change to markup, components, styling, focus or interaction.
- Reviewing UI code or a design before it ships.
- Fixing a reported accessibility problem.

## Steps

1. Read the markup you changed with `Read`. Check semantics first:
   - interactive elements are `button`, `a href`, `input`, `select`, `textarea`, not
     `div` with click handlers;
   - headings descend in order without skipping levels;
   - landmarks exist: `main`, `nav`, `header`, `footer`;
   - lists are lists, tables with data are tables with `th` and `scope`.
2. Names and labels:
   - every form control has a visible `label` tied by `for`/`id` or wrapping;
   - icon-only buttons have `aria-label`;
   - images have meaningful `alt`, or `alt=""` when decorative;
   - link text says where it goes ("View invoice 42", not "click here").
3. Keyboard: every action reachable with Tab, Shift+Tab, Enter, Space and Escape.
   Focus order follows visual order. No keyboard traps. Dialogs move focus in, trap it,
   and return it on close.
4. Focus visibility: a visible focus indicator with at least 3:1 contrast. Never remove
   `outline` without a replacement.
5. Contrast: body text at least 4.5:1, large text and UI components at least 3:1. Check
   the actual token values, not the names.
6. Do not rely on color alone for meaning; add text or an icon.
7. Dynamic content: status messages use `role="status"` or `aria-live="polite"`; errors are
   linked to fields with `aria-describedby` and announced.
8. Use ARIA only when no native element does the job; a wrong role is worse than none.
9. Motion: respect `prefers-reduced-motion`; nothing flashes more than three times a second.
10. Target size: pointer targets at least 24 by 24 CSS pixels.
11. Run automated checks if the project has them (`axe`, `eslint-plugin-jsx-a11y`, Playwright
    accessibility tests) with `Bash`. Automated checks catch a minority of issues; still
    walk through the keyboard path by reading the code.

## Done when

- Semantics, labels, keyboard path, focus, contrast and live regions are correct for every
  element you touched.
- Automated checks, if present, pass.
- The report lists issues found, which were fixed, and which remain with severity.
