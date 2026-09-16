"""Lambda tool: validate and normalise one listing extracted by the ingest agent.

The pipeline's transform agent reads a Zameen property page and extracts fields
with an LLM, so the values arriving here are inferred, not parsed. This is the
gate that stops a bad inference from being indexed: it range-checks every
number, constrains every enum, and returns ``success: false`` when a field is
implausible. The pipeline's ``transform.verification`` condition keys off that
flag, so a failed record fails the run rather than silently entering the corpus.

It also derives the values the corpus schema needs but the page does not state
directly — the lowercase ``*_norm`` twins, the sq-yard conversion, the floor
bucket, and the lakh/crore price label.
"""

PURPOSES = ("rent", "buy")
FLOOR_BUCKETS = ("ground", "lower", "upper", "top", "numbered", "unknown")
PROPERTY_TYPES = (
    "Houses",
    "Flats",
    "Upper Portions",
    "Lower Portions",
    "Penthouse",
    "Rooms",
    "Farm Houses",
)

# Karachi listings outside these bounds are extraction errors, not bargains.
# Rent spans a servant quarter to a furnished sea-facing penthouse; sale spans a
# small flat to a commercial-scale house.
LIMITS = {
    "rent": {"price": (5_000, 10_000_000)},
    "buy": {"price": (500_000, 5_000_000_000)},
}
MAX_BEDROOMS = 30
MAX_BATHROOMS = 30
MAX_AREA_SQFT = 200_000
MAX_FLOOR = 60


def _price_label(amount: int) -> str:
    """Render PKR the way Pakistani listings read: lakh and crore."""
    def trim(value: float) -> str:
        return f"{value:.2f}".rstrip("0").rstrip(".")

    if amount >= 10_000_000:
        return f"PKR {trim(amount / 10_000_000)} Crore"
    if amount >= 100_000:
        return f"PKR {trim(amount / 100_000)} Lakh"
    return f"PKR {amount:,}"


