///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Folder, createFolder, listFolders } from "@rapidmx/react-shared/mail/mailApi.js";

/** The folders this page load has had to look up or make for a mailbox, so a second Report junk does not ask again. */
const resolved = new Map<string, string>();

/** Forgets every remembered folder - for the tests. */
export function clearResolvedFolders(): void {
    resolved.clear();
}

/**
 * A mailbox's own folder of `type` (Junk Email, Deleted Items, Inbox) - the reading pane's counterpart of the mail page's bulk
 * `resolveFolderOfType()`, so Report junk and Delete on one message go where the selection bar's go.
 *
 * Folders belong to a mailbox: only those of `mailboxUid` in `known` count (a message opened from a shared mailbox, or from a search
 * over several, is filed in ITS mailbox's Junk, never the open one's). The server makes every well-known folder itself, so one the tree
 * lacks is asked for - the tree may only be out of date - and used, never created twice; only a server that really has none is asked to
 * make it. `onFound` is told about a folder the tree did not have, so the sidebar picks it up.
 */
export async function resolveFolderOfType(
    mailboxUid: string,
    type: Folder["type"],
    name: string,
    known: Folder[] = [],
    onFound?: (folder: Folder) => void,
): Promise<string> {
    const inTree = known.find((folder) => folder.mailboxUid === mailboxUid && folder.type === type);
    if (inTree) {
        return inTree.uid;
    }
    const key = `${mailboxUid}:${type}`;
    const remembered = resolved.get(key);
    if (remembered) {
        return remembered;
    }
    const listed = (await listFolders(mailboxUid)).find((folder) => folder.type === type);
    if (listed) {
        onFound?.(listed);
        resolved.set(key, listed.uid);
        return listed.uid;
    }
    const created = await createFolder({ mailboxUid, name, type });
    resolved.set(key, created.uid);
    return created.uid;
}
