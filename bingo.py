#!/usr/bin/env -S uv run
# /// script
# dependencies = [
#   "reportlab>=4.0.0"
# ]
# ///

# -*- coding: utf-8 -*-

import argparse
import os
import random
from dataclasses import dataclass
from typing import List, Tuple, Set

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors


# --- Games (spelling fixed / normalized) ---
GAMES = [
    "MARIO BROS",
    "PAC-MAN",
    "CASTLEVANIA",
    "PRINCE OF PERSIA",
    "FINAL FANTASY",
    "DONKEY KONG",
    "STREET FIGHTER",
    "TEKKEN",
    "STREETS OF RAGE",
    "ARKANOID",
    "1942",
    "CONTRA",
    "MEGA MAN",
    "BUBBLE BOBBLE",
    "PANG",
    "CADILLACS AND DINOSAURS",
    "METAL GEAR SOLID",
    "DUCKTALES",
    "THE LEGEND OF ZELDA",
    "TETRIS",
    "SONIC",
    "ALADDIN",
    "SILENT HILL",
    "CRASH BANDICOOT",
    "GRIM FANDANGO",
    "DOOM",
    "WORLD OF WARCRAFT",
    "THE SECRET OF MONKEY ISLAND",
    "STARCRAFT",
    "OUT RUN",
    "PONG",
    "GTA",
    "GHOSTS 'N GOBLINS",
    "SNOW BROS.",
    "COMMANDOS",
    "RESIDENT EVIL",
    "MEDIEVIL",
    "SPYRO",
    "DÍA DEL TENTÁCULO",
    "INDIANA JONES AND THE FATE OF ATLANTIS",
]


@dataclass(frozen=True)
class Card:
    grid: Tuple[str, ...]  # flattened size*size


# ---------------- Fonts ----------------

def try_register_font() -> str:
    """
    Use a TTF with accents support if available. Fallback to Helvetica.
    """
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf",
        "/Library/Fonts/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont("GameFont", path))
                return "GameFont"
            except Exception:
                pass
    return "Helvetica"


def text_width(s: str, font_name: str, font_size: int) -> float:
    return pdfmetrics.stringWidth(s, font_name, font_size)


# ---------------- Wrapping & fitting (NO ellipsis) ----------------

def wrap_to_width(text: str, font_name: str, font_size: int, max_width: float) -> List[str]:
    """
    Word wrap with fallback hard-split if a single token is too long.
    Never uses ellipsis.
    """
    words = text.split()
    if not words:
        return [""]

    lines: List[str] = []
    cur = words[0]

    for w in words[1:]:
        trial = f"{cur} {w}"
        if text_width(trial, font_name, font_size) <= max_width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)

    fixed: List[str] = []
    for line in lines:
        if text_width(line, font_name, font_size) <= max_width:
            fixed.append(line)
            continue

        # Hard-split char-by-char
        chunk = ""
        for ch in line:
            trial = chunk + ch
            if text_width(trial, font_name, font_size) <= max_width:
                chunk = trial
            else:
                if chunk:
                    fixed.append(chunk)
                chunk = ch
        if chunk:
            fixed.append(chunk)

    return fixed


