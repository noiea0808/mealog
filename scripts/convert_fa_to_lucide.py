# -*- coding: utf-8 -*-
"""Bulk-convert Font Awesome <i> tags to Lucide data-lucide icons."""
from pathlib import Path
import re

ROOT = Path(r"e:/200. Dev/mealog")

MAP = {
    "chart-pie": "pie-chart",
    "images": "images",
    "image": "image",
    "book-open": "book-open",
    "comments": "message-circle",
    "comment": "message-circle",
    "comment-dots": "message-circle-more",
    "user": "user",
    "users": "users",
    "user-group": "users",
    "user-plus": "user-plus",
    "user-minus": "user-minus",
    "user-check": "user-check",
    "user-xmark": "user-x",
    "user-pen": "user-pen",
    "user-gear": "user-cog",
    "magnifying-glass": "search",
    "magnifying-glass-plus": "zoom-in",
    "magnifying-glass-minus": "zoom-out",
    "bell": "bell",
    "bell-slash": "bell-off",
    "heart": "heart",
    "bookmark": "bookmark",
    "pen": "pen",
    "pencil": "pen",
    "pen-to-square": "square-pen",
    "plus": "plus",
    "minus": "minus",
    "xmark": "x",
    "chevron-left": "chevron-left",
    "chevron-right": "chevron-right",
    "chevron-up": "chevron-up",
    "chevron-down": "chevron-down",
    "share": "share",
    "share-nodes": "share-2",
    "wand-magic-sparkles": "sparkles",
    "camera": "camera",
    "star": "star",
    "calendar": "calendar",
    "fire": "flame",
    "arrow-up": "arrow-up",
    "arrow-down": "arrow-down",
    "arrow-left": "arrow-left",
    "arrow-right": "arrow-right",
    "arrow-up-from-bracket": "upload",
    "arrow-up-right-from-square": "external-link",
    "location-dot": "map-pin",
    "utensils": "utensils",
    "rotate-left": "rotate-ccw",
    "rotate-right": "rotate-cw",
    "arrows-rotate": "refresh-cw",
    "reply": "reply",
    "envelope": "mail",
    "folder": "folder",
    "folder-open": "folder-open",
    "keyboard": "keyboard",
    "copy": "copy",
    "triangle-exclamation": "triangle-alert",
    "exclamation-triangle": "triangle-alert",
    "cloud-arrow-up": "cloud-upload",
    "cloud-arrow-down": "cloud-download",
    "link": "link",
    "link-slash": "unlink",
    "spinner": "loader-circle",
    "bold": "bold",
    "strikethrough": "strikethrough",
    "underline": "underline",
    "trash": "trash-2",
    "trash-can": "trash-2",
    "check": "check",
    "check-double": "check-check",
    "circle-check": "circle-check",
    "circle-xmark": "circle-x",
    "circle-info": "info",
    "circle-question": "circle-help",
    "circle-exclamation": "circle-alert",
    "gear": "settings",
    "cog": "settings",
    "ellipsis": "ellipsis",
    "ellipsis-vertical": "ellipsis-vertical",
    "bars": "menu",
    "house": "home",
    "home": "home",
    "clock": "clock",
    "tag": "tag",
    "tags": "tags",
    "paper-plane": "send",
    "paperclip": "paperclip",
    "lock": "lock",
    "unlock": "lock-open",
    "eye": "eye",
    "eye-slash": "eye-off",
    "moon": "moon",
    "sun": "sun",
    "leaf": "leaf",
    "mug-saucer": "coffee",
    "coffee": "coffee",
    "droplet": "droplet",
    "chart-line": "chart-line",
    "chart-bar": "chart-column",
    "chart-column": "chart-column",
    "chart-area": "chart-area",
    "list": "list",
    "list-ul": "list",
    "grip-vertical": "grip-vertical",
    "sliders": "sliders-horizontal",
    "filter": "filter",
    "download": "download",
    "upload": "upload",
    "ban": "ban",
    "flag": "flag",
    "thumbs-up": "thumbs-up",
    "thumbs-down": "thumbs-down",
    "face-smile": "smile",
    "face-meh": "meh",
    "face-frown": "frown",
    "face-grin": "laugh",
    "face-laugh": "laugh",
    "face-angry": "angry",
    "phone": "phone",
    "quote-left": "quote",
    "file": "file",
    "file-lines": "file-text",
    "clipboard": "clipboard",
    "clipboard-list": "clipboard-list",
    "clipboard-check": "clipboard-check",
    "scissors": "scissors",
    "palette": "palette",
    "paintbrush": "paintbrush",
    "crop": "crop",
    "expand": "maximize-2",
    "compress": "minimize-2",
    "play": "play",
    "pause": "pause",
    "hashtag": "hash",
    "gift": "gift",
    "box": "box",
    "cart-shopping": "shopping-cart",
    "bag-shopping": "shopping-bag",
    "store": "store",
    "building": "building",
    "globe": "globe",
    "map": "map",
    "car": "car",
    "bus": "bus",
    "train": "train",
    "plane": "plane",
    "bicycle": "bike",
    "paw": "paw-print",
    "pills": "pill",
    "syringe": "syringe",
    "stethoscope": "stethoscope",
    "briefcase": "briefcase",
    "graduation-cap": "graduation-cap",
    "book": "book",
    "newspaper": "newspaper",
    "tv": "tv",
    "desktop": "monitor",
    "laptop": "laptop",
    "mobile": "smartphone",
    "tablet": "tablet",
    "headphones": "headphones",
    "microphone": "mic",
    "microphone-slash": "mic-off",
    "video": "video",
    "video-slash": "video-off",
    "music": "music",
    "code": "code",
    "database": "database",
    "server": "server",
    "cloud": "cloud",
    "plug": "plug",
    "power-off": "power",
    "lightbulb": "lightbulb",
    "bolt": "zap",
    "snowflake": "snowflake",
    "umbrella": "umbrella",
    "tree": "tree",
    "wine-glass": "wine",
    "beer-mug-empty": "beer",
    "handshake": "handshake",
    "people-group": "users",
    "id-card": "id-card",
    "award": "award",
    "trophy": "trophy",
    "medal": "medal",
    "crown": "crown",
    "gem": "gem",
    "key": "key",
    "wrench": "wrench",
    "hammer": "hammer",
    "screwdriver-wrench": "wrench",
    "inbox": "inbox",
    "box-archive": "archive",
    "print": "printer",
    "credit-card": "credit-card",
    "wallet": "wallet",
    "coins": "coins",
    "calculator": "calculator",
    "arrow-trend-up": "trending-up",
    "arrow-trend-down": "trending-down",
    "note-sticky": "sticky-note",
    "cake-candles": "cake",
    "weight-scale": "scale",
    "heart-pulse": "heart-pulse",
    "seedling": "sprout",
    "circle-plus": "circle-plus",
    "square-plus": "square-plus",
    "circle-play": "circle-play",
    "circle-pause": "circle-pause",
    "circle-stop": "circle-stop",
    "forward-step": "skip-forward",
    "backward-step": "skip-back",
    "volume-high": "volume-2",
    "volume-low": "volume-1",
    "volume-xmark": "volume-x",
    "table-cells": "table",
    "grip-lines": "grip-horizontal",
    "icons": "layout-grid",
    "sitemap": "network",
    "terminal": "terminal",
    "hard-drive": "hard-drive",
    "microchip": "cpu",
    "language": "languages",
    "accessible-icon": "accessibility",
    "qrcode": "qr-code",
    "receipt": "receipt",
    "file-image": "file-image",
    "file-code": "file-code",
    "folder-plus": "folder-plus",
    "info": "info",
    "circle": "circle",
    "square": "square",
}

