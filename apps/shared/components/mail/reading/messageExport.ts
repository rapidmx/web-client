///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { binaryStringToBytes, extractAddresses, parseMimeEntity } from "@rapidmx/react-shared/crypto/mime.js";

/**
 * What the reading pane does with a message's raw RFC 5322 source (`getMessageRawContent()`, a binary string): show it, save it as a
 * file, and read the From header out of it. Nothing here interprets the message's content beyond its header block.
 */

/** How much of a message's source the "View message source" dialog draws: a message with attachments is mostly base64, and a
 * megabyte of it in a `<pre>` helps nobody. Saving as .eml and Copy always have all of it. */
export const MAX_SOURCE_DISPLAY_CHARS = 200_000;

/** The file name "Save as .eml" gives a message: its subject without what a file system refuses, or `message`. */
export function emlFileName(subject: string | undefined): string {
    const cleaned = (subject ?? "")
        .replace(/[\p{Cc}\\/:*?"<>|]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100)
        .replace(/^\.+/, "")
        .replace(/[. ]+$/, "");
    return `${cleaned || "message"}.eml`;
}

/** Hands `bytes` to the browser as a download called `fileName`. */
export function downloadBytes(bytes: Uint8Array, fileName: string, type: string): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Some browsers are still reading the blob after `click()` returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saves a raw message (a binary string, exactly as the server has it) as a `.eml` file, byte for byte. */
export function saveAsEml(raw: string, subject: string | undefined): void {
    downloadBytes(binaryStringToBytes(raw), emlFileName(subject), "message/rfc822");
}

/** A raw message as text to read: its bytes decoded as UTF-8, an invalid byte shown as U+FFFD. */
export function sourceText(raw: string): string {
    return new TextDecoder("utf-8").decode(binaryStringToBytes(raw));
}

/** The header block of a raw message, as text to read. */
export function headerText(raw: string): string {
    return sourceText(parseMimeEntity(raw).rawHeaderBlock);
}

/** The address in a raw message's own From header (which is not always the envelope sender the server files the message under), lowercased. */
export function headerFromAddress(raw: string): string | undefined {
    return extractAddresses(parseMimeEntity(raw).headers.from)[0];
}
