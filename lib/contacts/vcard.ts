///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Pure client-side vCard 3.0 generate/parse — `@rapidmx/restapi` has no vCard import/export support of its
 * own, and Outlook's Contacts UI treats this as a purely local file-format concern (a `.vcf` file never
 * touches the server as anything but ordinary `Contact` field values), so there's nothing to add there.
 */
import type { Contact, ContactAddressKind, ContactInput } from "./contactsApi.js";

/** Escapes a text value (RFC 6350 §3.4): backslash, comma and semicolon are backslash-escaped, and every
 * line break - CRLF, bare CR or bare LF - becomes `\n`, so a value can never break the content line. */
function escapeVCardValue(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/,/g, "\\,")
        .replace(/;/g, "\\;")
        .replace(/\r\n|\r|\n/g, "\\n");
}

/** Unescapes a text value in a single pass, so an escaped backslash followed by `n` (`\\n`) stays a
 * literal backslash + `n` instead of becoming a newline. `\n`/`\N` is a newline; any other escaped
 * character is itself. */
function unescapeVCardValue(value: string): string {
    return value.replace(/\\([\s\S])/g, (_match, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/** Splits a structured value (`N`, `ADR`) on its unescaped `;` separators, then unescapes each component. */
function splitStructuredValue(value: string): string[] {
    const components: string[] = [];
    let current = "";
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === "\\" && i + 1 < value.length) {
            current += ch + value[++i];
        } else if (ch === ";") {
            components.push(unescapeVCardValue(current));
            current = "";
        } else {
            current += ch;
        }
    }
    components.push(unescapeVCardValue(current));
    return components;
}

/** Builds a single vCard 3.0 record for one contact. */
export function contactToVCard(contact: Contact): string {
    const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
    lines.push(`N:${escapeVCardValue(contact.surname ?? "")};${escapeVCardValue(contact.givenName ?? "")};;;`);
    lines.push(`FN:${escapeVCardValue(contact.displayName)}`);
    if (contact.company) {
        lines.push(`ORG:${escapeVCardValue(contact.company)}`);
    }
    if (contact.jobTitle) {
        lines.push(`TITLE:${escapeVCardValue(contact.jobTitle)}`);
    }
    for (const email of contact.emails) {
        lines.push(`EMAIL;TYPE=${email.type.toUpperCase()}:${escapeVCardValue(email.address)}`);
    }
    for (const phone of contact.phones) {
        lines.push(`TEL;TYPE=${phone.type.toUpperCase()}:${escapeVCardValue(phone.phoneNumber)}`);
    }
    for (const address of contact.addresses) {
        const parts = [
            "",
            "",
            address.street ?? "",
            address.city ?? "",
            address.state ?? "",
            address.postalCode ?? "",
            address.country ?? "",
        ];
        lines.push(`ADR;TYPE=${address.type.toUpperCase()}:${parts.map(escapeVCardValue).join(";")}`);
    }
    if (contact.notes) {
        lines.push(`NOTE:${escapeVCardValue(contact.notes)}`);
    }
    lines.push("END:VCARD");
    return lines.join("\r\n");
}

/** Builds a single `.vcf` file's text content from multiple contacts (one `BEGIN:VCARD`/`END:VCARD` block
 * per contact — the standard way multiple vCards share one file). */
export function contactsToVCardFile(contacts: Contact[]): string {
    return contacts.map(contactToVCard).join("\r\n");
}

/** A parsed vCard's fields, shaped as a partial `ContactInput` missing only the `mailboxUid`/`folderUid`
 * scope (the caller supplies those, since they're not part of the vCard format itself). */
export type ParsedVCardContact = Omit<ContactInput, "mailboxUid" | "folderUid">;

/** Index of the content line's name/value separator: the first `:` outside a quoted parameter value. */
function valueSeparatorIndex(line: string): number {
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') {
            inQuotes = !inQuotes;
        } else if (line[i] === ":" && !inQuotes) {
            return i;
        }
    }
    return -1;
}

/** How much of a file's text `parseVCards()` reads, and how many records it takes from it (the rest is ignored). */
export const VCARD_MAX_CHARS = 5_000_000;
export const VCARD_MAX_CONTACTS = 2_000;

/** Decodes a quoted-printable value: each `=XX` is one byte, and the bytes are text in `charset` (UTF-8 when none is named or the name is unknown). */
function decodeQuotedPrintable(value: string, charset: string | undefined): string {
    const encoder = new TextEncoder();
    const bytes: number[] = [];
    for (const [, hex, literal] of value.matchAll(/=([0-9a-f]{2})|([\s\S])/giu)) {
        if (hex) {
            bytes.push(parseInt(hex, 16));
        } else {
            bytes.push(...encoder.encode(literal));
        }
    }
    try {
        return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes));
    } catch {
        return new TextDecoder().decode(new Uint8Array(bytes));
    }
}

/** `lines` with each quoted-printable line that ends in `=` (a soft line break) joined to the line that carries on from it. */
function joinQuotedPrintableLines(lines: string[]): string[] {
    const joined: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (/^[^:]*QUOTED-PRINTABLE/i.test(line)) {
            // Collected and joined once: appending to a growing string a line at a time is quadratic in a value of many soft breaks.
            const parts: string[] = [];
            while (line.endsWith("=") && i + 1 < lines.length) {
                parts.push(line.slice(0, -1));
                line = lines[++i];
            }
            parts.push(line);
            line = parts.join("");
        }
        joined.push(line);
    }
    return joined;
}

