---
name: frontend-design
description: Build or change user interface code that looks deliberate, fits the existing design language and works in the browser.
---

# Frontend design

Ship interface changes that look intentional and consistent with the product, not generic.

## When to use

- Building a new page, view or component.
- Changing layout, styling, typography, color or interaction of existing UI.
- Turning a description or sketch into working frontend code.

## Steps

1. Find the existing design language first. Use `Glob` and `Grep` to locate:
   - the component library or shared components folder (`components/`, `ui/`);
   - design tokens or theme files (CSS variables, Tailwind config, theme objects);
   - two or three existing pages similar to the one you are building.
2. Read those files. Note spacing scale, type scale, colors, radii, shadows and how
   states (hover, focus, disabled, loading, empty, error) are styled.
3. Reuse house components before writing new markup. A house component beats a native
   widget, and a native widget beats a custom one.
4. Decide the layout on paper first: what is the primary action, what is secondary, what
   the user must read first. One primary action per view.
5. Build the structure with semantic HTML (`main`, `nav`, `header`, `button`, `label`,
   lists, headings in order). Style it with the project's tokens, never hard-coded
   one-off values when a token exists.
6. Cover every state of the view: loading, empty, error, partial data, long text, many
   items, a single item.
7. Keep motion short and purposeful (150-250 ms), and respect `prefers-reduced-motion`.
8. Check the result at small and large widths (see the `responsive-design` skill) and
   with keyboard only (see the `accessibility` skill).
9. Run the project's checks with `Bash` (typecheck, lint, tests, build). If the project
   has a dev server and screenshot tooling, look at the rendered result.

## Rules of thumb

- Align to a grid; use the spacing scale, not arbitrary pixel values.
- Limit a view to two font weights and a small number of sizes from the type scale.
- Contrast and hierarchy come from size, weight and spacing before color.
- Do not add a new color, font or icon set unless the task asks for it.
- Text must not overflow or truncate silently; long words and numbers must wrap or ellipsize
  with the full value available.

## Done when

- The view uses existing components and tokens and looks like it belongs to the product.
- Every state above is handled and visible.
- It works with keyboard and at narrow and wide widths.
- Checks pass, and the report says which states and widths you verified and how.
