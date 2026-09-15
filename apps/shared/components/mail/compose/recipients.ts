///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Parsing and formatting of the To/Cc/Bcc fields' text. A field's value is a list of recipients separated by commas or
 * semicolons, each either a bare address or `Display Name <address>` (the name optionally quoted, so it can hold a comma
 * or semicolon itself). Separators inside quotes or angle brackets don't split.
 */
import type { ComposeRecipientInput } from "@rapidmx/react-shared/mail/mailApi.js";

/** One plain address: something, one `@`, something - no whitespace, brackets, quotes or separators. */
const ADDRESS_PATTERN = /^[^\s@<>()",;]+@[^\s@<>()",;]+$/;

/** Characters that make a display name need quoting. */
const NAME_SPECIALS = /[",;<>@()\\]/;

/** Splits at commas and semicolons outside quotes and angle brackets, keeping every part as is (empty ones too). An
 * unterminated quote or bracket runs to the end of the text. */
function splitRaw(value: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quoted = false;
    let bracketed = false;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (quoted && ch === "\\" && i + 1 < value.length) {
            current += ch + value[i + 1];
            i++;
            continue;
        }
        if (ch === '"' && !bracketed) {
            quoted = !quoted;
        } else if (ch === "<" && !quoted) {
            bracketed = true;
        } else if (ch === ">" && !quoted) {
            bracketed = false;
        } else if ((ch === "," || ch === ";") && !quoted && !bracketed) {
            parts.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}

/** Splits a field's text into trimmed, non-empty recipient strings - see `splitRaw()`. */
export function splitRecipientList(value: string): string[] {
    return splitRaw(value)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

/** Splits text typed into a field: the recipients finished by a separator, and the text after the last separator
 * (untrimmed; the whole text when there is no separator). */
export function splitTypedRecipients(text: string): { finished: string[]; rest: string } {
    const parts = splitRaw(text);
    const rest = parts.pop()!;
    return { finished: parts.map((part) => part.trim()).filter((part) => part.length > 0), rest };
}

function unquote(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\(.)/g, "$1").trim();
    }
    return trimmed;
}

/** Parses one recipient string: `Name <address>`, `"Name" <address>`, `<address>` or a bare address. Anything else is
 * kept whole as the address (so it's still sent, and flagged as invalid by the field). */
export function parseRecipient(text: string): ComposeRecipientInput {
    const trimmed = text.trim();
    const match = /^(.*)<([^<>]*)>\s*$/.exec(trimmed);
    if (match) {
        const address = match[2].trim();
        const displayName = unquote(match[1]);
        return displayName ? { address, displayName } : { address };
    }
    return { address: trimmed };
}

/** Every recipient in a field's text. */
export function parseRecipientList(value: string): ComposeRecipientInput[] {
    return splitRecipientList(value).map(parseRecipient);
}

/** Formats a recipient for a field: `Name <address>` (the name quoted when it holds a special character), or the bare
 * address without a name. */
export function formatRecipient(recipient: ComposeRecipientInput): string {
    const name = recipient.displayName?.trim();
    if (!name) {
        return recipient.address;
    }
    const safeName = NAME_SPECIALS.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
    return `${safeName} <${recipient.address}>`;
}

/** Whether `address` looks like one plain email address. */
export function isValidRecipientAddress(address: string): boolean {
    return ADDRESS_PATTERN.test(address);
}