names = sorted(MAP.keys(), key=len, reverse=True)
name_alt = "|".join(re.escape(n) for n in names)

i_tag_re = re.compile(r'<i\b([^>]*?)\bclass="([^"]*)"([^>]*)>\s*</i>', re.I)
i_tag_re_sq = re.compile(r"<i\b([^>]*?)\bclass='([^']*)'([^>]*)>\s*</i>", re.I)

unmapped = {}


def convert_class_list(classes: str):
    parts = classes.split()
    icon = None
    keep = []
    spin = False
    for p in parts:
        if p in ("fa-solid", "fa-regular"):
            continue
        if p == "fa-brands":
            return None, classes
        if p == "fa-spin":
            spin = True
            continue
        if p.startswith("fa-"):
            name = p[3:]
            if name in MAP:
                icon = MAP[name]
            else:
                unmapped[name] = unmapped.get(name, 0) + 1
                return None, classes
            continue
        keep.append(p)
    if spin:
        keep.append("lucide-spin")
    return icon, " ".join(keep)


def replace_i_tags(text: str):
    count = 0

    def make_repl():
        def repl(m):
            nonlocal count
            pre, classes, post = m.group(1), m.group(2), m.group(3)
            if "fa-brands" in classes.split():
                return m.group(0)
            if "data-lucide" in (pre + post + classes):
                return m.group(0)
            icon, kept = convert_class_list(classes)
            if not icon:
                return m.group(0)
            count += 1
            class_attr = f' class="{kept}"' if kept else ""
            pre_s = pre.strip()
            post_s = post.strip()
            extras = (" " + pre_s if pre_s else "") + (" " + post_s if post_s else "")
            return f'<i data-lucide="{icon}"{class_attr}{extras}></i>'

        return repl

    text = i_tag_re.sub(make_repl(), text)
    text = i_tag_re_sq.sub(make_repl(), text)
    return text, count


targets = [ROOT / "index.html"]
targets += list((ROOT / "js").rglob("*.js"))
targets = [p for p in targets if p.name not in ("icons.js", "convert_fa_to_lucide.py")]

total = 0
changed = []
for p in targets:
    t = p.read_text(encoding="utf-8")
    t2, n = replace_i_tags(t)
    if n:
        p.write_text(t2, encoding="utf-8")
        changed.append((str(p.relative_to(ROOT)), n))
        total += n

print("converted", total, "in", len(changed), "files")
for f, n in sorted(changed, key=lambda x: -x[1])[:25]:
    print(f"{n:4d} {f}")
print("unmapped:", sorted(unmapped.items(), key=lambda x: -x[1])[:30])
