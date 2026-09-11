///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";

export default function Alert({ children }: { children: ReactNode }) {
    return (
        <div className="flex gap-2 items-start py-3 px-3.5 rounded-sm text-sm mb-5 bg-danger-bg text-danger" role="alert">
            {children}
        </div>
    );
}
