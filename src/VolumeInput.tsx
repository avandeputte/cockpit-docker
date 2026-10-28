/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Volumes of a service: host folder (picked with FolderBrowser) or volume name,
 * container path and read-only, kept in compose's short "SOURCE:TARGET:MODE" form.
 */

import React from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { InputGroup, InputGroupItem } from "@patternfly/react-core/dist/esm/components/InputGroup/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { Stack } from "@patternfly/react-core/dist/esm/layouts/Stack/index.js";
import { FolderOpenIcon, MinusIcon, PlusIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";

import type { Host } from './docker';
import { FolderBrowser } from './FolderBrowser';
import {
    bindSourceFor, formatVolume, isBindSource, isReadOnlyMode, parseVolume, resolveHostPath, setReadOnlyMode,
} from './util';
import type { VolumeSpec } from './util';

const _ = cockpit.gettext;

export const VolumeInput = ({ id, host, stackDir, values, onChange }: {
    id: string,
    host: Host,
    /** Directory of the stack; relative bind mounts are relative to it */
    stackDir: string,
    /** Entries of the service's "volumes"; long-syntax entries (objects) are kept as they are */
    values: unknown[],
    onChange: (values: unknown[]) => void,
}) => {
    const Dialogs = useDialogs();

    const update = (idx: number, patch: Partial<VolumeSpec>) =>
        onChange(values.map((v, i) => i === idx ? formatVolume({ ...parseVolume(String(v)), ...patch }) : v));
    const remove = (idx: number) => onChange(values.filter((_v, i) => i !== idx));

    const browse = (idx: number, source: string) => {
        const start = source && isBindSource(source) ? resolveHostPath(source, stackDir) : stackDir;
        Dialogs.show(<FolderBrowser host={host} start={start}
                                    onSelect={path => update(idx, { source: bindSourceFor(path, stackDir) })} />);
    };

    return (
        <Stack id={id} className="volume-input" hasGutter>
            {values.map((value, idx) => {
                const removeButton = (
                    <Button variant="plain" aria-label={_("Remove volume")} icon={<MinusIcon />}
                            className="volume-remove" onClick={() => remove(idx)} />
                );
                if (typeof value === "object") {
                    return (
                        <Flex key={idx} spaceItems={{ default: "spaceItemsSm" }} flexWrap={{ default: "nowrap" }}
                              alignItems={{ default: "alignItemsCenter" }} className="volume-input-row">
                            <FlexItem grow={{ default: "grow" }} className="ct-monospace pf-v6-u-text-color-subtle">
                                {JSON.stringify(value)} {_("(edit in the YAML)")}
                            </FlexItem>
                            {removeButton}
                        </Flex>
                    );
                }
                const vol = parseVolume(String(value));
                return (
                    <Stack key={idx} className="volume-input-row" data-index={idx}>
                        <Flex spaceItems={{ default: "spaceItemsSm" }} flexWrap={{ default: "nowrap" }}>
                            <FlexItem grow={{ default: "grow" }} className="volume-source">
                                <InputGroup>
                                    <InputGroupItem isFill>
                                        <TextInput id={`${id}-${idx}-source`} value={vol.source}
                                                   placeholder={_("Host folder or volume name")}
                                                   aria-label={cockpit.format(_("Host folder or volume of volume $0"), idx + 1)}
                                                   onChange={(_ev, v) => update(idx, { source: v })} />
                                    </InputGroupItem>
                                    <InputGroupItem>
                                        <Button variant="control" id={`${id}-${idx}-browse`} className="volume-browse"
                                                aria-label={_("Choose a folder")} icon={<FolderOpenIcon />}
                                                onClick={() => browse(idx, vol.source)} />
                                    </InputGroupItem>
                                </InputGroup>
                            </FlexItem>
                            {removeButton}
                        </Flex>
                        <Flex spaceItems={{ default: "spaceItemsMd" }} flexWrap={{ default: "nowrap" }}
                              alignItems={{ default: "alignItemsCenter" }} className="volume-target-row">
                            <FlexItem grow={{ default: "grow" }} className="volume-target">
                                <TextInput id={`${id}-${idx}-target`} value={vol.target} placeholder={_("Path in container")}
                                           aria-label={cockpit.format(_("Container path of volume $0"), idx + 1)}
                                           onChange={(_ev, v) => update(idx, { target: v })} />
                            </FlexItem>
                            <Checkbox id={`${id}-${idx}-ro`} label={_("Read-only")} isChecked={isReadOnlyMode(vol.mode)}
                                      isDisabled={vol.source === ""}
                                      onChange={(_ev, v) => update(idx, { mode: setReadOnlyMode(vol.mode, v) })} />
                        </Flex>
                    </Stack>
                );
            })}
            <div>
                <Button variant="link" isInline icon={<PlusIcon />} className="volume-add"
                        onClick={() => onChange([...values, ""])}>
                    {_("Add volume")}
                </Button>
            </div>
        </Stack>
    );
};
