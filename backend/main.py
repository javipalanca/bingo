from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import bingo


BASE_DIR = Path(__file__).resolve().parent.parent
RENDERER_DIR = BASE_DIR / "renderer"
WEB_DIR = BASE_DIR / "web"

app = FastAPI(title="Bingo Backend", version="1.0.0")


class CardGenRequest(BaseModel):
    num: int = Field(..., ge=1, le=500)
    size: int = Field(default=5, ge=2, le=7)
    seed: int | None = None
    per_page: int = Field(default=4)
    cut_guides: bool = False
    filename: str | None = None
    entries_text: str | None = None


def build_card_items(req: CardGenRequest) -> list[str]:
    raw = (req.entries_text or "").strip()
    if raw:
        lines = [line.strip() for line in raw.splitlines()]
        items = [line for line in lines if line]
        if len(items) < req.size * req.size:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Necesitas al menos {req.size * req.size} entradas para un cartón "
                    f"{req.size}x{req.size}."
                ),
            )
        return items

    max_number = max(75, req.size * req.size)
    return [str(n) for n in range(1, max_number + 1)]


@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse(url="/renderer/index.html", status_code=307)


@app.get("/cards")
def cards_page() -> FileResponse:
    page = WEB_DIR / "cards.html"
    if not page.exists():
        raise HTTPException(status_code=404, detail="Página de cartones no encontrada")
    return FileResponse(page)


@app.post("/api/cards/generate")
def generate_cards(req: CardGenRequest) -> Response:
    if req.per_page not in {1, 2, 4, 6, 8, 9}:
        raise HTTPException(status_code=400, detail="per_page debe ser 1, 2, 4, 6, 8 o 9")

    try:
        rng = __import__("random").Random(req.seed)
        items = build_card_items(req)
        cards = bingo.generate_unique_cards(req.num, req.size, items, rng)

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            bingo.render_pdf(cards, str(tmp_path), req.size, req.seed, req.per_page, req.cut_guides)
            pdf_data = tmp_path.read_bytes()
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    safe_name = (req.filename or "retropolis_bingo").strip() or "retropolis_bingo"
    if not safe_name.lower().endswith(".pdf"):
        safe_name += ".pdf"
    safe_name = "".join(ch for ch in safe_name if ch.isalnum() or ch in ("-", "_", "."))

    return Response(
        content=pdf_data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )


app.mount("/renderer", StaticFiles(directory=RENDERER_DIR), name="renderer")
app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")
