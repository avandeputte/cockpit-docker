# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Unit tests for src/docker-updates.py; run with "npm test".

import importlib.util
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "docker_updates", os.path.join(os.path.dirname(__file__), "..", "..", "src", "docker-updates.py"))
updates = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(updates)


class FakeRegistry:
    """Answers like Docker Hub: anonymous token, then the manifest digest"""

    def __init__(self, digest="sha256:new", manifest_status=200):
        self.digest = digest
        self.manifest_status = manifest_status
        self.requests = []

    def __call__(self, url, method="GET", headers=None):
        headers = headers or {}
        self.requests.append((method, url, dict(headers)))
        if url.startswith("https://auth.docker.io/token"):
            return 200, {}, b'{"token": "TOKEN"}'
        if "/manifests/" in url:
            if headers.get("Authorization") != "Bearer TOKEN":
                return 401, {"WWW-Authenticate":
                             'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'}, b""
            if self.manifest_status != 200:
                return self.manifest_status, {}, b""
            return 200, {"Docker-Content-Digest": self.digest}, b""
        return 404, {}, b""


class TestImageRef(unittest.TestCase):
    def test_parse(self):
        p = updates.parse_image_ref
        self.assertEqual(p("nginx"), ("docker.io", "library/nginx", "latest", None))
        self.assertEqual(p("nginx:alpine"), ("docker.io", "library/nginx", "alpine", None))
        self.assertEqual(p("louislam/uptime-kuma:1"), ("docker.io", "louislam/uptime-kuma", "1", None))
        self.assertEqual(p("docker.io/library/redis"), ("docker.io", "library/redis", "latest", None))
        self.assertEqual(p("index.docker.io/nginx"), ("docker.io", "library/nginx", "latest", None))
        self.assertEqual(p("ghcr.io/home-assistant/home-assistant:stable"),
                         ("ghcr.io", "home-assistant/home-assistant", "stable", None))
        self.assertEqual(p("localhost:5000/app"), ("localhost:5000", "app", "latest", None))
        self.assertEqual(p("reg.example.com:5000/a/b:2@sha256:abc"), ("reg.example.com:5000", "a/b", "2", "sha256:abc"))
        self.assertIsNone(p(""))
        self.assertIsNone(p("${IMAGE}"))

    def test_base_url(self):
        self.assertEqual(updates.registry_base_url("docker.io"), "https://registry-1.docker.io")
        self.assertEqual(updates.registry_base_url("reg:5000"), "https://reg:5000")


class TestAuth(unittest.TestCase):
    def test_authenticate(self):
        scheme, params = updates.parse_authenticate(
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"')
        self.assertEqual(scheme, "bearer")
        self.assertEqual(params, {"realm": "https://ghcr.io/token", "service": "ghcr.io", "scope": "repository:a/b:pull"})
        self.assertEqual(updates.parse_authenticate('Basic realm="Registry"'), ("basic", {"realm": "Registry"}))
        self.assertEqual(updates.parse_authenticate(None), (None, {}))

    def test_registry_auth(self):
        config = {"auths": {"https://index.docker.io/v1/": {"auth": "aHViOnB3"}, "ghcr.io": {"auth": "Z2g6cHc="}}}
        self.assertEqual(updates.registry_auth(config, "docker.io"), "Basic aHViOnB3")
        self.assertEqual(updates.registry_auth(config, "ghcr.io"), "Basic Z2g6cHc=")
        self.assertIsNone(updates.registry_auth(config, "quay.io"))
        self.assertIsNone(updates.registry_auth({}, "docker.io"))
        self.assertIsNone(updates.registry_auth({"credsStore": "desktop"}, "docker.io"))


class TestRemoteDigest(unittest.TestCase):
    def test_token_flow(self):
        registry = FakeRegistry()
        ref = updates.parse_image_ref("nginx:alpine")
        self.assertEqual(updates.remote_digest(ref, None, registry), "sha256:new")
        methods = [(m, u.split("?")[0]) for m, u, _ in registry.requests]
        self.assertEqual(methods, [
            ("HEAD", "https://registry-1.docker.io/v2/library/nginx/manifests/alpine"),
            ("GET", "https://auth.docker.io/token"),
            ("HEAD", "https://registry-1.docker.io/v2/library/nginx/manifests/alpine"),
        ])
        token_url = registry.requests[1][1]
        self.assertIn("scope=repository%3Alibrary%2Fnginx%3Apull", token_url)
        self.assertIn("service=registry.docker.io", token_url)
        # manifest lists are accepted, so the digest is the one docker pull records
        self.assertIn("application/vnd.oci.image.index.v1+json", registry.requests[0][2]["Accept"])

    def test_credentials_are_used_for_the_token(self):
        registry = FakeRegistry()
        updates.remote_digest(updates.parse_image_ref("me/private"), "Basic abc", registry)
        self.assertEqual(registry.requests[1][2], {"Authorization": "Basic abc"})

    def test_errors(self):
        ref = updates.parse_image_ref("nginx")
        with self.assertRaisesRegex(updates.CheckError, "not found"):
            updates.remote_digest(ref, None, FakeRegistry(manifest_status=404))
        with self.assertRaisesRegex(updates.CheckError, "Too many requests"):
            updates.remote_digest(ref, None, FakeRegistry(manifest_status=429))
        with self.assertRaisesRegex(updates.CheckError, "requires a login"):
            updates.remote_digest(ref, None, lambda url, method, headers: (401, {}, b""))


class TestCheckImage(unittest.TestCase):
    def digest(self, value):
        def get(_ref):
            if isinstance(value, Exception):
                raise value
            return value
        return get

    def test_status(self):
        check = updates.check_image
        old = ["nginx@sha256:old"]
        self.assertEqual(check("nginx:alpine", "sha256:id", old, self.digest("sha256:old")), ("up-to-date", None))
        self.assertEqual(check("nginx:alpine", "sha256:id", old, self.digest("sha256:new")), ("update-available", None))
        # containerd image store: the image id is the index digest
        self.assertEqual(check("nginx", "sha256:new", ["nginx@sha256:new"], self.digest("sha256:new")), ("up-to-date", None))
        self.assertEqual(check("myapp", "sha256:id", [], self.digest("sha256:new")), ("local", None))
        self.assertEqual(check("nginx@sha256:abc", "sha256:id", old, self.digest("sha256:new")), ("pinned", None))
        self.assertEqual(check("${X}", "sha256:id", old, self.digest("sha256:new")), ("error", "Invalid image name"))
        self.assertEqual(check("nginx", "sha256:id", old, self.digest(updates.CheckError("offline"))), ("error", "offline"))


if __name__ == "__main__":
    unittest.main()
