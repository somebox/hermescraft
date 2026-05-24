#!/usr/bin/env python3
"""
GrabCraft Blueprint Downloader
==============================
Downloads Minecraft blueprints from grabcraft.com and converts them
to a clean, parseable JSON format suitable for automation.

Usage:
    python grabcraft_downloader.py <grabcraft_url> [output.json]
    python grabcraft_downloader.py https://www.grabcraft.com/minecraft/dystopian-village-hut-3/other-193 hut.json

Output JSON structure:
{
  "metadata": { name, author, block_count, width, height, depth, url, ... },
  "materials": [ {name, count}, ... ],
  "layers": [ {level, blocks: [{x, y, z, name, mat_id, hex, rgb, texture}], ...} ],
  "blocks_3d": { "x,y,z": {name, mat_id, ...} }   # flat lookup by "x,y,z" key
}
"""

import sys
import json
import re
import argparse
from urllib.request import urlopen, Request
from urllib.error import HTTPError
from html.parser import HTMLParser


class GrabCraftDownloader:
    BASE = "https://www.grabcraft.com"
    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    def __init__(self, url: str):
        self.url = url
        self.html = None
        self.metadata = {}
        self.materials = []
        self.layers = []
        self.blocks_3d = {}

    def _fetch(self, url: str) -> str:
        req = Request(url, headers=self.HEADERS)
        with urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")

    def _extract_script_urls(self) -> dict:
        """Find myRenderObject and LayerMap script URLs from the HTML."""
        urls = {}
        for match in re.finditer(
            r'<script[^>]+src="(https?://[^"]+/js/RenderObject/myRenderObject_\d+\.js)"',
            self.html,
        ):
            urls["render_object"] = match.group(1)
        for match in re.finditer(
            r'<script[^>]+src="(https?://[^"]+/js/LayerMap/LayerMap_\d+\.js)"',
            self.html,
        ):
            urls["layer_map"] = match.group(1)
        return urls

    def _extract_metadata(self):
        """Scrape metadata from the HTML page."""
        # Title / Name
        title_match = re.search(r'<h1[^>]*>(.*?)</h1>', self.html, re.IGNORECASE | re.DOTALL)
        name = re.sub(r"<[^>]+>", "", title_match.group(1)).strip() if title_match else ""

        # Author, block count, views from the <h3> parameters section
        author = block_count = views = ""
        author_match = re.search(r'Author:&nbsp;([^<\s]+)', self.html)
        if author_match:
            author = author_match.group(1).strip()
        count_match = re.search(r'Block count:&nbsp;(\d+)', self.html)
        if count_match:
            block_count = int(count_match.group(1))
        views_match = re.search(r'Views:&nbsp;(\d+)', self.html)
        if views_match:
            views = int(views_match.group(1))

        # Dimensions from table cells with specific class names
        dims = {}
        dim_map = {
            "dimension-x": "width",
            "dimension-y": "height",
            "dimension-z": "depth",
            "skill_level": "skill_level",
            "block_count": "block_count",
            "date_added": "date_added",
        }
        for cls, key in dim_map.items():
            m = re.search(rf'<td[^>]*class="[^"]*{cls}[^"]*"[^>]*>(.*?)</td>', self.html, re.IGNORECASE | re.DOTALL)
            if m:
                val = re.sub(r"<[^>]+>", "", m.group(1)).strip()
                dims[key] = self._try_int(val)

        # Tags
        tags_match = re.search(r'<td[^>]*class="[^"]*tags[^"]*"[^>]*>(.*?)</td>', self.html, re.IGNORECASE | re.DOTALL)
        tags = []
        if tags_match:
            tag_text = re.sub(r"<[^>]+>", "", tags_match.group(1))
            tags = [t.strip() for t in tag_text.split(",") if t.strip()]

        # Description - grab from the description div
        desc_match = re.search(
            r'<div[^>]*class="[^"]*description[^"]*"[^>]*itemprop="description"[^>]*>(.*?)</div>',
            self.html, re.IGNORECASE | re.DOTALL,
        )
        if not desc_match:
            desc_match = re.search(
                r'Views:&nbsp;\d+\s*</h3>\s*<p[^>]*>(.*?)</p>',
                self.html, re.IGNORECASE | re.DOTALL,
            )
        if not desc_match:
            desc_match = re.search(
                r'<p[^>]*class="[^"]*description[^"]*"[^>]*>(.*?)</p>',
                self.html, re.IGNORECASE | re.DOTALL,
            )
        description = re.sub(r"<[^>]+>", "", desc_match.group(1)).strip() if desc_match else ""

        # Blueprint image base URL from JS
        base_url_match = re.search(r'var\s+base_url\s*=\s*"([^"]+)"', self.html)
        image_base = base_url_match.group(1) if base_url_match else ""

        # Large preview image
        preview_match = re.search(
            r'<a\s+href="(https://www\.grabcraft\.com/files/products/large/[^"]+\.png)"',
            self.html,
        )
        preview_image = preview_match.group(1) if preview_match else ""

        self.metadata = {
            "name": name,
            "author": author,
            "block_count": block_count or dims.get("block_count", 0),
            "views": views,
            "width": dims.get("width"),
            "height": dims.get("height"),
            "depth": dims.get("depth"),
            "skill_level": dims.get("skill_level"),
            "tags": tags,
            "description": description,
            "url": self.url,
            "blueprint_image_base": image_base,
            "preview_image": preview_image,
        }

    def _extract_materials(self):
        """Extract material list with counts from the page."""
        # Find the Highcharts data array (most reliable for exact counts)
        chart_match = re.search(
            r'data:\s*(\[.*?\])\s*}\]',
            self.html, re.DOTALL,
        )
        if chart_match:
            try:
                data = json.loads(chart_match.group(1))
                for item in data:
                    name = item.get("name", "")
                    if name and name != "Other materials":
                        self.materials.append({
                            "name": name,
                            "count": item.get("y", 0),
                        })
                return
            except json.JSONDecodeError:
                pass

        # Fallback: parse the materials table rows
        materials = []
        seen = set()
        for row in re.finditer(
            r'<td[^>]*>([A-Za-z][^<]+)</td>\s*<td[^>]*>([A-Za-z][^<]+)</td>\s*<td[^>]*>(\d+)</td>',
            self.html,
        ):
            name = row.group(1).strip()
            count = int(row.group(3))
            if name not in seen and "Other materials" not in name:
                seen.add(name)
                materials.append({"name": name, "count": count})
        self.materials = materials

    @staticmethod
    def _try_int(val):
        try:
            return int(val)
        except (ValueError, TypeError):
            return val

    def _parse_render_object(self, js_url: str):
        """Fetch and parse the myRenderObject JS file into block data."""
        js = self._fetch(js_url)
        # Strip the variable assignment wrapper
        match = re.search(r'var\s+myRenderObject\s*=\s*(\{.*\});?\s*$', js, re.DOTALL)
        if not match:
            raise ValueError("Could not find myRenderObject data in JS file")

        data = json.loads(match.group(1))

        # data structure: {y_layer: {x: {z: block_info}}}
        for y_str, x_dict in data.items():
            y = int(y_str)
            level_blocks = []
            for x_str, z_dict in x_dict.items():
                x = int(x_str)
                for z_str, block in z_dict.items():
                    z = int(z_str)
                    block_entry = {
                        "x": x,
                        "y": y,
                        "z": z,
                        "name": block.get("name", ""),
                        "mat_id": block.get("mat_id", ""),
                        "hex": block.get("hex", ""),
                        "rgb": block.get("rgb", []),
                        "texture": block.get("texture", ""),
                        "transparent": block.get("transparent", False),
                    }
                    level_blocks.append(block_entry)
                    self.blocks_3d[f"{x},{y},{z}"] = block_entry
            self.layers.append({
                "level": y,
                "blocks": level_blocks,
            })

        # Sort layers and blocks for consistent output
        self.layers.sort(key=lambda l: l["level"])
        for layer in self.layers:
            layer["blocks"].sort(key=lambda b: (b["x"], b["z"]))

    def _parse_layer_map(self, js_url: str):
        """Optionally fetch layerMap for image-coordinate overlay data."""
        js = self._fetch(js_url)
        match = re.search(r'var\s+layerMap\s*=\s*(\{.*\});?\s*$', js, re.DOTALL)
        if match:
            return json.loads(match.group(1))
        return {}

    def download(self) -> dict:
        """Main entry point: fetch and parse the full blueprint."""
        print(f"Fetching page: {self.url}")
        self.html = self._fetch(self.url)

        print("Extracting metadata...")
        self._extract_metadata()
        self._extract_materials()

        scripts = self._extract_script_urls()
        if "render_object" not in scripts:
            raise ValueError("Could not find myRenderObject script URL in page")

        print(f"Downloading 3D render object from: {scripts['render_object']}")
        self._parse_render_object(scripts["render_object"])

        layer_map = {}
        if "layer_map" in scripts:
            print(f"Downloading layer map from: {scripts['layer_map']}")
            layer_map = self._parse_layer_map(scripts["layer_map"])

        result = {
            "metadata": self.metadata,
            "materials": self.materials,
            "layers": self.layers,
            "blocks_3d": self.blocks_3d,
        }

        if layer_map:
            result["layer_image_map"] = layer_map

        print(f"Done! Parsed {len(self.blocks_3d)} blocks across {len(self.layers)} layer(s).")
        return result


def main():
    parser = argparse.ArgumentParser(
        description="Download GrabCraft Minecraft blueprints as JSON"
    )
    parser.add_argument("url", help="GrabCraft blueprint URL (e.g., https://www.grabcraft.com/minecraft/...)")
    parser.add_argument("output", nargs="?", help="Output JSON file (default: stdout)")
    parser.add_argument(
        "--pretty", action="store_true", default=True,
        help="Pretty-print JSON output (default: True)",
    )
    parser.add_argument(
        "--compact", action="store_true",
        help="Output compact JSON (single line)",
    )
    args = parser.parse_args()

    indent = 2 if (args.pretty and not args.compact) else None

    try:
        downloader = GrabCraftDownloader(args.url)
        blueprint = downloader.download()

        json_output = json.dumps(blueprint, indent=indent, ensure_ascii=False)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(json_output + "\n")
            print(f"Saved to: {args.output}")
        else:
            print(json_output)

    except HTTPError as e:
        print(f"HTTP Error {e.code}: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
