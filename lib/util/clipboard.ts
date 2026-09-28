///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * The legacy copy path: selects `text` in an off-screen, read-only `<textarea>` and runs
 * `document.execCommand("copy")`. Used where the async Clipboard API is missing (an insecure `http:` origin,
 * an older browser) or refuses (permission denied, the document isn't focused). Puts focus back where it was,
 * since selecting the textarea moves it. `false` when there is no DOM or the browser declines the command.
 */
function copyWithExecCommand(text: string): boolean {
    if (typeof document === "undefined") {
        return false;
    }
    const previouslyFocused = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";
    document.body.appendChild(textarea);
    let copied = false;
    try {
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        copied = typeof document.execCommand === "function" && document.execCommand("copy");
    } catch {
        copied = false;
    } finally {
        textarea.remove();
        if (previouslyFocused instanceof HTMLElement) {
            previouslyFocused.focus();
        }
    }
    return copied;
}

/**
 * Copies `text` to the system clipboard and reports whether it worked - never rejects, so a caller can
 * simply show "Copied" or "Couldn't copy". Tries `navigator.clipboard.writeText()` first and, when that is
 * unavailable or rejects, the hidden-textarea `execCommand("copy")` fallback. Must run from a user gesture
 * (a click handler) for either route to be allowed.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Denied or unavailable right now - the legacy path below may still succeed.
    }
    return copyWithExecCommand(text);
}
