///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";

export interface FormFieldProps {
    label: string;
    htmlFor: string;
    children: ReactNode;
}

/** The repeated `.rr-field` label+input wrapper. The input (and any hint/error text) is passed as children. */
export default function FormField({ label, htmlFor, children }: FormFieldProps) {
    return (
        <div className="mb-4">
            <label htmlFor={htmlFor} className="block text-sm font-semibold mb-1.5 text-text">
                {label}
            </label>
            {children}
        </div>
    );
}
