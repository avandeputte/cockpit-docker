#!/usr/bin/python3
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Image update checks and automatic updates for Docker compose stacks.
#
# The Cockpit page runs this with "python3 -c" (Cockpit's bridge needs Python,
# so it is always there), and the cockpit-dockerstacks-update.timer that the page
# installs runs it with "auto".
#
# An image has an update when the registry's digest for its tag differs from
# the digests of the image the container was created from. The registry is
# asked with a HEAD request, which does not count against Docker Hub's pull
# limit; nothing is pulled.

import argparse
import base64
import concurrent.futures
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

SETTINGS_FILE = "/etc/cockpit/docker.json"
DEFAULT_STACKS_DIR = "/opt/stacks"
DOCKER_HUB = "docker.io"
COMPOSE_FILES = ["compose.yaml", "docker-compose.yaml", "docker-compose.yml", "compose.yml"]
MANIFEST_TYPES = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
TIMEOUT = 20


class CheckError(Exception):
    pass


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# Image references

def parse_image_ref(image):
    """Normalize an image reference like docker does: "nginx" is docker.io/library/nginx:latest.

    Returns (registry, repository, tag, digest) or None.
    """
    name = image.strip()
    if not name or any(c.isspace() for c in name) or "$" in name:
        return None

    digest = None
    if "@" in name:
        name, digest = name.split("@", 1)

    tag = "latest"
    colon = name.rfind(":")
    if colon > name.rfind("/"):
        name, tag = name[:colon], name[colon + 1:]

    registry = DOCKER_HUB
    if "/" in name:
        first, rest = name.split("/", 1)
        if "." in first or ":" in first or first == "localhost":
            registry, name = first, rest
    if registry in ("index.docker.io", "registry-1.docker.io"):
        registry = DOCKER_HUB
    if registry == DOCKER_HUB and "/" not in name:
        name = "library/" + name

    if not name or not tag:
        return None
    return registry, name, tag, digest


def registry_base_url(registry):
    if registry == DOCKER_HUB:
        return "https://registry-1.docker.io"
    return "https://" + registry


def parse_authenticate(header):
    """Parse 'Bearer realm="...",service="..."' into ("bearer", {realm: ..., service: ...})"""
    if not header:
        return None, {}
    scheme, _, rest = header.strip().partition(" ")
    params = {}
    while rest:
        rest = rest.lstrip(" ,")
        key, eq, rest = rest.partition("=")
        if not eq:
            break
        rest = rest.lstrip()
        if rest.startswith('"'):
            value, _, rest = rest[1:].partition('"')
        else:
            value, _, rest = rest.partition(",")
        params[key.strip().lower()] = value.strip()
    return scheme.lower(), params


def registry_auth(config, registry):
    """The "Basic ..." credentials for a registry from docker's config.json, if any"""
    auths = config.get("auths") if isinstance(config, dict) else None
    if not isinstance(auths, dict):
        return None
    if registry == DOCKER_HUB:
        keys = {"https://index.docker.io/v1", "index.docker.io", "docker.io", "registry-1.docker.io"}
    else:
        keys = {registry, "https://" + registry, "http://" + registry}
    for key, value in auths.items():
        if key.rstrip("/") in keys and isinstance(value, dict) and value.get("auth"):
            return "Basic " + value["auth"]
    return None


def load_docker_config():
    path = os.path.join(os.environ.get("DOCKER_CONFIG") or os.path.expanduser("~/.docker"), "config.json")
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# HTTP

def http_request(url, method="GET", headers=None):
    """Returns (status, headers, body); HTTP errors are returned, not raised"""
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.headers, resp.read() if method != "HEAD" else b""
    except urllib.error.HTTPError as e:
        return e.code, e.headers, b""
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise CheckError(f"Cannot reach the registry: {reason}") from e


