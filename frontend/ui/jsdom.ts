import globalJsdom from "global-jsdom"

// frontend/ui has no DOM. This registers jsdom globals (window, document,
// DOMParser, Node, NodeFilter, ...) so DOMPurify can run under `bun test`.
//
// Deliberately jsdom, not @happy-dom/global-registrator (the pattern used in
// frontend/workspace/happydom.ts): happy-dom's NodeIterator does not
// implement the DOM spec's live-mutation ("pre-remove steps") adjustment, so
// once DOMPurify removes the first disallowed node mid-walk, iteration stops
// silently and everything after goes unsanitized. That breaks any test that
// needs a removal to happen partway through the tree (e.g. verifying a
// disallowed MathML tag downstream of other content is actually stripped).
// jsdom implements this correctly; verified by direct comparison.
globalJsdom(undefined, { url: "http://localhost/" })
