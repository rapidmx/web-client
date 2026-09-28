///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Anything with a mail address and, optionally, the name it is shown as - a `Recipient`, a message's `from`. `name` is
 * accepted as a synonym for `displayName` so callers holding either shape can pass it straight in. */
export interface MailAddressLike {
    address: string;
    displayName?: string;
    name?: string;
}

/** A sender/recipient split into what a compact row needs: the name (when there is a distinct one) and the address. */
export interface MailAddressParts {
    /** The display name, cleaned up - `undefined` when there is none, or it is only the address again. */
    name?: string;
    /** The real address, cleaned up. Always present: every format below shows it, whatever the name says. */
    address: string;
}

/** Control characters, and the invisible/bidirectional-override characters that can make one string read as another
 * (U+200B-200F, U+202A-202E, U+2060-2064, U+2066-2069, U+FEFF). */
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Characters that need a display name quoted (RFC 5322's specials, which is what keeps `Doe, Jane` one name), including
 * the fullwidth and small `@` a reader would take for a real one. */
const NEEDS_QUOTING = /[()<>[\]:;@＠﹫\\,"]/;

function clean(value: string | undefined): string {
    return (value ?? "").replace(INVISIBLE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

/**
 * An ingested message's `from` sometimes carries the whole `"Bob Allen" <bob@example.com>` From header as its display
 * name, which would be shown as `"Bob Allen" <bob@example.com> <bob@example.com>`. A name that ends in the sender's own
 * address in angle brackets is reduced to what precedes it, unquoted. Any other name is left exactly as it is - a name
 * showing a *different* address is never tidied away, so it can still be seen for what it is.
 */
function withoutOwnAddress(name: string, address: string): string {
    const wrapped = /^(.*)<([^<>]*)>$/.exec(name);
    if (!wrapped || wrapped[2].trim().toLowerCase() !== address.toLowerCase()) {
        return name;
    }
    return wrapped[1].trim().replace(/^"(.*)"$/s, "$1").trim();
}

/**
 * Splits a sender or recipient into its name and its address. The name is dropped when it is missing or is just the
 * address again (compared case-insensitively) - those show as the bare address.
 */
export function splitMailAddress(recipient: MailAddressLike): MailAddressParts {
    const address = clean(recipient.address);
    const name = withoutOwnAddress(clean(recipient.displayName ?? recipient.name), address);
    if (!name || name.toLowerCase() === address.toLowerCase()) {
        return { address };
    }
    return { name, address };
}

/**
 * `Name <address@domain>`, or just `address@domain` when there is no distinct name - the form a mail client shows so the
 * real address is never hidden behind a name. A name with a special character (a comma, a quote, an angle bracket, an
 * `@` ...) is quoted, `"Doe, Jane" <jane@example.com>`, so it reads as one name and can be pasted into a To field.
 * The real address always comes last and always appears, whatever the name says - including a name that is itself a
 * different address (`"ceo@bank.com" <evil@example.net>`).
 */
export function formatMailAddress(recipient: MailAddressLike): string {
    const { name, address } = splitMailAddress(recipient);
    if (!name) {
        return address;
    }
    const shown = NEEDS_QUOTING.test(name) ? `"${name.replace(/[\\"]/g, "\\$&")}"` : name;
    return `${shown} <${address}>`;
}