def get_token(params, repository, basic_auth, request=http_request):
    realm = params.get("realm")
    if not realm:
        raise CheckError("The registry did not say where to log in")
    query = {"scope": f"repository:{repository}:pull"}
    if params.get("service"):
        query["service"] = params["service"]
    url = realm + ("&" if "?" in realm else "?") + urllib.parse.urlencode(query)
    status, _, body = request(url, "GET", {"Authorization": basic_auth} if basic_auth else {})
    if status != 200:
        raise CheckError(f"Logging in to the registry failed (HTTP {status})")
    try:
        data = json.loads(body)
    except ValueError as e:
        raise CheckError("The registry returned an invalid token") from e
    token = data.get("token") or data.get("access_token")
    if not token:
        raise CheckError("The registry returned no token")
    return token


def remote_digest(ref, basic_auth=None, request=http_request):
    registry, repository, tag, _ = ref
    url = f"{registry_base_url(registry)}/v2/{repository}/manifests/{tag}"
    headers = {"Accept": MANIFEST_TYPES}

    status, resp_headers, _ = request(url, "HEAD", headers)
    if status == 401:
        scheme, params = parse_authenticate(resp_headers.get("WWW-Authenticate"))
        if scheme == "bearer":
            headers["Authorization"] = "Bearer " + get_token(params, repository, basic_auth, request)
        elif scheme == "basic" and basic_auth:
            headers["Authorization"] = basic_auth
        else:
            raise CheckError("The registry requires a login")
        status, resp_headers, _ = request(url, "HEAD", headers)

    if status in (401, 403):
        raise CheckError("The registry requires a login")
    if status == 404:
        raise CheckError("The image was not found in the registry")
    if status == 429:
        raise CheckError("Too many requests to the registry, try again later")
    if status != 200:
        raise CheckError(f"The registry returned HTTP {status}")
    digest = resp_headers.get("Docker-Content-Digest")
    if not digest:
        raise CheckError("The registry did not return a digest")
    return digest


def check_image(image, image_id, repo_digests, get_digest):
    """Returns (status, error); status is update-available, up-to-date, local, pinned or error"""
    ref = parse_image_ref(image)
    if ref is None:
        return "error", "Invalid image name"
    if ref[3]:
        return "pinned", None
    # Built locally or loaded from a file: there is nothing to compare with
    if not repo_digests:
        return "local", None
    try:
        digest = get_digest(ref)
    except CheckError as e:
        return "error", str(e)
    if image_id == digest or any(d.endswith("@" + digest) for d in repo_digests):
        return "up-to-date", None
    return "update-available", None


# Docker

def docker_json(args):
    out = subprocess.run(["docker", *args], check=True, capture_output=True, text=True).stdout
    return json.loads(out) if out.strip() else []


def service_images(stacks=None):
    """One entry per service and image of every compose container"""
    ids = subprocess.run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project"],
                         check=True, capture_output=True, text=True).stdout.split()
    if not ids:
        return []

    result = {}
    for c in docker_json(["inspect", *ids]):
        labels = (c.get("Config") or {}).get("Labels") or {}
        stack = labels.get("com.docker.compose.project")
        service = labels.get("com.docker.compose.service")
        image = (c.get("Config") or {}).get("Image")
        image_id = c.get("Image")
        if not stack or not service or not image or not image_id:
            continue
        if stacks and stack not in stacks:
            continue
        result[(stack, service, image_id)] = {"stack": stack, "service": service, "image": image, "id": image_id}

    digests = {}
    for image_id in {s["id"] for s in result.values()}:
        try:
            info = docker_json(["image", "inspect", image_id])
            digests[image_id] = (info[0].get("RepoDigests") or []) if info else []
        except (subprocess.CalledProcessError, ValueError):
            digests[image_id] = []  # image was removed
    for s in result.values():
        s["repoDigests"] = digests[s["id"]]

    return sorted(result.values(), key=lambda s: (s["stack"], s["service"]))