/**
 * Maps a property's type parameters onto `ContactAddressKind`: every `TYPE=` value (vCard 3/4, including
 * comma lists and quoted lists like `TYPE="work,voice"`) plus vCard 2.1's bare parameters (`EMAIL;WORK:`)
 * are collected case-insensitively; `work` wins, then `home`, and anything else (`internet`, `cell`,
 * `pref`, no type at all) is `other`.
 */
function normalizeType(params: string[]): ContactAddressKind {
    const tokens = new Set<string>();
    for (const param of params) {
        const eq = param.indexOf("=");
        const name = eq === -1 ? "TYPE" : param.slice(0, eq).trim().toUpperCase();
        if (name !== "TYPE") {
            continue;
        }
        for (const token of param.slice(eq + 1).replace(/"/g, "").split(",")) {
            tokens.add(token.trim().toLowerCase());
        }
    }
    return tokens.has("work") ? "work" : tokens.has("home") ? "home" : "other";
}

/**
 * Parses one or more vCard 2.1/3.0/4.0 records from a `.vcf` file's text content. Deliberately tolerant of
 * fields this app doesn't model (PHOTO, BDAY, etc. — silently ignored) and of the `TYPE=` parameter being
 * absent (defaults to "other") — real-world exported vCards vary a lot in exactly which optional parameters
 * they include. Folded lines (a line break followed by a space or tab) are unfolded first; property group
 * prefixes (`item1.EMAIL`, as Apple Contacts writes) are ignored; `TYPE` values are normalized (see
 * `normalizeType()`); structured values are split on unescaped `;` only.
 */
export function parseVCards(text: string): ParsedVCardContact[] {
    // A file is read only so far: nothing legitimate is this large, and a huge one would be minutes of parsing and thousands of records.
    const source = text.length > VCARD_MAX_CHARS ? text.slice(0, VCARD_MAX_CHARS) : text;
    // Unfold first, then split only on a line that is exactly BEGIN:VCARD - a NOTE (or a folded line) that
    // merely contains the text "BEGIN:VCARD" must not start a bogus record.
    const unfolded = source.replace(/(?:\r\n|\r|\n)[ \t]/g, "");
    const cards = unfolded.split(/^[ \t]*BEGIN:VCARD[ \t]*$/im).slice(1, VCARD_MAX_CONTACTS + 1);
    return cards.map((card) => {
        const contact: ParsedVCardContact = { displayName: "", emails: [], phones: [], addresses: [] };
        const lines = joinQuotedPrintableLines(card.split(/\r\n|\r|\n/));
        for (const rawLine of lines) {
            const line = rawLine.trim();
            const colonIndex = valueSeparatorIndex(line);
            if (colonIndex === -1) {
                continue;
            }
            const key = line.slice(0, colonIndex);
            const [groupedName, ...params] = key.split(";");
            // vCard 2.1 may encode a value as quoted-printable (`ENCODING=QUOTED-PRINTABLE`, or the bare parameter), in a named charset;
            // such a value has no backslash escapes.
            const quotedPrintable = params.some((param) => /^(?:ENCODING=)?QUOTED-PRINTABLE$/i.test(param.trim()));
            const charset = params.find((param) => /^CHARSET=/i.test(param.trim()))?.trim().slice("CHARSET=".length).replace(/"/g, "");
            const rawValue = quotedPrintable ? decodeQuotedPrintable(line.slice(colonIndex + 1), charset) : line.slice(colonIndex + 1);
            const value = quotedPrintable ? rawValue : unescapeVCardValue(rawValue);
            const name = groupedName.slice(groupedName.lastIndexOf(".") + 1).toUpperCase();
            const type = normalizeType(params);

            switch (name) {
                case "FN":
                    contact.displayName = value;
                    break;
                case "N": {
                    const [surname, given] = splitStructuredValue(rawValue);
                    if (surname) contact.surname = surname;
                    if (given) contact.givenName = given;
                    break;
                }
                case "ORG":
                    // ORG is structured too (organization;unit;...) - only the organization name is modeled.
                    contact.company = splitStructuredValue(rawValue)[0];
                    break;
                case "TITLE":
                    contact.jobTitle = value;
                    break;
                case "EMAIL":
                    // An empty one would make the server refuse the whole contact.
                    if (value.trim()) {
                        contact.emails!.push({ address: value.trim(), type });
                    }
                    break;
                case "TEL":
                    if (value.trim()) {
                        contact.phones!.push({ phoneNumber: value, type });
                    }
                    break;
                case "ADR": {
                    const [, , street, city, state, postalCode, country] = splitStructuredValue(rawValue);
                    contact.addresses!.push({ street, city, state, postalCode, country, type });
                    break;
                }
                case "NOTE":
                    contact.notes = value;
                    break;
                default:
                    break;
            }
        }
        if (!contact.displayName) {
            contact.displayName = [contact.givenName, contact.surname].filter(Boolean).join(" ") || "Unnamed contact";
        }
        return contact;
    });
}
