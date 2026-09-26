///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlinePause, HiOutlinePlay } from "react-icons/hi2";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { formatDateTime } from "./format.js";
import HostCard from "./HostCard.js";
import KubernetesNotice from "./KubernetesNotice.js";
import { METRICS_POLL_INTERVAL_MS } from "./metricsHistory.js";
import NamespaceCard from "./NamespaceCard.js";
import ProcessCard from "./ProcessCard.js";
import PvcTable from "./PvcTable.js";
import type { MetricsPolling } from "./useMetricsPolling.js";

/** The System tab: live resource use, refreshed every few seconds, with the last few minutes drawn as sparklines. */
export default function SystemPanel({ polling }: { polling: MetricsPolling }) {
    const { history, error, loading, paused, setPaused } = polling;
    const latest = history[history.length - 1];
    const kubernetes = latest?.kubernetes;
    const errors = kubernetes?.errors ?? [];
    let status = `Updates every ${METRICS_POLL_INTERVAL_MS / 1000} seconds while this page is visible.`;
    if (paused) {
        status = "Updates are paused.";
    } else if (loading) {
        status = "Loading…";
    }
    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
                <Button
                    type="button"
                    variant="secondary"
                    className="!w-auto"
                    aria-pressed={paused}
                    onClick={() => setPaused(!paused)}
                >
                    {paused ? (
                        <>
                            <HiOutlinePlay size={16} aria-hidden="true" className="mr-1 inline" />
                            Resume
                        </>
                    ) : (
                        <>
                            <HiOutlinePause size={16} aria-hidden="true" className="mr-1 inline" />
                            Pause
                        </>
                    )}
                </Button>
                <p role="status" className="text-xs text-text-muted">
                    {status}
                    {latest && ` Last sample ${formatDateTime(latest.collectedAt)}.`}
                </p>
            </div>
            {error && <Alert>{error}</Alert>}
            {latest && (
                <>
                    <HostCard host={latest.host} history={history} />
                    <ProcessCard process={latest.process} history={history} />
                    {!kubernetes?.available ? (
                        <KubernetesNotice reason={kubernetes?.reason} />
                    ) : (
                        <>
                            {errors.length > 0 && (
                                <Alert>
                                    {errors.map((message) => (
                                        <div key={message}>{message}</div>
                                    ))}
                                </Alert>
                            )}
                            <NamespaceCard namespace={kubernetes.namespace} history={history} />
                            <PvcTable pvcs={kubernetes.pvcs ?? []} />
                        </>
                    )}
                </>
            )}
        </div>
    );
}
