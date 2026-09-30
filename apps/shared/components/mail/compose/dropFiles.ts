///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Picture files by name, for a file the browser gave no type to. */
const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico|apng)$/i;

/**
 * Whether a file dropped on the compose window goes into the message itself, at the caret, rather than onto it as an attachment: pictures do (a
 * photo or a screenshot is meant to be seen in the text), everything else is attached. The browser's own idea of the type decides, and the file's name
 * does when it had none.
 */
export function isInlineImage(file: Pick<File, "name" | "type">): boolean {
    return file.type ? file.type.startsWith("image/") : IMAGE_EXTENSION.test(file.name);
}

/** Whether a drag carries files from outside the page (as opposed to the text or an image being dragged around inside the editor). */
export function isFileDrag(dataTransfer: Pick<DataTransfer, "types"> | null | undefined): boolean {
    return Array.from(dataTransfer?.types ?? []).includes("Files");
}
