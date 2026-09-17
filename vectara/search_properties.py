"""Lambda tool source for the Zameen agent's `search_properties` capability.

Vectara derives the tool's input schema from this signature and docstring, and
a flat signature is the part a model can reliably fill — the nested `search`
object of the built-in corpora_search tool is not model-fillable, and its
`corpora` array can only be supplied through `argument_override`.

The sandbox has no network access and cannot invoke other tools, so this does
not search anything itself. It validates and normalises the criteria; the
application backend observes the resulting `tool_input` event, builds the exact
metadata filter from these same values, runs the query, and feeds the listings
back to the agent on the following turn.
"""

PURPOSES = ("rent", "buy")
FLOORS = ("ground", "lower", "upper", "top", "numbered")
TYPES = ("houses", "flats", "upper portions", "lower portions", "penthouse")


def process(
    purpose: str,
    area: str = "",
    min_bedrooms: int = 0,
    max_bedrooms: int = 0,
    min_price: int = 0,
    max_price: int = 0,
    property_type: str = "",
    floor: str = "",
    min_area_sqft: int = 0,
) -> dict:
    """Search Karachi property listings by structured criteria.

    Args:
        purpose: Required. 'rent' or 'buy'.
        area: Area, town or society in Karachi, e.g. 'DHA Phase 6', 'Clifton'.
            Leave empty to search all of Karachi. For more than one area,
            separate them with a comma, e.g. 'Gulshan-e-Iqbal, Johar'.
        min_bedrooms: Minimum bedrooms. 0 means no minimum.
        max_bedrooms: Maximum bedrooms. 0 means no maximum.
        min_price: Minimum price in PKR (monthly for rent). 0 means no minimum.
        max_price: Maximum price in PKR (monthly for rent). 0 means no maximum.
        property_type: One of 'Houses', 'Flats', 'Upper Portions', 'Lower Portions', 'Penthouse'.
        floor: One of 'ground', 'lower', 'upper', 'top'. Only set when the user asks about a floor.
        min_area_sqft: Minimum covered area in square feet. 0 means no minimum.

    Returns:
        The normalised criteria, plus any warnings about values that were dropped.
    """
    warnings = []

    normalised_purpose = (purpose or "").strip().lower()
    if normalised_purpose not in PURPOSES:
        return {
            "status": "error",
            "error": "purpose must be either 'rent' or 'buy'",
            "criteria": {},
        }

    def positive_int(value, name):
        try:
            number = int(value)
        except (TypeError, ValueError):
            warnings.append(f"{name} was not a number and was ignored")
            return 0
        if number < 0:
            warnings.append(f"{name} was negative and was ignored")
            return 0
        return number

    criteria = {"purpose": normalised_purpose}

    if area and area.strip():
        names = [a.strip() for a in area.replace("&", ",").split(",") if a.strip()]
        if names:
            criteria["area"] = names[0] if len(names) == 1 else names

    min_beds = positive_int(min_bedrooms, "min_bedrooms")
    max_beds = positive_int(max_bedrooms, "max_bedrooms")
    if min_beds and max_beds and min_beds > max_beds:
        warnings.append("min_bedrooms exceeded max_bedrooms; the maximum was dropped")
        max_beds = 0
    if min_beds:
        criteria["min_bedrooms"] = min_beds
    if max_beds:
        criteria["max_bedrooms"] = max_beds

    low = positive_int(min_price, "min_price")
    high = positive_int(max_price, "max_price")
    if low and high and low > high:
        warnings.append("min_price exceeded max_price; the minimum was dropped")
        low = 0
    if low:
        criteria["min_price"] = low
    if high:
        criteria["max_price"] = high

    size = positive_int(min_area_sqft, "min_area_sqft")
    if size:
        criteria["min_area_sqft"] = size

    if property_type and property_type.strip():
        candidate = property_type.strip().lower()
        if candidate in TYPES:
            criteria["property_type"] = candidate
        else:
            warnings.append(
                f"'{property_type}' is not a known property type and was ignored"
            )

    if floor and floor.strip():
        candidate = floor.strip().lower()
        if candidate in FLOORS:
            criteria["floor"] = candidate
        else:
            warnings.append(f"'{floor}' is not a known floor value and was ignored")

    return {
        "status": "searching",
        "criteria": criteria,
        "warnings": warnings,
        "note": (
            "The matching listings are being retrieved and will be given to you "
            "in the very next message. Reply now with a brief acknowledgement of "
            "at most eight words and nothing else - do not describe any property "
            "yet, and do not invent any."
        ),
    }
