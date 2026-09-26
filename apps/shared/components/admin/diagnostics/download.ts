///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Saves `content` to the viewer's computer as a file called `filename`. What the download buttons call, so a test can swap it. */
export type SaveFile = (filename: string, content: string, mimeType: string) => void;

/**
 * The browser way to save text it made itself: a Blob behind an object URL, opened by a temporary `<a download>`. The URL is
 * revoked once the click has been handled (not in the same turn: some browsers start the download after it).
 */
export const saveTextFile: SaveFile = (filename, content, mimeType) => {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** `rapidmx-server-logs-2026-09-26T10-30-00.000Z.log`: the name, then the time with the colons a file name cannot hold replaced. */
export function timestampedFilename(name: string, extension: string, now: Date = new Date()): string {
    return `${name}-${now.toISOString().replace(/:/g, "-")}.${extension}`;
}
