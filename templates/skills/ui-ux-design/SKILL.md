---
name: ui-ux-design
description: Design user flows and screens around the user's goal, with clear hierarchy, feedback and error recovery.
---

# UI and UX design

Design for the task the user is trying to finish, not for the data model.

## When to use

- Designing a new flow, screen or feature before building it.
- Reviewing an existing flow that users find confusing or slow.
- Deciding what goes on a screen, in what order, with which controls.

## Steps

1. State the user's goal in one sentence and the success moment ("the invoice is sent").
2. List the steps the user takes today, by reading the existing routes and components with
   `Grep` and `Read`. Count the clicks, fields and screens.
3. Remove steps before polishing them. Every field, confirmation and screen must earn its
   place. Prefer sensible defaults over questions.
4. For each screen decide:
   - the one primary action, visually dominant;
   - secondary actions, visually quieter;
   - destructive actions, separated and confirmed or undoable.
5. Write real content, not lorem ipsum: labels, button verbs ("Send invoice", not "Submit"),
   empty-state text that tells the user what to do next, error text that says what happened
   and how to fix it.
6. Design feedback for every action: immediate acknowledgement, progress for anything over
   one second, a clear success state, and recovery on failure that keeps the user's input.
7. Design the edge states: first use (empty), heavy use (hundreds of items), slow network,
   permission denied, validation errors.
8. Keep consistency with the rest of the product: same words for the same things, same
   placement for the same actions.
9. Write the result as a short spec in your report: flow steps, screen contents in priority
   order, copy, states. Hand it to implementation (see `frontend-design`).

## Heuristics to check against

- Visibility of system status: the user always knows what is happening.
- Match the user's words, not internal names.
- User control: undo, cancel and back work as expected.
- Error prevention before error messages: disable impossible actions, constrain inputs.
- Recognition over recall: show options instead of asking users to remember them.

## Done when

- The flow has fewer or equal steps than before, each with a clear purpose.
- Every screen has one obvious primary action and real copy.
- Empty, loading, error and success states are specified.
- The report lists the flow, the decisions made and the open questions for the owner.
