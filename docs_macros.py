from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def read_project_metadata(root: Path | None = None) -> dict[str, str]:
    source_path = Path(__file__)
    project_root = root or source_path.resolve().parent
    package_path = project_root / "package.json"
    package = _read_json(package_path)
    version = package["version"]
    docker_version = version.replace("+", "-")

    return {
        "version": version,
        "version_tag": f"v{version}",
        "docker_version": docker_version,
        "npm_pin": f"cloakbrowser-mcp@{version}",
        "docker_image": f"swimmwatch/cloakbrowser-mcp:{docker_version}",
        "ghcr_image": f"ghcr.io/swimmwatch/cloakbrowser-mcp:{docker_version}",
        **_read_compatibility_metadata(project_root, version),
    }


def _read_compatibility_metadata(root: Path, project_version: str) -> dict[str, str]:
    compatibility_path = root / "docs" / "data" / "version-compatibility.json"
    compatibility = _read_json(compatibility_path)
    matching_rows = (item for item in compatibility if item["version"] == project_version)
    row = next(matching_rows, None)
    if row is None:
        message = (
            "docs/data/version-compatibility.json must contain an entry for "
            f"package version {project_version!r}"
        )
        raise ValueError(message)
    playwright_mcp_dependency = row["playwrightMcp"]
    playwright_mcp_version = _extract_version(playwright_mcp_dependency)
    cloakbrowser_dependency = row["cloakbrowser"]
    cloakbrowser_version = _extract_version(cloakbrowser_dependency)

    return {
        "playwright_mcp_dependency": playwright_mcp_dependency,
        "playwright_mcp_version": playwright_mcp_version,
        "playwright_mcp_package_tag": f"@playwright/mcp@{playwright_mcp_version}",
        "playwright_mcp_release_tag": f"v{playwright_mcp_version}",
        "playwright_mcp_docker_base": row["playwrightMcpDockerBase"],
        "cloakbrowser_dependency": cloakbrowser_dependency,
        "cloakbrowser_version": cloakbrowser_version,
        "cloakbrowser_package_tag": f"cloakbrowser@{cloakbrowser_version}",
        "cloakbrowser_release_tag": f"v{cloakbrowser_version}",
    }


def _extract_version(value: str) -> str:
    match = re.search(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", value)
    if match is None:
        message = f"Cannot extract a version from {value!r}"
        raise ValueError(message)

    return match.group(0)


def _read_json(path: Path) -> Any:
    content = path.read_text(encoding="utf-8")
    return json.loads(content)


def define_env(env: Any) -> None:
    env.variables["project"] = read_project_metadata()
