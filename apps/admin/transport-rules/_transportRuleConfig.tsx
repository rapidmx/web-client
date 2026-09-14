///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { TransportRuleAction, TransportRuleConditions } from "@rapidmx/react-shared/admin/transportRulesApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import { ActionTypeDef, ConditionFieldDef, hasConditions } from "../../shared/components/rules/RuleBuilder.js";

/** Refused outright when a rule has no conditions: it would reject or quarantine every message the server receives. */
export const NO_CONDITIONS_BLOCKED_MESSAGE =
    "Add at least one condition. A rule without conditions that rejects or quarantines mail would do so for every message.";

/**
 * How a save should proceed given a rule's conditions: `"ok"` with at least one condition, `"blocked"` with none and a
 * reject/quarantine action, or `"confirm"` with none and only other actions (which then apply to every message).
 */
export function checkRuleConditions(rule: { conditions: TransportRuleConditions; actions: TransportRuleAction[] }): "ok" | "blocked" | "confirm" {
    if (hasConditions(rule.conditions)) {
        return "ok";
    }
    return rule.actions.some((action) => action.type === "reject" || action.type === "quarantine") ? "blocked" : "confirm";
}

/** Asks before saving a rule with no conditions whose actions will run on every message. */
export function NoConditionsConfirmModal({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
    return (
        <Modal open={open} onClose={onCancel} title="Apply to every message?">
            <p className="text-sm mb-5">
                This rule has no conditions, so its actions will run on every message this server receives or sends.
            </p>
            <div className="flex gap-3 justify-end">
                <Button type="button" variant="secondary" className="!w-auto" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" onClick={onConfirm}>
                    Save anyway
                </Button>
            </div>
        </Modal>
    );
}

const FIELD_INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export const TRANSPORT_RULE_CONDITION_FIELDS: ConditionFieldDef[] = [
    { key: "fromContains", label: "From contains", kind: "list" },
    { key: "subjectContains", label: "Subject contains", kind: "list" },
    { key: "bodyContains", label: "Body contains", kind: "list" },
    { key: "recipientContains", label: "Any recipient contains", kind: "list" },
    { key: "anyRecipientExternal", label: "Any recipient is external", kind: "boolean" },
    { key: "hasAttachment", label: "Has an attachment", kind: "boolean" },
    { key: "attachmentNameContains", label: "Attachment filename contains", kind: "list" },
];

export const TRANSPORT_RULE_ACTION_TYPES: ActionTypeDef<TransportRuleAction>[] = [
    {
        value: "reject",
        label: "Reject the message",
        createDefault: () => ({ type: "reject" }),
        render: () => null,
    },
    {
        value: "quarantine",
        label: "Quarantine every recipient's copy",
        createDefault: () => ({ type: "quarantine" }),
        render: () => null,
    },
    {
        value: "add_header",
        label: "Add a header",
        createDefault: () => ({ type: "add_header", headerName: "", headerValue: "" }),
        render: (action, onChange) => (
            <div className="flex gap-2">
                <input
                    type="text"
                    aria-label="Header name"
                    className={FIELD_INPUT_CLASS}
                    placeholder="X-Compliance-Flag"
                    value={action.headerName ?? ""}
                    onChange={(e) => onChange({ ...action, headerName: e.target.value })}
                />
                <input
                    type="text"
                    aria-label="Header value"
                    className={FIELD_INPUT_CLASS}
                    placeholder="reviewed"
                    value={action.headerValue ?? ""}
                    onChange={(e) => onChange({ ...action, headerValue: e.target.value })}
                />
            </div>
        ),
    },
    {
        value: "add_recipient",
        label: "Deliver an additional copy to",
        createDefault: () => ({ type: "add_recipient", recipientAddress: "" }),
        render: (action, onChange) => (
            <input
                type="email"
                aria-label="Recipient address"
                className={FIELD_INPUT_CLASS}
                placeholder="compliance@example.com"
                value={action.recipientAddress ?? ""}
                onChange={(e) => onChange({ ...action, recipientAddress: e.target.value })}
            />
        ),
    },
];
