// SPDX-License-Identifier: LGPL-2.1-or-later
declare module "composerize" {
    export default function composerize(command: string, existingCompose?: string, composeVersion?: string, indent?: number): string;
}
