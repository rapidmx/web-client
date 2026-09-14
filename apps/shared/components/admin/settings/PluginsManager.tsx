///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    addPlugin,
    expectedPlanOf,
    getPluginStatus,
    getPluginUpdates,
    listPluginNamespaces,
    listPlugins,
    lookupPluginPackage,
    planPluginChange,
    Plugin,
    PluginChangePlan,
    PluginInstanceStatus,
    PluginNamespace,
    PluginRegistryLookup,
    PluginSearchResult,
    PluginSettingDefinition,
    PluginSettingValue,
    PluginStatus,
    PluginUpdateInfo,
    removePlugin,
    searchPlugins,
    updatePlugin,
} from "@rapidmx/react-shared/admin/pluginsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** How often status is refreshed while server copies are still applying a change. */
const PENDING_POLL_MS = 5000;

/** How long status keeps being polled after a saved change, since servers may not have noticed it yet. */
const AFTER_CHANGE_POLL_MS = 2 * 60 * 1000;

/** The longest wait between retries while no status has ever been read. */
const MAX_STATUS_RETRY_MS = 60 * 1000;

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof ApiRequestError ? err.message : fallback;
}

/** Runs `action`, resolving why it failed, or `null`. */
async function attempt(action: () => Promise<void>, failure: string): Promise<string | null> {
    try {
        await action();
        return null;
    } catch (err) {
        return errorMessage(err, failure);
    }
}

/** A change waiting for the administrator to confirm the other plugins it also installs or enables. */
interface PendingChange {
    displayName: string;
    plan: PluginChangePlan;
    apply: (plan: PluginChangePlan) => Promise<void>;
    failure: string;
    /** The installed plugin being changed, which stays busy while the change waits for confirmation. */
    uid?: string;
}

/** Installed plugins with their rollout status, and every plugin action - shared by the Plugins page and the
 * setup wizard. */
