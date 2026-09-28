///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderType, listFolders } from "../../../lib/mail/mailApi.js";
import { ApiClient } from "../../../lib/util/api.js";

/** The uid of a mailbox's well-known folder of `type` (e.g. its Contacts or Tasks folder), for creating an
 * item in a mailbox other than the one an app currently has loaded. Resolves `undefined` if the mailbox has
 * no such folder; rejects if the folder list can't be fetched. `client`, when given, is threaded through to
 * `listFolders()` (see `useApiClient()`'s own doc comment) - omitted, this behaves exactly as before. */
export async function findWellKnownFolderUid(mailboxUid: string, type: FolderType, client?: ApiClient): Promise<string | undefined> {
    const folders = await listFolders(mailboxUid, client);
    return folders.find((folder) => folder.type === type)?.uid;
}
