///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads off a message's display document that a hostile message cannot redirect. On a `Document` the named properties of `<img name=...>`,
 * `<form name=...>` and friends *override* the built-in ones (`<img name="body">` makes `document.body` that image), so anything reading
 * `doc.body` from the app would be handed the message's element. Every such element and attribute is stripped before display
 * (`bodyHtml.ts`), and these accessors - the platform's own getters, taken from this window's `Document.prototype` and applied to the
 * frame's document - are the second guard: they answer with the real thing whatever the document contains.
 */
type DocumentGetter = "documentElement" | "body" | "defaultView";

const getters: Partial<Record<DocumentGetter, () => unknown>> = {};

function read<T>(doc: Document, name: DocumentGetter): T {
    getters[name] ??= Object.getOwnPropertyDescriptor(Document.prototype, name)!.get as () => unknown;
    return getters[name].call(doc) as T;
}

export const documentElementOf = (doc: Document): HTMLElement => read<HTMLElement>(doc, "documentElement");
export const bodyOf = (doc: Document): HTMLElement | null => read<HTMLElement | null>(doc, "body");
export const viewOf = (doc: Document): (Window & typeof globalThis) | null => read<(Window & typeof globalThis) | null>(doc, "defaultView");