export default function PluginsManager() {
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [status, setStatus] = useState<PluginStatus | null>(null);
    /** Set when the last status refresh failed, so what's shown may be out of date. */
    const [statusStale, setStatusStale] = useState(false);
    /** When polling started by a saved change stops (epoch ms), or 0 when there's none. */
    const [pollUntil, setPollUntil] = useState(0);
    const [updates, setUpdates] = useState<Map<string, PluginUpdateInfo>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    /** The installed plugin whose enable just failed, offered a retry next to `error`. */
    const [retryEnableUid, setRetryEnableUid] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [upgrading, setUpgrading] = useState<Plugin | null>(null);
    const [configuring, setConfiguring] = useState<Plugin | null>(null);
    const [removing, setRemoving] = useState<Plugin | null>(null);
    const [confirming, setConfirming] = useState<PendingChange | null>(null);
    /** Installed plugins with an action under way. */
    const [busyUids, setBusyUids] = useState<ReadonlySet<string>>(new Set());
    /** Set when re-reading the list after a change failed, so rows may not show what that change also did. */
    const [listStale, setListStale] = useState(false);
    /** How many times status has been retried while none has ever been read. */
    const [statusRetries, setStatusRetries] = useState(0);
    const statusRequest = useRef<Promise<void> | null>(null);

    const setBusy = (uid: string, busy: boolean) =>
        setBusyUids((prev) => {
            const next = new Set(prev);
            if (busy) {
                next.add(uid);
            } else {
                next.delete(uid);
            }
            return next;
        });

    const refreshStatus = useCallback(() => {
        // One read at a time: a poll that comes due while a slow read is still running shares it.
        statusRequest.current ??= getPluginStatus()
            .then((next) => {
                setStatus(next);
                setStatusStale(false);
            })
            // Status is advisory - a failure to read it shouldn't hide the plugin list, or lose the last status read.
            .catch(() => setStatusStale(true))
            .finally(() => {
                statusRequest.current = null;
            });
        return statusRequest.current;
    }, []);

    const refreshUpdates = useCallback(() => {
        // Also advisory: a registry that can't be reached just means no update badges.
        return getPluginUpdates()
            .then((list) => setUpdates(new Map(list.map((info) => [info.uid, info]))))
            .catch(() => setUpdates(new Map()));
    }, []);

    /** Re-reads the list, for changes that also installed or enabled other plugins. */
    const reload = useCallback(() => {
        return listPlugins()
            .then((list) => {
                setPlugins(list);
                setListStale(false);
            })
            .catch(() => setListStale(true));
    }, []);

    useEffect(() => {
        Promise.all([listPlugins(), refreshStatus()])
            .then(([list]) => {
                setPlugins(list);
                void refreshUpdates();
            })
            .catch((err) => setError(errorMessage(err, "Could not load plugins.")))
            .finally(() => setLoading(false));
    }, [refreshStatus, refreshUpdates]);

    const pending: boolean = !!status && status.instances.some((instance) => instance.hash !== status.hash);
    useEffect(() => {
        if (!pending && pollUntil === 0) {
            return;
        }
        const timer = setInterval(() => void refreshStatus(), PENDING_POLL_MS);
        // Polling for a saved change ends after a while; a rollout that's under way keeps it going.
        const stop = pollUntil > 0 ? setTimeout(() => setPollUntil(0), Math.max(0, pollUntil - Date.now())) : undefined;
        return () => {
            clearInterval(timer);
            clearTimeout(stop);
        };
    }, [pending, pollUntil, refreshStatus]);

    // With no status read at all there's nothing pending to poll for, so keep retrying - less often each time.
    const neverRead: boolean = !status && statusStale;
    useEffect(() => {
        if (!neverRead) {
            return;
        }
        const timer = setTimeout(
            () => void refreshStatus().then(() => setStatusRetries((n) => n + 1)),
            Math.min(PENDING_POLL_MS * 2 ** statusRetries, MAX_STATUS_RETRY_MS),
        );
        return () => clearTimeout(timer);
    }, [neverRead, statusRetries, refreshStatus]);

    /** Re-reads status, and keeps doing so for a while, since saving starts a rollout servers pick up shortly. */
    function watchRollout() {
        setPollUntil(Date.now() + AFTER_CHANGE_POLL_MS);
        void refreshStatus();
    }

    /** Applies saved changes locally and re-reads status and updates, since saving starts a rollout. */
    function applied(...changed: Plugin[]) {
        setPlugins((prev) => {
            let next = prev;
            for (const updated of changed) {
                const exists = next.some((plugin) => plugin.uid === updated.uid);
                next = exists ? next.map((plugin) => (plugin.uid === updated.uid ? updated : plugin)) : [...next, updated];
            }
            return [...next].sort((a, b) => a.name.localeCompare(b.name));
        });
        watchRollout();
        void refreshUpdates();
    }

    /** Runs an action on an installed plugin's row, which is busy meanwhile, and shows why it failed. */
    async function onRow(plugin: Plugin, action: () => Promise<string | null>) {
        setBusy(plugin.uid, true);
        setError(null);
        setRetryEnableUid(null);
        const problem = await action();
        if (problem) {
            setError(problem);
        }
        // A change waiting for confirmation keeps the row busy by itself, until the confirmation closes.
        setBusy(plugin.uid, false);
    }

    function toggle(plugin: Plugin) {
        const displayName: string = plugin.manifest.displayName;
        if (plugin.enabled) {
            return onRow(plugin, () =>
                attempt(async () => applied(await updatePlugin(plugin.uid, { version: plugin.version, enabled: false })), `Could not disable ${displayName}.`),
            );
        }
        // Enabling a plugin also installs or enables the plugins it requires, so it's previewed like any other change.
        // The installed version is planned from its stored manifest, so this doesn't need the registry. A preview that
        // fails is never skipped - enabling without one could install or enable other plugins the administrator never
        // saw - so the failure is shown with a retry instead.
        return onRow(plugin, async () => {
            const problem = await planned(
                plugin.name,
                plugin.packageVersion,
                displayName,
                async (plan) => {
                    applied(await updatePlugin(plugin.uid, { version: plugin.version, enabled: true, expectedPlan: expectedPlanOf(plan) }));
                    if (plan.install.length > 0 || plan.enable.length > 0) {
                        void reload();
                    }
                },
                `Could not enable ${displayName}.`,
                { uid: plugin.uid },
            );
            if (problem) {
                setRetryEnableUid(plugin.uid);
            }
            return problem;
        });
    }

    /**
     * Checks what installing or changing a plugin also takes before doing it. Resolves why it can't be done, or `null`
     * once it's done - or, when it also installs or enables other plugins, once they're shown for confirmation.
     */
    async function planned(
        name: string,
        packageVersion: string,
        displayName: string,
        apply: (plan: PluginChangePlan) => Promise<void>,
        failure: string,
        options: { uid?: string } = {},
    ): Promise<string | null> {
        let plan: PluginChangePlan;
        try {
            plan = await planPluginChange(name, packageVersion);
        } catch (err) {
            return errorMessage(err, failure);
        }
        if (plan.conflicts.length > 0) {
            return `${displayName} ${plan.plugin.version} can't be installed. ${plan.conflicts.join(" ")}`;
        }
        if (plan.install.length > 0 || plan.enable.length > 0) {
            setConfirming({ displayName, plan, apply, failure, uid: options.uid });
            return null;
        }
        return attempt(() => apply(plan), failure);
    }

    function install(name: string, packageVersion: string, displayName: string) {
        return planned(
            name,
            packageVersion,
            displayName,
            async (plan) => {
                const result = await addPlugin(name, packageVersion, expectedPlanOf(plan));
                applied(...result.dependencies, result.plugin);
            },
            `Could not install ${displayName}.`,
        );
    }

    function changeVersion(plugin: Plugin, packageVersion: string) {
        const failure = `Could not upgrade ${plugin.manifest.displayName}.`;
        if (!plugin.enabled) {
            // A disabled plugin stays disabled, so nothing it requires is installed or enabled - there's nothing to preview.
            return attempt(async () => applied(await updatePlugin(plugin.uid, { version: plugin.version, packageVersion })), failure);
        }
        return planned(
            plugin.name,
            packageVersion,
            plugin.manifest.displayName,
            async (plan) => {
                applied(await updatePlugin(plugin.uid, { version: plugin.version, packageVersion, expectedPlan: expectedPlanOf(plan) }));
                if (plan.install.length > 0 || plan.enable.length > 0) {
                    void reload();
                }
            },
            failure,
            { uid: plugin.uid },
        );
    }

    function upgrade(plugin: Plugin, packageVersion: string) {
        return onRow(plugin, () => changeVersion(plugin, packageVersion));
    }

    // Retried against the plugin as it's listed now (a newer version, or already enabled elsewhere, hides the retry).
    const retryEnable: Plugin | undefined = plugins.find((plugin) => plugin.uid === retryEnableUid && !plugin.enabled);

    const displayNameOf = (name: string): string => plugins.find((plugin) => plugin.name === name)?.manifest.displayName ?? name;

    return (
        <>
            <div className="flex items-center justify-between mb-2">
                <h1 className="text-xl font-bold uppercase tracking-wide">Plugins</h1>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setAdding(true)}>
                    Add by name
                </Button>
            </div>
            <p className="text-sm text-text-muted mb-5 max-w-3xl">
                Plugins add protocols and features to every server. Changes are applied by restarting the servers
                one at a time, so mail keeps flowing. Plugins run with full access to the server, so only add ones
                you trust.
            </p>

            {error && (
                <Alert>
                    {error}
                    {retryEnable && (
                        <>
                            {" "}
                            <Button
                                type="button"
                                variant="text"
                                className="!w-auto !p-0"
                                onClick={() => void toggle(retryEnable)}
                            >
                                Try again
                            </Button>
                        </>
                    )}
                </Alert>
            )}
            <RolloutBanner status={status} />
            {statusStale && status && (
                <p className="mb-4 text-xs text-text-muted">Couldn&apos;t refresh server status. Showing the last status reported.</p>
            )}
            {listStale && (
                <p className="mb-4 text-xs text-text-muted">
                    Couldn&apos;t re-read the plugin list, so it may be out of date.{" "}
                    <Button type="button" variant="text" className="!w-auto !p-0 !text-xs" onClick={() => void reload()}>
                        Retry
                    </Button>
                </p>
            )}

            <h2 className="text-sm font-bold uppercase tracking-wide mb-2">Installed plugins</h2>
            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : plugins.length === 0 ? (
                <p className="text-sm text-text-muted">No plugins installed.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Plugin", "Version", "State", "Servers", ""].map((h) => (
                                    <th
                                        key={h}
                                        className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                    >
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {plugins.map((plugin) => {
                                const update: PluginUpdateInfo | undefined = updates.get(plugin.uid);
                                const latest: string | undefined = update?.updateAvailable ? update.latestVersion : undefined;
                                const busy: boolean = busyUids.has(plugin.uid) || confirming?.uid === plugin.uid;
                                const requires: string[] = Object.keys(plugin.manifest.requires ?? {}).map(displayNameOf);
                                const requiredBy: string[] = plugins
                                    .filter((other) => other.uid !== plugin.uid && other.manifest.requires?.[plugin.name] !== undefined)
                                    .map((other) => other.manifest.displayName);
                                return (
                                    <tr key={plugin.uid}>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <div className="font-semibold">{plugin.manifest.displayName}</div>
                                            <div className="text-xs text-text-muted">{plugin.name}</div>
                                            {plugin.manifest.description && (
                                                <div className="text-xs text-text-muted mt-1 max-w-md">{plugin.manifest.description}</div>
                                            )}
                                            {requires.length > 0 && <div className="text-xs text-text-muted mt-1">Requires: {requires.join(", ")}</div>}
                                            {requiredBy.length > 0 && (
                                                <div className="text-xs text-text-muted mt-1">Required by: {requiredBy.join(", ")}</div>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <div>{plugin.packageVersion}</div>
                                            {latest && (
                                                <div className="mt-1 flex flex-col items-start gap-1">
                                                    <span className="text-xs font-semibold text-primary-dark">Update available: {latest}</span>
                                                    <Button
                                                        type="button"
                                                        variant="secondary"
                                                        className="!w-auto !py-1 !px-2 !text-xs"
                                                        aria-label={`Upgrade ${plugin.manifest.displayName} to ${latest}`}
                                                        disabled={busy}
                                                        onClick={() => void upgrade(plugin, latest)}
                                                    >
                                                        Upgrade
                                                    </Button>
                                                </div>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            {plugin.enabled ? (
                                                <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">
                                                    Enabled
                                                </span>
                                            ) : (
                                                <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                                    Disabled
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <PluginStatusCell plugin={plugin} status={status} />
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top text-right whitespace-nowrap">
                                            <Button
                                                variant="text"
                                                type="button"
                                                className="!w-auto"
                                                aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.manifest.displayName}`}
                                                disabled={busy}
                                                onClick={() => void toggle(plugin)}
                                            >
                                                {plugin.enabled ? "Disable" : "Enable"}
                                            </Button>
                                            {(plugin.manifest.settings ?? []).length > 0 && (
                                                <Button variant="text" type="button" className="!w-auto" onClick={() => setConfiguring(plugin)}>
                                                    Settings
                                                </Button>
                                            )}
                                            <Button variant="text" type="button" className="!w-auto" onClick={() => setUpgrading(plugin)}>
                                                Change version
                                            </Button>
                                            <Button variant="text" type="button" className="!w-auto" onClick={() => setRemoving(plugin)}>
                                                Uninstall
                                            </Button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <PluginBrowser
                plugins={plugins}
                onInstall={(result) => install(result.name, result.version, result.name)}
                // The browser only offers an upgrade for a result it matched to one of these same `plugins`.
                onUpgrade={(uid, packageVersion) => upgrade(plugins.find((p) => p.uid === uid)!, packageVersion)}
            />

            <AddPluginModal
                open={adding}
                onClose={() => setAdding(false)}
                onAdd={async (name, packageVersion, displayName) => {
                    const problem = await install(name, packageVersion, displayName);
                    if (!problem) {
                        setAdding(false);
                    }
                    return problem;
                }}
            />
            {upgrading && (
                <ChangeVersionModal
                    plugin={upgrading}
                    onClose={() => setUpgrading(null)}
                    onSave={async (packageVersion) => {
                        const problem = await changeVersion(upgrading, packageVersion);
                        if (!problem) {
                            setUpgrading(null);
                        }
                        return problem;
                    }}
                />
            )}
            {confirming && (
                <ConfirmDependenciesModal
                    change={confirming}
                    displayNameOf={displayNameOf}
                    onClose={() => setConfirming(null)}
                    onDone={() => setConfirming(null)}
                />
            )}
            {configuring && (
                <SettingsModal
                    plugin={configuring}
                    onClose={() => setConfiguring(null)}
                    onSaved={(plugin) => {
                        setConfiguring(null);
                        applied(plugin);
                    }}
                />
            )}
            {removing && (
                <RemoveModal
                    plugin={removing}
                    onClose={() => setRemoving(null)}
                    onRemoved={() => {
                        const uid = removing.uid;
                        setRemoving(null);
                        setPlugins((prev) => prev.filter((plugin) => plugin.uid !== uid));
                        watchRollout();
                    }}
                />
            )}
        </>
    );
}

const ALL_NAMESPACES = "";

/** Searches the configured namespaces' registries for plugin packages, with install and upgrade actions. */
function PluginBrowser({
    plugins,
    onInstall,
    onUpgrade,
}: {
    plugins: Plugin[];
    /** Resolves why the plugin couldn't be installed, or `null`. */
    onInstall: (result: PluginSearchResult) => Promise<string | null>;
    onUpgrade: (uid: string, packageVersion: string) => Promise<void>;
}) {
    const [namespaces, setNamespaces] = useState<PluginNamespace[]>([]);
    const [namespace, setNamespace] = useState(ALL_NAMESPACES);
    const [results, setResults] = useState<PluginSearchResult[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [busyName, setBusyName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        listPluginNamespaces()
            .then(setNamespaces)
            .catch(() => setNamespaces([]));
    }, []);

    async function search(e: FormEvent) {
        e.preventDefault();
        setSearching(true);
        setError(null);
        try {
            setResults(await searchPlugins(namespace || undefined));
        } catch (err) {
            setResults(null);
            setError(errorMessage(err, "Could not search for plugins."));
        } finally {
            setSearching(false);
        }
    }

    // Keep results in step with installs and upgrades made anywhere on the page.
    const rows: PluginSearchResult[] = (results ?? []).map((result) => {
        const installed: Plugin | undefined = plugins.find((plugin) => plugin.name === result.name);
        return {
            ...result,
            installedUid: installed?.uid,
            installedVersion: installed?.packageVersion,
            updateAvailable: !!installed && installed.packageVersion !== result.version && result.updateAvailable,
        };
    });

    async function install(result: PluginSearchResult) {
        setBusyName(result.name);
        setError(null);
        setError(await onInstall(result));
        setBusyName(null);
    }

    async function upgrade(result: PluginSearchResult) {
        setBusyName(result.name);
        try {
            await onUpgrade(result.installedUid!, result.version);
        } finally {
            setBusyName(null);
        }
    }

    return (
        <section aria-labelledby="plugin-browser-title" className="mt-8">
            <h2 id="plugin-browser-title" className="text-sm font-bold uppercase tracking-wide mb-2">
                Find plugins
            </h2>
            <form onSubmit={(e) => void search(e)} className="flex flex-wrap gap-2 items-end mb-3">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Namespace</span>
                    <select aria-label="Namespace" className={INPUT_CLASS} value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                        <option value={ALL_NAMESPACES}>All namespaces</option>
                        {namespaces.map((ns) => (
                            <option key={ns.name} value={ns.name}>
                                {ns.name}
                            </option>
                        ))}
                    </select>
                </label>
                <Button type="submit" className="!w-auto" loading={searching} disabled={searching}>
                    Search
                </Button>
            </form>
            {error && <Alert>{error}</Alert>}
            {results !== null &&
                (rows.length === 0 ? (
                    <p className="text-sm text-text-muted">No plugins found.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <thead>
                                <tr>
                                    {["Package", "Latest version", "Status", ""].map((h) => (
                                        <th
                                            key={h}
                                            className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                        >
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((result) => (
                                    <tr key={result.name}>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <div className="font-semibold">{result.name}</div>
                                            {result.description && <div className="text-xs text-text-muted max-w-md">{result.description}</div>}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">{result.version}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top text-text-muted">
                                            {result.updateAvailable
                                                ? `Installed ${result.installedVersion} - update available`
                                                : result.installedUid
                                                  ? `Installed ${result.installedVersion}`
                                                  : result.allowed
                                                    ? "Not installed"
                                                    : "Not allowed on this server"}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top text-right">
                                            {result.updateAvailable ? (
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    className="!w-auto"
                                                    aria-label={`Upgrade ${result.name} to ${result.version}`}
                                                    disabled={busyName === result.name}
                                                    onClick={() => void upgrade(result)}
                                                >
                                                    Upgrade
                                                </Button>
                                            ) : (
                                                !result.installedUid &&
                                                result.allowed && (
                                                    <Button
                                                        type="button"
                                                        className="!w-auto"
                                                        aria-label={`Install ${result.name}`}
                                                        loading={busyName === result.name}
                                                        disabled={busyName === result.name}
                                                        onClick={() => void install(result)}
                                                    >
                                                        Install
                                                    </Button>
                                                )
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ))}
        </section>
    );
}

/** Name a server reports an error under when it isn't about any single plugin (e.g. the plugin set as a whole failed). */
const SERVER_WIDE_ERROR_NAME = "*";

/**
 * Shown while any server copy hasn't applied the saved plugin set yet, when one is in safe mode, or when one reports a
 * server-wide plugin error - those match no plugin row, so without this they'd never be shown.
 */
function RolloutBanner({ status }: { status: PluginStatus | null }) {
    if (!status || status.instances.length === 0) {
        return null;
    }
    const behind = status.instances.filter((instance) => instance.hash !== status.hash).length;
    const safeMode = status.instances.filter((instance) => instance.safeMode);
    const serverWideErrors = status.instances.flatMap((instance) =>
        instance.errors
            .filter((entry) => entry.name === SERVER_WIDE_ERROR_NAME)
            .map((entry) => `${instance.instance}: ${entry.message}`),
    );
    return (
        <>
            {serverWideErrors.length > 0 && (
                <Alert>
                    Plugins couldn&rsquo;t be loaded:
                    <ul className="list-disc pl-5 mt-1">
                        {serverWideErrors.map((message) => (
                            <li key={message} className="break-words">
                                {message}
                            </li>
                        ))}
                    </ul>
                </Alert>
            )}
            {behind > 0 && (
                <p role="status" className="mb-4 text-sm py-2 px-3 rounded-sm bg-surface-alt text-text">
                    Applying changes: {status.instances.length - behind} of {status.instances.length}{" "}
                    {status.instances.length === 1 ? "server" : "servers"} updated. Servers restart one at a time.
                </p>
            )}
            {safeMode.length > 0 && (
                <Alert>
                    {safeMode.map((instance) => instance.instance).join(", ")} started without any plugins because recent
                    starts failed. Fix or disable the failing plugin, and the server will pick up the change.
                </Alert>
            )}
        </>
    );
}

function PluginStatusCell({ plugin, status }: { plugin: Plugin; status: PluginStatus | null }) {
    if (!plugin.enabled) {
        return <span className="text-text-muted">Disabled</span>;
    }
    if (!status || status.instances.length === 0) {
        return <span className="text-text-muted">Unknown</span>;
    }
    const current: PluginInstanceStatus[] = status.instances.filter((instance) => instance.hash === status.hash);
    const loaded = current.filter((instance) =>
        instance.loaded.some((entry) => entry.name === plugin.name && entry.version === plugin.packageVersion),
    ).length;
    const errors = current.flatMap((instance) =>
        instance.errors.filter((entry) => entry.name === plugin.name).map((entry) => `${instance.instance}: ${entry.message}`),
    );
    return (
        <div>
            <span className={loaded === status.instances.length ? "text-success font-medium" : "text-text-muted"}>
                Loaded on {loaded} of {status.instances.length} {status.instances.length === 1 ? "server" : "servers"}
            </span>
            {errors.map((message) => (
                <div key={message} className="text-xs text-danger mt-1">
                    {message}
                </div>
            ))}
        </div>
    );
}

function AddPluginModal({
    open,
    onClose,
    onAdd,
}: {
    open: boolean;
    onClose: () => void;
    /** Resolves why the plugin couldn't be added, or `null`. */
    onAdd: (name: string, packageVersion: string, displayName: string) => Promise<string | null>;
}) {
    const [name, setName] = useState("");
    const [lookup, setLookup] = useState<PluginRegistryLookup | null>(null);
    const [selectedVersion, setSelectedVersion] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [looking, setLooking] = useState(false);
    /** Identifies the latest lookup, so a slower earlier response can't replace what it found. */
    const lookupToken = useRef(0);
    /** Identifies each time the dialog is opened, so an add that finishes after it was closed can't show its result. */
    const openToken = useRef(0);

    /** Forgets any lookup still in flight. */
    function invalidateLookup() {
        lookupToken.current++;
        setLooking(false);
    }

    useEffect(() => {
        if (!open) {
            openToken.current++;
            invalidateLookup();
            setName("");
            setLookup(null);
            setSelectedVersion("");
            setError(null);
            setBusy(false);
        }
    }, [open]);

    /** Looks up `packageName` at `packageVersion` (default: latest). `previous` is what a version change started
     * from - kept, with the failure in place of its manifest, when that version can't be read. */
    async function runLookup(packageName: string, packageVersion?: string, previous?: PluginRegistryLookup) {
        const token = ++lookupToken.current;
        setLooking(true);
        setError(null);
        try {
            const found = await lookupPluginPackage(packageName, packageVersion);
            if (token === lookupToken.current) {
                setLookup(found);
                setSelectedVersion(found.selected.version);
            }
        } catch (err) {
            if (token !== lookupToken.current) {
                return;
            }
            const message = errorMessage(err, "Could not look that package up.");
            if (previous && packageVersion) {
                setLookup({ ...previous, selected: { ...previous.selected, version: packageVersion, manifest: message } });
            } else {
                setLookup(null);
                setError(message);
            }
        } finally {
            if (token === lookupToken.current) {
                setLooking(false);
            }
        }
    }

    function find(e: FormEvent) {
        e.preventDefault();
        if (!name.trim()) {
            setError("Enter a package name.");
            return;
        }
        void runLookup(name.trim());
    }

    function chooseVersion(version: string) {
        setSelectedVersion(version);
        // The manifest shown, and whether it's a loadable plugin, depend on the version.
        void runLookup(lookup!.package.name, version, lookup!);
    }

    const manifest = lookup?.selected.manifest;

    async function add() {
        const token: number = openToken.current;
        setBusy(true);
        setError(null);
        const name: string = lookup!.package.name;
        const problem = await onAdd(name, selectedVersion, typeof manifest === "object" ? manifest.displayName : name);
        if (token === openToken.current) {
            setError(problem);
            setBusy(false);
        }
    }

    return (
        <Modal open={open} onClose={onClose} title="Add plugin">
            {error && <Alert>{error}</Alert>}
            <form onSubmit={find} className="flex gap-2 items-end mb-4">
                <label className="flex flex-col gap-1.5 text-sm flex-1">
                    <span className="font-semibold">Package name</span>
                    <input
                        aria-label="Package name"
                        className={INPUT_CLASS}
                        value={name}
                        placeholder="@rapidmx/activesync-plugin"
                        onChange={(e) => {
                            setName(e.target.value);
                            invalidateLookup();
                            setLookup(null);
                        }}
                    />
                </label>
                <Button type="submit" variant="secondary" className="!w-auto" loading={looking && !lookup} disabled={busy || looking}>
                    Find
                </Button>
            </form>
            {lookup && (
                <div className="flex flex-col gap-3">
                    {typeof manifest === "string" ? (
                        <>
                            <div className="text-sm font-semibold">{lookup.package.name}</div>
                            <Alert>{manifest}</Alert>
                        </>
                    ) : (
                        <div className="text-sm">
                            <div className="font-semibold">{manifest?.displayName}</div>
                            <div className="text-xs text-text-muted">{lookup.package.name}</div>
                            {manifest?.description && <div className="text-text-muted">{manifest.description}</div>}
                        </div>
                    )}
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Version</span>
                        <select aria-label="Version" className={INPUT_CLASS} value={selectedVersion} onChange={(e) => chooseVersion(e.target.value)}>
                            {lookup.package.versions.map((version) => (
                                <option key={version} value={version}>
                                    {version}
                                    {version === lookup.package.latest ? " (latest)" : ""}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="flex gap-2 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            className="!w-auto"
                            loading={busy || looking}
                            disabled={busy || looking || typeof manifest === "string"}
                            onClick={() => void add()}
                        >
                            Add plugin
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}

function ChangeVersionModal({
    plugin,
    onClose,
    onSave,
}: {
    plugin: Plugin;
    onClose: () => void;
    /** Resolves why the version couldn't be changed, or `null`. */
    onSave: (packageVersion: string) => Promise<string | null>;
}) {
    const [versions, setVersions] = useState<string[] | null>(null);
    const [latest, setLatest] = useState<string | undefined>();
    const [selected, setSelected] = useState(plugin.packageVersion);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        lookupPluginPackage(plugin.name)
            .then((found) => {
                setVersions(found.package.versions);
                setLatest(found.package.latest);
            })
            .catch((err) => setError(errorMessage(err, "Could not load the available versions.")));
    }, [plugin.name]);

    async function save() {
        setBusy(true);
        setError(null);
        const problem = await onSave(selected);
        if (problem) {
            setError(problem);
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`${plugin.manifest.displayName} version`}>
            {error && <Alert>{error}</Alert>}
            {versions === null ? (
                !error && <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Version</span>
                        <select aria-label="Version" className={INPUT_CLASS} value={selected} onChange={(e) => setSelected(e.target.value)}>
                            {versions.map((version) => (
                                <option key={version} value={version}>
                                    {version}
                                    {version === latest ? " (latest)" : ""}
                                    {version === plugin.packageVersion ? " (installed)" : ""}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="flex gap-2 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            className="!w-auto"
                            loading={busy}
                            disabled={busy || selected === plugin.packageVersion}
                            onClick={() => void save()}
                        >
                            Save
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}

/** Lists the plugins a change also installs or enables, and makes the change once confirmed. */
function ConfirmDependenciesModal({
    change,
    displayNameOf,
    onClose,
    onDone,
}: {
    change: PendingChange;
    displayNameOf: (name: string) => string;
    onClose: () => void;
    onDone: () => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const { plan } = change;

    async function proceed() {
        setBusy(true);
        setError(null);
        try {
            await change.apply(plan);
            onDone();
        } catch (err) {
            setError(errorMessage(err, change.failure));
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`${change.displayName} requires other plugins`}>
            {error && <Alert>{error}</Alert>}
            <p className="text-sm mb-2">
                {change.displayName} {plan.plugin.version} needs these plugins, so they&apos;ll be changed too:
            </p>
            <ul className="text-sm list-disc pl-5 mb-4">
                {plan.install.map((dependency) => (
                    <li key={dependency.name}>
                        Install {dependency.manifest.displayName} {dependency.version}
                    </li>
                ))}
                {plan.enable.map((name) => (
                    <li key={name}>Enable {displayNameOf(name)}</li>
                ))}
            </ul>
            <div className="flex gap-2 justify-end">
                <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" loading={busy} disabled={busy} onClick={() => void proceed()}>
                    Continue
                </Button>
            </div>
        </Modal>
    );
}

/** Whether a required select has no value to fall back on, so the form has to pick (and save) one. */
function needsSelection(definition: PluginSettingDefinition, saved: PluginSettingValue | undefined): boolean {
    return (
        definition.type === "select" &&
        !!definition.required &&
        saved === undefined &&
        definition.default === undefined &&
        (definition.options ?? []).length > 0
    );
}

/** A setting's current form value: its saved value, else its default - or, for a required select with neither, its
 * first option. Kept as a string for text inputs. */
function initialValue(definition: PluginSettingDefinition, saved: PluginSettingValue | undefined): PluginSettingValue | "" {
    if (needsSelection(definition, saved)) {
        return definition.options![0].value;
    }
    const value = saved ?? definition.default;
    if (definition.type === "boolean") {
        return value === true;
    }
    return value === undefined ? "" : String(value);
}

function SettingsModal({ plugin, onClose, onSaved }: { plugin: Plugin; onClose: () => void; onSaved: (plugin: Plugin) => void }) {
    // Only opened from the Settings button, which is only shown for a plugin that declares settings.
    const definitions: PluginSettingDefinition[] = plugin.manifest.settings!;
    const initial = useRef(Object.fromEntries(definitions.map((d) => [d.key, initialValue(d, plugin.settings[d.key])])));
    const [values, setValues] = useState<Record<string, PluginSettingValue | "">>(initial.current);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function save(e: FormEvent) {
        e.preventDefault();
        // The server replaces the whole settings object, so every setting is sent. One left alone is sent as it's saved
        // - `null` when nothing is, so it keeps following the plugin's default rather than pinning the default shown.
        // A required select with nothing to fall back on is sent as the form picked it.
        const settings: Record<string, PluginSettingValue | null> = {};
        let changed = false;
        for (const definition of definitions) {
            const key: string = definition.key;
            const value = values[key];
            if (value === initial.current[key] && !needsSelection(definition, plugin.settings[key])) {
                settings[key] = plugin.settings[key] ?? null;
                continue;
            }
            changed = true;
            // A number input only ever reports a valid number or an empty string.
            settings[key] = value === "" ? null : definition.type === "number" ? Number(value) : value;
        }
        if (!changed) {
            onClose();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            onSaved(await updatePlugin(plugin.uid, { version: plugin.version, settings }));
        } catch (err) {
            setError(errorMessage(err, "Could not save the settings."));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`${plugin.manifest.displayName} settings`}>
            {error && <Alert>{error}</Alert>}
            <form onSubmit={save} className="flex flex-col gap-4">
                {definitions.map((definition) => (
                    <SettingField
                        key={definition.key}
                        definition={definition}
                        value={values[definition.key]}
                        onChange={(value) => setValues((prev) => ({ ...prev, [definition.key]: value }))}
                    />
                ))}
                <p className="text-xs text-text-muted">Saving restarts the servers one at a time to apply the new settings.</p>
                <div className="flex gap-2 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" className="!w-auto" loading={busy} disabled={busy}>
                        Save
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

function SettingField({
    definition,
    value,
    onChange,
}: {
    definition: PluginSettingDefinition;
    value: PluginSettingValue | "";
    onChange: (value: PluginSettingValue | "") => void;
}) {
    const help = definition.help && <span className="text-xs text-text-muted">{definition.help}</span>;
    if (definition.type === "boolean") {
        return (
            <label className="flex flex-col gap-1 text-sm">
                <span className="inline-flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
                    {definition.label}
                </span>
                {help}
            </label>
        );
    }
    return (
        <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold">{definition.label}</span>
            {definition.type === "select" ? (
                <select aria-label={definition.label} className={INPUT_CLASS} value={String(value)} onChange={(e) => onChange(e.target.value)}>
                    {!definition.required && <option value="">Default</option>}
                    {(definition.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    aria-label={definition.label}
                    className={INPUT_CLASS}
                    type={definition.type === "number" ? "number" : "text"}
                    min={definition.min}
                    max={definition.max}
                    required={definition.required}
                    value={String(value)}
                    onChange={(e) => onChange(e.target.value)}
                />
            )}
            {help}
        </label>
    );
}

function RemoveModal({ plugin, onClose, onRemoved }: { plugin: Plugin; onClose: () => void; onRemoved: () => void }) {
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function remove() {
        setBusy(true);
        setError(null);
        try {
            await removePlugin(plugin.uid);
            onRemoved();
        } catch (err) {
            setError(errorMessage(err, "Could not uninstall the plugin."));
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`Uninstall ${plugin.manifest.displayName}?`}>
            {error && <Alert>{error}</Alert>}
            <p className="text-sm mb-4">
                The servers stop running this plugin after they restart. Data it stored stays in the database, and adding
                the plugin again brings it back.
            </p>
            <div className="flex gap-2 justify-end">
                <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" loading={busy} disabled={busy} onClick={() => void remove()}>
                    Uninstall
                </Button>
            </div>
        </Modal>
    );
}
