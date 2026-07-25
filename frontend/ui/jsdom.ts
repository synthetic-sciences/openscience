import globalJsdom from "global-jsdom"

// Sanitizer tests need a DOM whose NodeIterator follows live mutation.
// happy-dom stops walking after DOMPurify removes a node, which can make
// unsafe output look sanitized. jsdom implements the required behavior.
globalJsdom(undefined, { url: "http://localhost/" })
