/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dialog to pick a directory on a host, for the host side of bind mounts.
 * Uses the bridge's fslist1 channel, so it also works on other hosts.
 */

import React, { useEffect, useState } from 'react';
import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { DataList, DataListCell, DataListItem, DataListItemCells, DataListItemRow } from "@patternfly/react-core/dist/esm/components/DataList/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { FolderIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import type { Host } from './docker';
import { parentDirectory } from './util';

const _ = cockpit.gettext;

interface Listing {
    path: string;
    dirs: string[];
}

/** List the subdirectories of path; rejects when it can't be read */
function listDirectories(host: Host, path: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const options: cockpit.ChannelOpenOptions & { binary?: false, path: string, watch: boolean } = {
            payload: "fslist1",
            path,
            superuser: "try",
            watch: false,
        };
        if (host)
            options.host = host;
        const channel = cockpit.channel(options);
        const dirs: string[] = [];
        channel.addEventListener("message", (_ev, data) => {
            const item = JSON.parse(data as string);
            if (item?.event === "present" && item.type === "directory" && item.path)
                dirs.push(item.path);
        });
        channel.addEventListener("close", (_ev, options) => {
            if (options.problem)
                reject(new Error((options.message as string | undefined) || cockpit.message(options.problem as string)));
            resolve(dirs.sort((a, b) => a.localeCompare(b)));
        });
    });
}

export const FolderBrowser = ({ host, start, onSelect }: {
    host: Host,
    /** Directory to show first; when it does not exist, its closest existing parent */
    start: string,
    onSelect: (path: string) => void,
}) => {
    const Dialogs = useDialogs();
    const [listing, setListing] = useState<Listing | null>(null);
    const [error, setError] = useState<string | null>(null);

    const open = (path: string, fallback: boolean) => {
        setError(null);
        listDirectories(host, path)
                .then(dirs => setListing({ path, dirs }))
                .catch(ex => {
                    if (fallback && path !== "/")
                        open(parentDirectory(path), true);
                    else
                        setError(ex.message);
                });
    };

    useEffect(() => {
        open(start || "/", true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const path = listing?.path ?? "/";
    const parts = path.split("/").filter(p => p !== "");
    const join = (dir: string, name: string) => (dir.endsWith("/") ? dir : dir + "/") + name;

    return (
        <Modal id="folder-browser" position="top" variant="small" isOpen onClose={() => Dialogs.close()}>
            <ModalHeader title={_("Choose a folder")} />
            <ModalBody>
                {error && <ModalError dialogError={_("Cannot open folder")} dialogErrorDetail={error} />}
                {!listing
                    ? <EmptyStatePanel loading />
                    : (
                        <Stack hasGutter>
                            <Breadcrumb id="folder-browser-path">
                                <BreadcrumbItem to="#" onClick={ev => { ev.preventDefault(); open("/", false) }}>/</BreadcrumbItem>
                                {parts.map((p, idx) => (
                                    <BreadcrumbItem key={idx} isActive={idx === parts.length - 1} to="#"
                                                    onClick={ev => { ev.preventDefault(); open("/" + parts.slice(0, idx + 1).join("/"), false) }}>
                                        {p}
                                    </BreadcrumbItem>
                                ))}
                            </Breadcrumb>
                            {listing.dirs.length === 0
                                ? <div className="pf-v6-u-text-color-subtle">{_("No subfolders")}</div>
                                : (
                                    <DataList aria-label={_("Folders")} isCompact className="folder-browser-list"
                                              onSelectDataListItem={(_ev, id) => open(join(path, id), false)}>
                                        {listing.dirs.map(d => (
                                            <DataListItem key={d} id={d} className="folder-browser-item">
                                                <DataListItemRow>
                                                    <DataListItemCells dataListCells={[
                                                        <DataListCell key="name">
                                                            <FolderIcon className="folder-browser-icon" />{d}
                                                        </DataListCell>
                                                    ]} />
                                                </DataListItemRow>
                                            </DataListItem>
                                        ))}
                                    </DataList>
                                )}
                        </Stack>
                    )}
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" id="folder-browser-select" isDisabled={!listing}
                        onClick={() => { onSelect(path); Dialogs.close() }}>
                    {cockpit.format(_("Use $0"), path)}
                </Button>
                <Button variant="link" onClick={() => Dialogs.close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};
