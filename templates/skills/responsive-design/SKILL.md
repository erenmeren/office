---
name: responsive-design
description: Make layouts work from 320 px phones to wide desktops, with touch and zoom, using the project's breakpoints.
---

# Responsive design

Design for the narrowest screen first, then add layout as space allows.

## When to use

- Building or changing any layout, page or component that renders in a browser.
- Fixing overflow, overlap or unreadable text on small or large screens.

## Steps

1. Find the project's breakpoints and layout primitives with `Grep` (Tailwind `sm: md: lg:`,
   CSS `@media`, container queries, grid or stack components). Use them; do not invent
   new breakpoints.
2. Write the base styles for a 320 px wide viewport. Single column, full-width controls,
   readable text without zoom (16 px body minimum).
3. Add layout at larger widths with min-width media or container queries: columns,
   sidebars, denser tables.
4. Prefer intrinsic layout: `flex-wrap`, `grid` with `minmax()` and `auto-fit`,
   `max-width` on text (60-80 characters per line), `clamp()` for fluid type if the
   project already uses it.
5. Avoid fixed widths and heights on containers that hold text. Let content define height.
6. Handle overflow on purpose:
   - long words, URLs and numbers: `overflow-wrap: anywhere` or truncation with the full
     value in a tooltip or detail view;
   - wide tables: horizontal scroll inside a container, or a stacked card layout on small
     screens;
   - images and media: `max-width: 100%`, set aspect ratio to avoid layout shift.
7. Touch: targets at least 44 by 44 px on touch layouts, no hover-only actions, enough
   spacing between adjacent targets.
8. Zoom and reflow: content must work at 200 percent zoom and reflow at 320 CSS px without
   horizontal scrolling of the page.
9. Check widths 320, 375, 768, 1024, 1440 and one very wide (1920+). If the project has
   Playwright or screenshot tooling, run it with `Bash` at those viewports.

## Done when

- No horizontal page scroll at 320 px; nothing overlaps or clips.
- Layout uses the project's breakpoints and primitives.
- Touch targets and spacing meet the sizes above.
- The report lists the widths checked and how (screenshot, test, or code reading).