def fit_text_to_box(
    text: str,
    font_name: str,
    max_w: float,
    max_h: float,
    base_fs: int,
    min_fs: int = 4,
) -> Tuple[int, List[str], int]:
    """
    Find font size + wrapping so text fits within (max_w,max_h).
    If needed, keeps reducing font size (NO ellipsis).
    """
    def line_height(fs: int) -> int:
        return int(fs * 1.16) + 1

    fs = base_fs
    while fs >= min_fs:
        lh = line_height(fs)
        max_lines = max(1, int(max_h // lh))
        lines = wrap_to_width(text, font_name, fs, max_w)

        if len(lines) <= max_lines:
            return fs, lines, lh

        fs -= 1

    # last resort (very small)
    fs = min_fs
    lh = max(4, int(fs * 1.05))
    max_lines = max(1, int(max_h // lh))
    lines = wrap_to_width(text, font_name, fs, max_w)
    return fs, lines[:max_lines], lh


# ---------------- Card generation ----------------

def generate_unique_cards(n: int, size: int, items: List[str], rng: random.Random) -> List[Card]:
    cells = size * size
    if len(items) < cells:
        raise ValueError(f"No hay suficientes nombres ({len(items)}) para un cartón {size}x{size} ({cells} casillas).")

    seen: Set[Tuple[str, ...]] = set()
    cards: List[Card] = []

    max_attempts = max(10_000, n * 300)
    attempts = 0
    while len(cards) < n and attempts < max_attempts:
        attempts += 1
        sample = rng.sample(items, cells)
        rng.shuffle(sample)
        sig = tuple(sample)
        if sig in seen:
            continue
        seen.add(sig)
        cards.append(Card(grid=sig))

    if len(cards) < n:
        raise RuntimeError(
            f"No he podido generar {n} cartones únicos (generados {len(cards)} tras {attempts} intentos). "
            f"Prueba con menos cartones."
        )
    return cards


def layout_from_per_page(per_page: int) -> Tuple[int, int]:
    """
    Guillotine-friendly layouts: exact grid occupying the whole page.
    """
    if per_page == 1:
        return (1, 1)
    if per_page == 2:
        return (2, 1)
    if per_page == 4:
        return (2, 2)
    if per_page == 6:
        return (3, 2)
    if per_page == 8:
        return (4, 2)
    if per_page == 9:
        return (3, 3)
    raise ValueError("per_page debe ser 1, 2, 4, 6, 8 o 9.")


# ---------------- Corporate + print-safe decorations ----------------

def draw_pixel_blocks(c: canvas.Canvas, x: float, y: float, block: float, pattern: List[str], on_color, off_color=None):
    """
    Draw a tiny pixel-art motif using filled rectangles.
    pattern: list of strings, where '1' draws a block.
    """
    c.saveState()
    for row, line in enumerate(pattern):
        for col, ch in enumerate(line):
            if ch == "1":
                c.setFillColor(on_color)
                c.rect(x + col * block, y + (len(pattern) - 1 - row) * block, block, block, stroke=0, fill=1)
            elif off_color is not None:
                c.setFillColor(off_color)
                c.rect(x + col * block, y + (len(pattern) - 1 - row) * block, block, block, stroke=0, fill=1)
    c.restoreState()


def draw_retropolis_logo(c: canvas.Canvas, x: float, y: float, w: float, h: float, title: str, serial: int,
                         accent, text_col, shadow_col):
    """
    Header: "RETROPÓLIS" with subtle shadow (still ok in B/N) + pixel decorations.
    No curves, no bitmap images.
    """
    pad = 3.5 * mm

    # Left pixel icon (simple "space invader" vibe)
    invader = [
        "00111100",
        "01111110",
        "11011011",
        "11111111",
        "01111110",
        "01011010",
        "11000011",
    ]
    block = min(1.6 * mm, (h - 2 * pad) / 8.5)
    icon_w = len(invader[0]) * block
    icon_h = len(invader) * block

    ix = x + pad
    iy = y + (h - icon_h) / 2
    draw_pixel_blocks(c, ix, iy, block, invader, on_color=accent)

    # Title with shadow
    tx = ix + icon_w + 3.0 * mm
    ty = y + h * 0.58

    # Fit title font size to available width
    max_title_w = (x + w - pad) - tx - 26 * mm  # reserve for serial box
    fs = 16
    while fs > 9 and text_width(title, "Helvetica-Bold", fs) > max_title_w:
        fs -= 1

    c.setFont("Helvetica-Bold", fs)
    c.setFillColor(shadow_col)
    c.drawString(tx + 0.8 * mm, ty - 0.6 * mm, title)

    c.setFillColor(text_col)
    c.drawString(tx, ty, title)

    # Serial box on the right
    box_w = 24 * mm
    box_h = h - 2 * pad
    bx = x + w - pad - box_w
    by = y + pad

    c.setFillColor(colors.white)
    c.setStrokeColor(accent)
    c.setLineWidth(1.5)
    c.rect(bx, by, box_w, box_h, stroke=1, fill=1)

    c.setFillColor(text_col)
    c.setFont("Helvetica-Bold", 9)
    c.drawCentredString(bx + box_w / 2, by + box_h * 0.62, "SERIE")
    c.setFont("Helvetica-Bold", 12)
    c.drawCentredString(bx + box_w / 2, by + box_h * 0.22, f"{serial:04d}")

    # Right tiny pixel sparkles
    sparkle = [
        "00100",
        "01110",
        "11111",
        "01110",
        "00100",
    ]
    sb = min(1.2 * mm, block)
    sx = bx - 2.2 * mm - len(sparkle[0]) * sb
    sy = y + (h - len(sparkle) * sb) / 2
    draw_pixel_blocks(c, sx, sy, sb, sparkle, on_color=accent)


# ---------------- Drawing (full-page grid, cut-friendly) ----------------

def draw_cut_lines(c: canvas.Canvas, page_w: float, page_h: float, cols: int, rows: int):
    """
    Thin cut guides exactly on the card boundaries (guillotine).
    """
    c.setStrokeColor(colors.HexColor("#B5B5B5"))  # light gray (works in B/N)
    c.setLineWidth(0.4)

    for i in range(1, cols):
        x = page_w * i / cols
        c.line(x, 0, x, page_h)

    for j in range(1, rows):
        y = page_h * j / rows
        c.line(0, y, page_w, y)


def draw_one_card(
    c: canvas.Canvas,
    card: Card,
    serial: int,
    size: int,
    font_name: str,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    bg,
    border,
    header_bg,
    accent,
    text_col,
    shadow_col,
    grid_col,
):
    # Card background (square corners)
    c.setFillColor(bg)
    c.setStrokeColor(border)
    c.setLineWidth(1.8)
    c.rect(x, y, w, h, stroke=1, fill=1)

    # Header band
    header_h = max(10.5 * mm, h * 0.13)
    c.setFillColor(header_bg)
    c.setStrokeColor(border)
    c.setLineWidth(1.2)
    c.rect(x, y + h - header_h, w, header_h, stroke=1, fill=1)

    # Logo + serial (inside header)
    draw_retropolis_logo(
        c=c,
        x=x,
        y=y + h - header_h,
        w=w,
        h=header_h,
        title="RETROPOLIS",
        serial=serial,
        accent=accent,
        text_col=text_col,
        shadow_col=shadow_col,
    )

    # Grid area uses ALL remaining space (rectangular cells allowed)
    pad_x = 3.5 * mm
    pad_y = 3.0 * mm

    gx = x + pad_x
    gy = y + pad_y
    gw = w - 2 * pad_x
    gh = h - header_h - 2 * pad_y

    cell_w = gw / size
    cell_h = gh / size

    # Grid border + lines
    c.setStrokeColor(grid_col)
    c.setLineWidth(1.0)
    c.rect(gx, gy, gw, gh, stroke=1, fill=0)

    c.setLineWidth(0.8)
    for i in range(1, size):
        c.line(gx + i * cell_w, gy, gx + i * cell_w, gy + gh)
        c.line(gx, gy + i * cell_h, gx + gw, gy + i * cell_h)

    # Text (auto-shrink only; never ellipsis)
    c.setFillColor(text_col)
    inner_pad_x = 1.6 * mm
    inner_pad_y = 1.2 * mm

    base_fs = 10 if min(cell_w, cell_h) >= 40 else 9
    min_fs = 4  # still readable on most printers; avoids cutting text

    for r in range(size):
        for col in range(size):
            txt = card.grid[r * size + col]

            cx = gx + col * cell_w
            cy = gy + (size - 1 - r) * cell_h

            max_w = max(1.0, cell_w - 2 * inner_pad_x)
            max_h = max(1.0, cell_h - 2 * inner_pad_y)

            fs, lines, lh = fit_text_to_box(
                txt,
                font_name=font_name,
                max_w=max_w,
                max_h=max_h,
                base_fs=base_fs,
                min_fs=min_fs,
            )

            c.setFont(font_name, fs)

            total_h = len(lines) * lh
            start_y = cy + (cell_h - total_h) / 2.0 + (fs * 0.10)

            for i, line in enumerate(lines):
                c.drawCentredString(
                    cx + cell_w / 2.0,
                    start_y + (len(lines) - 1 - i) * lh,
                    line,
                )


def render_pdf(cards: List[Card], out_path: str, size: int, seed: int | None, per_page: int, cut_guides: bool):
    font_name = try_register_font()
    page_w, page_h = landscape(A4)
    cols, rows = layout_from_per_page(per_page)

    c = canvas.Canvas(out_path, pagesize=(page_w, page_h))

    # Print-safe corporate theme (works in color AND in B/N)
    # - White background
    # - Dark text
    # - Mid-gray header band
    # - Single accent that degrades nicely to gray
    bg = colors.white
    border = colors.black
    header_bg = colors.HexColor("#E9ECEF")   # light gray
    text_col = colors.black
    grid_col = colors.HexColor("#333333")    # dark gray
    accent = colors.HexColor("#1F4E79")      # corporate blue -> prints as medium/dark gray in B/N
    shadow_col = colors.HexColor("#777777")  # subtle shadow

    total = len(cards)
    i = 0
    page_no = 1

    while i < total:
        # Page background
        c.setFillColor(bg)
        c.rect(0, 0, page_w, page_h, stroke=0, fill=1)

        # Optional cut guides on card boundaries
        if cut_guides and (cols > 1 or rows > 1):
            draw_cut_lines(c, page_w, page_h, cols, rows)

        # Small page footer (won't interfere with guillotine if you cut exactly on boundaries; it's inside page though)
        c.setFillColor(colors.HexColor("#666666"))
        c.setFont("Helvetica", 8)
        footer = f"Página {page_no}"
        if seed is not None:
            footer += f" · seed={seed}"
        c.drawString(2.5 * mm, 2.5 * mm, footer)

        # Cards occupy the entire sheet in an exact grid: perfect guillotine.
        slot_w = page_w / cols
        slot_h = page_h / rows

        slots = cols * rows
        for s in range(slots):
            if i >= total:
                break

            r = s // cols
            col = s % cols

            x = col * slot_w
            y = (rows - 1 - r) * slot_h
            w = slot_w
            h = slot_h

            draw_one_card(
                c=c,
                card=cards[i],
                serial=i + 1,
                size=size,
                font_name=font_name,
                x=x,
                y=y,
                w=w,
                h=h,
                bg=bg,
                border=border,
                header_bg=header_bg,
                accent=accent,
                text_col=text_col,
                shadow_col=shadow_col,
                grid_col=grid_col,
            )
            i += 1

        c.showPage()
        page_no += 1

    c.save()


def main():
    parser = argparse.ArgumentParser(
        description="Generador de cartones de bingo (videojuegos) en PDF — Retrópolis, corporativo y guillotina-friendly."
    )
    parser.add_argument("-n", "--num", type=int, required=True, help="Número de cartones a generar.")
    parser.add_argument("-o", "--output", type=str, default="retropolis_bingo.pdf", help="Ruta del PDF de salida.")
    parser.add_argument("--size", type=int, default=5, help="Tamaño del cartón (por defecto 5 para 5x5).")
    parser.add_argument("--seed", type=int, default=None, help="Semilla RNG para reproducibilidad.")
    parser.add_argument(
        "--per-page",
        type=int,
        default=4,
        help="Cartones por página (1, 2, 4, 6, 8 o 9). Por defecto 4 (2x2).",
    )
    parser.add_argument(
        "--cut-guides",
        action="store_true",
        help="Dibuja guías finas de corte en los límites de los cartones (útil para guillotina).",
    )
    args = parser.parse_args()

    rng = random.Random(args.seed)
    cards = generate_unique_cards(args.num, args.size, GAMES, rng)
    render_pdf(cards, args.output, args.size, args.seed, args.per_page, args.cut_guides)

    print(f"OK: generado {args.num} cartones en '{args.output}' (per_page={args.per_page})")


if __name__ == "__main__":
    main()