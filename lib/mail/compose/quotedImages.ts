///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The pictures of a quoted original, carried into the reply or forward. The original refers to its embedded images by `cid:` (or, when
 * the server could not tie one to a part, by nothing but its `alt`), which means nothing in a message of its own - so each is replaced by a
 * `data:` URI of the picture itself. The editor shows it as it is; `assembleDraft()` attaches it to the draft as an inline part when the
 * draft is saved, which is how it reaches the recipient (the server composes a plain message from attachments, never from `data:` URIs).
 */

/** The largest picture quoted. A larger one is left out of the quote rather than bloating the editor and the request that saves it. */
export const MAX_QUOTED_IMAGE_BYTES = 2_000_000;
/** The most picture data a quote carries, in all (as `data:` URI characters). */
export const MAX_QUOTED_IMAGES_CHARS = 6_000_000;
/** How many pictures are fetched at once. */
const QUOTED_IMAGE_CONCURRENCY = 4;

export interface QuotedImageReference {
    /** The token of a `cid:` reference, absent for an image with no source. */
    cid?: string;
    alt?: string;
}

/**
 * `html` with each of its embedded images (`cid:`, or no source at all) replaced by the `data:` URI `resolve` gives for it. An image
 * `resolve` has no picture for (or fails on) is left as it is (the quote's sanitizer then drops it); images that already are `data:` URIs and
 * remote ones are not asked about. `html` is returned as given when it has no such image, or where there is no DOM to parse it with.
 *
 * The images are resolved a few at a time. When `signal` aborts (the caller's deadline) the wait ends there: the pictures that have arrived
 * are embedded, the rest left as they were, and `resolve` - which is given `signal` to cancel its own request with - is asked for no more.
 */
export async function embedQuotedImages(
    html: string,
    resolve: (reference: QuotedImageReference, signal?: AbortSignal) => Promise<string | undefined>,
    signal?: AbortSignal,
): Promise<string> {
    if (typeof DOMParser === "undefined" || !/<img\b/i.test(html)) {
        return html;
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const targets: { image: Element; reference: QuotedImageReference; uri?: string }[] = [];
    for (const image of Array.from(doc.querySelectorAll("img"))) {
        const src = (image.getAttribute("src") ?? "").trim();
        const cid = /^cid:/i.test(src);
        if (cid || src === "") {
            targets.push({ image, reference: { ...(cid ? { cid: src.slice(4) } : {}), alt: image.getAttribute("alt") ?? undefined } });
        }
    }
    let next = 0;
    const worker = async () => {
        while (next < targets.length && !signal?.aborted) {
            const target = targets[next++];
            target.uri = await resolve(target.reference, signal).catch(() => undefined);
        }
    };
    let onAbort!: () => void;
    const deadline = new Promise<void>((done) => {
        onAbort = done;
        if (signal?.aborted) {
            done();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([Promise.all(Array.from({ length: Math.min(QUOTED_IMAGE_CONCURRENCY, targets.length) }, worker)), deadline]);
    signal?.removeEventListener("abort", onAbort);
    // Whatever has arrived by now is embedded, in document order, for as long as the budget lasts.
    let budget = MAX_QUOTED_IMAGES_CHARS;
    let changed = false;
    for (const { image, uri } of targets) {
        // Only a picture of the original's own is ever put in: whatever a resolver answers, a `src` that is not a `data:` image never gets in.
        if (uri !== undefined && /^data:image\//i.test(uri) && uri.length <= budget) {
            budget -= uri.length;
            image.setAttribute("src", uri);
            changed = true;
        }
    }
    return changed ? doc.body.innerHTML : html;
}