def process(
    external_id: str,
    purpose: str,
    title: str,
    price_pkr: int,
    bedrooms: int = 0,
    bathrooms: int = 0,
    area_sqft: int = 0,
    property_type: str = "",
    area_l3: str = "",
    area_l4: str = "",
    area_l5: str = "",
    city: str = "Karachi",
    floor: str = "unknown",
    floor_num: int = -1,
    description: str = "",
    source_url: str = "",
    cover_photo: str = "",
    agency: str = "",
    is_verified: bool = False,
    listed_at: int = 0,
    seen_at: int = 0,
) -> dict:
    """Validate and normalise one extracted Zameen listing before indexing.

    Args:
        external_id: Zameen listing id, digits only, from the page URL or body.
        purpose: 'rent' or 'buy'.
        title: The listing headline.
        price_pkr: Price in PKR. Monthly for rent, total for sale. Required.
        bedrooms: Number of bedrooms. 0 if not stated.
        bathrooms: Number of bathrooms. 0 if not stated.
        area_sqft: Covered area in square feet. 0 if not stated.
        property_type: Houses, Flats, Upper Portions, Lower Portions or Penthouse.
        area_l3: District, e.g. 'DHA Defence'.
        area_l4: Phase or sub-area, e.g. 'DHA Phase 8'.
        area_l5: Project or society, e.g. 'Emaar Crescent Bay'.
        city: Always Karachi for this corpus.
        floor: ground, lower, upper, top, numbered, or unknown if not stated.
        floor_num: Floor number; 0 for ground. Use -1 when not stated.
        description: Short description text from the page.
        source_url: The page URL this was extracted from.
        cover_photo: Main photo URL if present.
        agency: Listing agency name if present.
        is_verified: Whether the page marks the listing verified.
        listed_at: Unix seconds the listing was published, 0 if unknown.
        seen_at: Unix seconds of this ingestion run.

    Returns:
        {'success': bool, 'metadata': {...}, 'errors': [...], 'warnings': [...]}
        Index the document only when success is true.
    """
    errors = []
    warnings = []

    def as_int(value, name, default=0):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            warnings.append(f"{name} was not numeric; treated as {default}")
            return default

    # --- required identity -------------------------------------------------
    listing_id = "".join(ch for ch in str(external_id or "") if ch.isdigit())
    if not listing_id:
        errors.append("external_id is missing or contains no digits")

    clean_purpose = str(purpose or "").strip().lower()
    if clean_purpose not in PURPOSES:
        errors.append(f"purpose must be 'rent' or 'buy', got {purpose!r}")

    clean_title = str(title or "").strip()
    if not clean_title:
        errors.append("title is empty")

    # --- price -------------------------------------------------------------
    price = as_int(price_pkr, "price_pkr", 0)
    if price <= 0:
        errors.append("price_pkr must be greater than zero")
    elif clean_purpose in LIMITS:
        low, high = LIMITS[clean_purpose]["price"]
        if not (low <= price <= high):
            errors.append(
                f"price_pkr {price} is outside the plausible {clean_purpose} range {low}-{high}"
            )

    # --- counts and size ---------------------------------------------------
    beds = as_int(bedrooms, "bedrooms", 0)
    if beds < 0 or beds > MAX_BEDROOMS:
        errors.append(f"bedrooms {beds} is implausible")
        beds = 0

    baths = as_int(bathrooms, "bathrooms", 0)
    if baths < 0 or baths > MAX_BATHROOMS:
        errors.append(f"bathrooms {baths} is implausible")
        baths = 0

    sqft = as_int(area_sqft, "area_sqft", 0)
    if sqft < 0 or sqft > MAX_AREA_SQFT:
        errors.append(f"area_sqft {sqft} is implausible")
        sqft = 0

    # --- enums -------------------------------------------------------------
    clean_type = str(property_type or "").strip()
    if clean_type:
        match = next((t for t in PROPERTY_TYPES if t.lower() == clean_type.lower()), None)
        if match:
            clean_type = match
        else:
            warnings.append(f"unknown property_type {clean_type!r}; kept as given")
    else:
        clean_type = "Property"

    clean_floor = str(floor or "unknown").strip().lower()
    if clean_floor not in FLOOR_BUCKETS:
        warnings.append(f"unknown floor {floor!r}; recorded as unknown")
        clean_floor = "unknown"

    fnum = as_int(floor_num, "floor_num", -1)
    if fnum < -1 or fnum > MAX_FLOOR:
        warnings.append(f"floor_num {fnum} is implausible; recorded as unknown")
        fnum = -1
    if clean_floor == "ground":
        fnum = 0
    # A bare number with no bucket still means a numbered storey.
    if clean_floor == "unknown" and fnum > 0:
        clean_floor = "numbered"

    if errors:
        return {"success": False, "errors": errors, "warnings": warnings, "metadata": {}}

    l3, l4, l5 = (str(a or "").strip() for a in (area_l3, area_l4, area_l5))
    area_path = " > ".join(a for a in (l3, l4, l5) if a)
    now = as_int(seen_at, "seen_at", 0)

    metadata = {
        "external_id": listing_id,
        "title": clean_title,
        "url": str(source_url or "").strip(),
        "purpose": clean_purpose,
        "property_type": clean_type,
        "property_type_norm": clean_type.lower(),
        "bedrooms": beds,
        "bathrooms": baths,
        "price_pkr": price,
        "price_label": _price_label(price),
        "area_sqft": sqft,
        "area_sqyd": round(sqft / 9),
        "city": str(city or "Karachi").strip() or "Karachi",
        "area_l3": l3,
        "area_l3_norm": l3.lower(),
        "area_l4": l4,
        "area_l4_norm": l4.lower(),
        "area_l5": l5,
        "area_l5_norm": l5.lower(),
        "area_path": area_path,
        "floor": clean_floor,
        "floor_num": fnum,
        "is_verified": bool(is_verified),
        "listed_at": as_int(listed_at, "listed_at", 0),
        "lat": 0,
        "lng": 0,
        "cover_photo": str(cover_photo or "").strip(),
        "agency": str(agency or "").strip(),
        "photo_count": 0,
        "source_url": str(source_url or "").strip(),
        "first_seen_at": now,
        "last_seen_at": now,
    }

    return {
        "success": True,
        "document_id": f"{clean_purpose}-{listing_id}",
        "metadata": metadata,
        "search_text": _search_text(metadata, str(description or "").strip()),
        "errors": [],
        "warnings": warnings,
    }


def _search_text(m: dict, description: str) -> str:
    """Natural-language rendering used as the document's single part."""
    action = "for rent" if m["purpose"] == "rent" else "for sale"
    where = m["area_path"] or m["city"]
    floor_phrase = {
        "ground": "on the ground floor",
        "lower": "on a lower floor / lower portion",
        "upper": "on an upper floor / upper portion",
        "top": "on the top floor",
    }.get(m["floor"])
    if m["floor"] == "numbered" and m["floor_num"] >= 0:
        floor_phrase = f"on floor {m['floor_num']}"
    if not floor_phrase:
        floor_phrase = "floor not stated"

    per = " per month" if m["purpose"] == "rent" else ""
    lines = [
        f"{m['bedrooms']} bedroom {m['property_type']} {action} in {where}, {m['city']}.",
        m["title"],
        description,
        f"{m['area_sqft']:,} sq ft ({m['area_sqyd']} sq yards), {m['bedrooms']} bedrooms, "
        f"{m['bathrooms']} bathrooms, {floor_phrase}.",
        f"Price: {m['price_label']}{per} (PKR {m['price_pkr']:,}).",
        "This listing is verified by Zameen." if m["is_verified"] else "",
        f"Listed by {m['agency']}." if m["agency"] else "",
    ]
    return "\n".join(line for line in lines if line)
