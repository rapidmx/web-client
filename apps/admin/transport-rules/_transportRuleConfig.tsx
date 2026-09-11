///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { TransportRuleAction } from "@rapidmx/react-shared/transportRulesApi.js";
import { ActionTypeDef, ConditionFieldDef } from "../../shared/components/rules/RuleBuilder.js";

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