def check(stacks=None):
    services = service_images(stacks)
    config = load_docker_config()

    # Ask the registry about each image once, a few at a time
    def lookup(ref):
        try:
            return remote_digest(ref, registry_auth(config, ref[0]))
        except CheckError as e:
            return e

    refs = {}
    for s in services:
        ref = parse_image_ref(s["image"])
        if ref and not ref[3] and s["repoDigests"]:
            refs.setdefault(ref[:3], ref)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        digests = dict(zip(refs.keys(), pool.map(lookup, refs.values())))

    def get_digest(ref):
        value = digests[ref[:3]]
        if isinstance(value, CheckError):
            raise value
        return value

    results = []
    for s in services:
        status, error = check_image(s["image"], s["id"], s["repoDigests"], get_digest)
        results.append({"stack": s["stack"], "service": s["service"], "image": s["image"], "status": status, "error": error})
    return results


# Updating

def load_settings():
    try:
        with open(SETTINGS_FILE) as f:
            settings = json.load(f)
    except (OSError, ValueError):
        settings = {}
    return settings if isinstance(settings, dict) else {}


def compose_file(stack_dir):
    for name in COMPOSE_FILES:
        if os.path.isfile(os.path.join(stack_dir, name)):
            return name
    return None


def compose(stack_dir, *args):
    """docker compose in the stack directory, with global.env like the Cockpit page"""
    env_files = []
    if os.path.isfile(os.path.join(stack_dir, "..", "global.env")):
        env_files = ["--env-file", "../global.env"]
        if os.path.isfile(os.path.join(stack_dir, ".env")):
            env_files += ["--env-file", "./.env"]
    return subprocess.run(["docker", "compose", *env_files, *args], cwd=stack_dir).returncode


def running_stacks():
    projects = docker_json(["compose", "ls", "--format", "json"])
    return {p["Name"] for p in projects if "running" in (p.get("Status") or "")}


def update(stacks=None, exclude=()):
    """Pull and restart running stacks in the stacks directory that have an update"""
    settings = load_settings()
    stacks_dir = settings.get("stacksDir") or DEFAULT_STACKS_DIR
    results = check(stacks)
    pending = sorted({r["stack"] for r in results if r["status"] == "update-available"})
    running = running_stacks()
    failed = 0

    for r in results:
        if r["status"] == "error":
            log(f"{r['stack']}/{r['service']}: cannot check {r['image']}: {r['error']}")

    for stack in pending:
        stack_dir = os.path.join(stacks_dir, stack)
        if stack in exclude:
            log(f"{stack}: update available, automatic updates are turned off for this stack")
            continue
        if stack not in running:
            log(f"{stack}: update available, not updating because the stack is not running")
            continue
        if not compose_file(stack_dir):
            log(f"{stack}: update available, not updating because it is not in {stacks_dir}")
            continue
        log(f"{stack}: updating")
        if compose(stack_dir, "pull") != 0 or compose(stack_dir, "up", "-d", "--remove-orphans") != 0:
            log(f"{stack}: update failed")
            failed += 1
        else:
            log(f"{stack}: updated")

    if not pending:
        log("All stacks are up to date")
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="cockpit-dockerstacks-update")
    sub = parser.add_subparsers(dest="command", required=True)
    p_check = sub.add_parser("check", help="check images for updates, print JSON")
    p_check.add_argument("--stack", action="append", help="only this stack (repeatable)")
    p_update = sub.add_parser("update", help="update running stacks that have an update")
    p_update.add_argument("--stack", action="append", help="only this stack (repeatable)")
    sub.add_parser("auto", help="automatic update, as configured in " + SETTINGS_FILE)
    args = parser.parse_args(argv)

    try:
        if args.command == "check":
            json.dump(check(args.stack), sys.stdout)
            print()
            return 0
        if args.command == "update":
            return update(args.stack)
        settings = load_settings()
        if settings.get("autoUpdate", "off") == "off":
            log("Automatic updates are turned off")
            return 0
        exclude = settings.get("autoUpdateExclude") or []
        return update(exclude=set(exclude) if isinstance(exclude, list) else set())
    except subprocess.CalledProcessError as e:
        log(f"{' '.join(e.cmd)} failed: {(e.stderr or '').strip()}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
