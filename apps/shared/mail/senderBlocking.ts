///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    MailFilterRule,
    createMailFilterRule,
    deleteMailFilterRule,
    listMailFilterRules,
    updateMailFilterRule,
} from "@rapidmx/react-shared/mail/mailFilterRulesApi.js";

/**
 * "Block sender" and "Never block sender", expressed as the mailbox's own mail filter rules - the server has no blocked-senders list.
 * A rule's "From contains" is a case-insensitive substring match on the From header (restapi's `matchesConditions()`), which is the
 * closest thing there is to "from equals": it also matches a longer address that ends in this one (`joann@x.com` for `ann@x.com`).
 *
 * - **Block** is `From contains <address>` -> move to the mailbox's Junk Email, stop processing more rules, ahead of every other rule
 * (a sequence below all of them), so nothing else files the sender's mail first.
 * - **Never block** is `From contains <address>` -> move to the Inbox, stop processing, likewise first. It keeps the sender's mail out of
 * the reader's own blocking and filing rules. It cannot keep it out of Junk when the spam filter sends it there: mail the spam filter
 * has judged junk skips every rule (restapi's `ScanQueueJob.deliverMessage()`).
 *
 * Rules are found by what they do, not by their name, so one the reader renamed or made by hand is still the rule for that sender.
 */

/** Every rule listing asks for up to this many, which is the most the mail server reads when it filters a delivery. */
const RULE_LIMIT = 500;

export const BLOCK_RULE_PREFIX = "Block ";
export const NEVER_BLOCK_RULE_PREFIX = "Never block ";

/** `addresses` trimmed, lowercased and without repeats, keeping only what has an `@`. */
export function normalizeAddresses(addresses: (string | undefined)[]): string[] {
    return [...new Set(addresses.map((address) => address?.trim().toLowerCase() ?? "").filter((address) => address.includes("@")))];
}

/** Whether `rule` is "From contains ..." (every address of `addresses` among them, and nothing else) and moves to `folderUid` and stops. */
function isSenderRule(rule: MailFilterRule, addresses: string[], folderUid: string): boolean {
    const conditions = rule.conditions as Record<string, unknown>;
    const only = Object.keys(conditions).every((key) => key === "fromContains" || conditions[key] === undefined);
    const from = (rule.conditions.fromContains ?? []).map((entry) => entry.toLowerCase());
    return (
        only &&
        addresses.every((address) => from.includes(address)) &&
        rule.stopProcessingRules &&
        rule.actions.length === 1 &&
        rule.actions[0].type === "move_to_folder" &&
        rule.actions[0].folderUid === folderUid
    );
}

/** What blocking a sender did: `created` the rule, found it `existing` (and on), or turned an existing one back on. */
export interface BlockResult {
    outcome: "created" | "existing" | "enabled";
    rule: MailFilterRule;
}

/** What "Never block" did: the block rules it took away, and the rule that keeps the sender in the Inbox (`created` now or found). */
export interface NeverBlockResult {
    removed: MailFilterRule[];
    outcome: "created" | "existing" | "enabled";
    rule: MailFilterRule;
}

/** A sequence that puts a new rule ahead of every rule the mailbox has. */
function firstSequence(rules: MailFilterRule[]): number {
    return Math.min(0, ...rules.map((rule) => rule.sequence)) - 1;
}

/** Finds the rule that does `folderUid` for `addresses`, makes one (named `${prefix}${addresses[0]}`) if there is none, and turns a found one on. */
async function ensureRule(
    rules: MailFilterRule[],
    mailboxUid: string,
    addresses: string[],
    folderUid: string,
    prefix: string,
): Promise<{ outcome: "created" | "existing" | "enabled"; rule: MailFilterRule }> {
    const found = rules.find((rule) => isSenderRule(rule, addresses, folderUid));
    if (found) {
        if (found.enabled) {
            return { outcome: "existing", rule: found };
        }
        // The whole rule, as the filters page saves one: the update replaces the record.
        const { uid, version, name, sequence, stopProcessingRules, conditions, actions } = found;
        return { outcome: "enabled", rule: await updateMailFilterRule({ uid, version, name, enabled: true, sequence, stopProcessingRules, conditions, actions }) };
    }
    const rule = await createMailFilterRule({
        mailboxUid,
        name: `${prefix}${addresses[0]}`,
        sequence: firstSequence(rules),
        stopProcessingRules: true,
        conditions: { fromContains: addresses },
        actions: [{ type: "move_to_folder", folderUid }],
    });
    return { outcome: "created", rule };
}

/** Takes away every rule that is `folderUid` for `addresses`. */
async function removeRules(rules: MailFilterRule[], addresses: string[], folderUid: string): Promise<MailFilterRule[]> {
    const doomed = rules.filter((rule) => isSenderRule(rule, addresses, folderUid));
    for (const rule of doomed) {
        await deleteMailFilterRule(rule.uid, rule.version);
    }
    return doomed;
}

/**
 * Blocks a sender: mail from `addresses` (its envelope sender and From header address, when they differ - a mailing list or a bulk sender
 * usually has both) goes to `junkFolderUid` from now on. Idempotent: the rule is made once, and a rule that was turned off is turned on.
 * A "Never block" rule for the same sender is taken away, since the two would fight.
 */
export async function blockSender(mailboxUid: string, addresses: string[], junkFolderUid: string, inboxFolderUid: string): Promise<BlockResult> {
    const rules = await listMailFilterRules(mailboxUid, { limit: RULE_LIMIT });
    await removeRules(rules, addresses, inboxFolderUid);
    return ensureRule(rules, mailboxUid, addresses, junkFolderUid, BLOCK_RULE_PREFIX);
}

/** Never blocks a sender: takes away the block rule for `addresses` and makes (once) the rule that keeps their mail in the Inbox. */
export async function neverBlockSender(
    mailboxUid: string,
    addresses: string[],
    junkFolderUid: string,
    inboxFolderUid: string,
): Promise<NeverBlockResult> {
    const rules = await listMailFilterRules(mailboxUid, { limit: RULE_LIMIT });
    const removed = await removeRules(rules, addresses, junkFolderUid);
    const kept = await ensureRule(
        rules.filter((rule) => !removed.includes(rule)),
        mailboxUid,
        addresses,
        inboxFolderUid,
        NEVER_BLOCK_RULE_PREFIX,
    );
    return { removed, ...kept };
}

/** Takes back a rule this module made (the notification's Undo). */
export function removeSenderRule(rule: MailFilterRule): Promise<void> {
    return deleteMailFilterRule(rule.uid, rule.version);
}
