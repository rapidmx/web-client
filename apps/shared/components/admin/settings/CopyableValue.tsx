///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import CopyIconButton from "../../../../../lib/components/buttons/CopyIconButton.js";

/** A value to type into a DNS provider's form, shown in full (long DKIM keys wrap) with a copy icon button beside it. */
export default function CopyableValue({ value, copyLabel }: { value: string; copyLabel: string }) {
    return (
        <div className="flex items-start gap-2">
            <code className="flex-1 min-w-0 text-xs break-all">{value}</code>
            <CopyIconButton value={value} label={copyLabel} className="shrink-0" />
        </div>
    );
}
