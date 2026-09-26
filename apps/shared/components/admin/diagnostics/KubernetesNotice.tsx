///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineInformationCircle } from "react-icons/hi2";

/**
 * Said where Kubernetes information would be, when the server cannot reach a cluster. That is ordinary (for one, when
 * RapidMX runs under Docker Compose), so it is a plain note and not an error.
 */
export default function KubernetesNotice({ reason }: { reason?: string }) {
    return (
        <div role="status" className="flex items-start gap-3 rounded-md border border-border bg-surface-alt p-4 text-sm">
            <HiOutlineInformationCircle size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-text-muted" />
            <div>
                <p className="font-medium">Kubernetes information is not available on this server.</p>
                {reason && <p className="mt-1 text-text-muted">{reason}</p>}
                <p className="mt-1 text-text-muted">
                    This is expected when RapidMX does not run in a Kubernetes cluster, for example under Docker Compose.
                </p>
            </div>
        </div>
    );
}
