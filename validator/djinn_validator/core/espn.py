"""ESPN public API client for game scores and live game discovery.

Replaces The Odds API for outcome resolution and challenge game discovery.
ESPN's scoreboard endpoint is free and requires no API key.

Endpoint pattern:
    https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard

Sport mapping from Odds API keys:
    basketball_nba     → basketball/nba
    americanfootball_nfl → football/nfl
    baseball_mlb       → baseball/mlb
    icehockey_nhl      → hockey/nhl
    basketball_ncaab   → basketball/mens-college-basketball
    americanfootball_ncaaf → football/college-football
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog

log = structlog.get_logger()

ESPN_BASE_URL = "https://site.api.espn.com/apis/site/v2/sports"

# Map Odds API sport keys → ESPN sport/league path segments
SPORT_MAP: dict[str, str] = {
    "basketball_nba": "basketball/nba",
    "americanfootball_nfl": "football/nfl",
    "baseball_mlb": "baseball/mlb",
    "icehockey_nhl": "hockey/nhl",
    "basketball_ncaab": "basketball/mens-college-basketball",
    "americanfootball_ncaaf": "football/college-football",
    "soccer_epl": "soccer/eng.1",
    "soccer_usa_mls": "soccer/usa.1",
}

# Supported sport keys (for input validation)
SUPPORTED_SPORTS: frozenset[str] = frozenset(SPORT_MAP.keys())

# Static team name normalization table. Maps common short names and
# abbreviations to ESPN's canonical full team names.
# ESPN uses full names like "Los Angeles Lakers", "New England Patriots", etc.
TEAM_ALIASES: dict[str, str] = {
    # NBA
    "lakers": "los angeles lakers",
    "celtics": "boston celtics",
    "warriors": "golden state warriors",
    "nets": "brooklyn nets",
    "knicks": "new york knicks",
    "76ers": "philadelphia 76ers",
    "sixers": "philadelphia 76ers",
    "bucks": "milwaukee bucks",
    "heat": "miami heat",
    "bulls": "chicago bulls",
    "suns": "phoenix suns",
    "mavericks": "dallas mavericks",
    "mavs": "dallas mavericks",
    "nuggets": "denver nuggets",
    "clippers": "la clippers",
    "grizzlies": "memphis grizzlies",
    "hawks": "atlanta hawks",
    "cavaliers": "cleveland cavaliers",
    "cavs": "cleveland cavaliers",
    "raptors": "toronto raptors",
    "pacers": "indiana pacers",
    "hornets": "charlotte hornets",
    "wizards": "washington wizards",
    "magic": "orlando magic",
    "pistons": "detroit pistons",
    "thunder": "oklahoma city thunder",
    "pelicans": "new orleans pelicans",
    "timberwolves": "minnesota timberwolves",
    "wolves": "minnesota timberwolves",
    "blazers": "portland trail blazers",
    "trail blazers": "portland trail blazers",
    "spurs": "san antonio spurs",
    "kings": "sacramento kings",
    "jazz": "utah jazz",
    "rockets": "houston rockets",
    # NFL
    "chiefs": "kansas city chiefs",
    "eagles": "philadelphia eagles",
    "bills": "buffalo bills",
    "49ers": "san francisco 49ers",
    "niners": "san francisco 49ers",
    "cowboys": "dallas cowboys",
    "dolphins": "miami dolphins",
    "ravens": "baltimore ravens",
    "bengals": "cincinnati bengals",
    "lions": "detroit lions",
    "chargers": "los angeles chargers",
    "jaguars": "jacksonville jaguars",
    "jags": "jacksonville jaguars",
    "seahawks": "seattle seahawks",
    "vikings": "minnesota vikings",
    "packers": "green bay packers",
    "steelers": "pittsburgh steelers",
    "saints": "new orleans saints",
    "broncos": "denver broncos",
    "patriots": "new england patriots",
    "pats": "new england patriots",
    "commanders": "washington commanders",
    "colts": "indianapolis colts",
    "falcons": "atlanta falcons",
    "panthers": "carolina panthers",
    "bears": "chicago bears",
    "cardinals": "arizona cardinals",
    "browns": "cleveland browns",
    "raiders": "las vegas raiders",
    "titans": "tennessee titans",
    "texans": "houston texans",
    "rams": "los angeles rams",
    "giants": "new york giants",
    "jets": "new york jets",
    "buccaneers": "tampa bay buccaneers",
    "bucs": "tampa bay buccaneers",
    # MLB
    "yankees": "new york yankees",
    "red sox": "boston red sox",
    "dodgers": "los angeles dodgers",
    "astros": "houston astros",
    "braves": "atlanta braves",
    "mets": "new york mets",
    "cubs": "chicago cubs",
    "white sox": "chicago white sox",
    "phillies": "philadelphia phillies",
    "padres": "san diego padres",
    "mariners": "seattle mariners",
    "blue jays": "toronto blue jays",
    "guardians": "cleveland guardians",
    "orioles": "baltimore orioles",
    "twins": "minnesota twins",
    "brewers": "milwaukee brewers",
    "royals": "kansas city royals",
    "rays": "tampa bay rays",
    "reds": "cincinnati reds",
    "rangers": "texas rangers",
    "diamondbacks": "arizona diamondbacks",
    "d-backs": "arizona diamondbacks",
    "rockies": "colorado rockies",
    "pirates": "pittsburgh pirates",
    "marlins": "miami marlins",
    "athletics": "oakland athletics",
    "a's": "oakland athletics",
    "angels": "los angeles angels",
    "nationals": "washington nationals",
    "tigers": "detroit tigers",
    # NHL
    "bruins": "boston bruins",
    "maple leafs": "toronto maple leafs",
    "leafs": "toronto maple leafs",
    "canadiens": "montreal canadiens",
    "habs": "montreal canadiens",
    "blackhawks": "chicago blackhawks",
    "red wings": "detroit red wings",
    "penguins": "pittsburgh penguins",
    "pens": "pittsburgh penguins",
    "flyers": "philadelphia flyers",
    "capitals": "washington capitals",
    "caps": "washington capitals",
    "oilers": "edmonton oilers",
    "flames": "calgary flames",
    "canucks": "vancouver canucks",
    "avalanche": "colorado avalanche",
    "avs": "colorado avalanche",
    "wild": "minnesota wild",
    "predators": "nashville predators",
    "preds": "nashville predators",
    "blue jackets": "columbus blue jackets",
    "hurricanes": "carolina hurricanes",
    "canes": "carolina hurricanes",
    "senators": "ottawa senators",
    "sens": "ottawa senators",
    "sabres": "buffalo sabres",
    "islanders": "new york islanders",
    "isles": "new york islanders",
    "devils": "new jersey devils",
    "kraken": "seattle kraken",
    "golden knights": "vegas golden knights",
    "knights": "vegas golden knights",
    "ducks": "anaheim ducks",
    "sharks": "san jose sharks",
    "coyotes": "utah hockey club",
    "blues": "st. louis blues",
    "panthers": "florida panthers",
    "lightning": "tampa bay lightning",
    "bolts": "tampa bay lightning",
    "jets": "winnipeg jets",
    "stars": "dallas stars",
    # Cross-source aliases (Odds API vs ESPN naming differences)
    "los angeles clippers": "la clippers",
    "utah hockey club": "utah mammoth",
    "connecticut huskies": "uconn huskies",
    "connecticut": "uconn",
}


@dataclass
class ESPNGame:
    """A game from the ESPN scoreboard."""

    espn_id: str
    home_team: str
    away_team: str
    home_score: int | None = None
    away_score: int | None = None
    status: str = "pending"  # pending, in_progress, final, postponed, cancelled
    start_time: str = ""
    raw_data: dict[str, Any] = field(default_factory=dict)


class ESPNClient:
    """Async client for ESPN's public scoreboard API.

    Includes a circuit breaker to handle ESPN downtime gracefully.
    """

    CIRCUIT_BREAKER_THRESHOLD = 5
    CIRCUIT_BREAKER_RESET_SECONDS = 60.0

    def __init__(
        self,
        http_client: httpx.AsyncClient | None = None,
        base_url: str = ESPN_BASE_URL,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = http_client or httpx.AsyncClient(timeout=15.0)
        self._owns_client = http_client is None
        self._consecutive_failures = 0
        self._circuit_opened_at: float | None = None

    def _is_circuit_open(self) -> bool:
        if self._consecutive_failures < self.CIRCUIT_BREAKER_THRESHOLD:
            return False
        if self._circuit_opened_at is None:
            return False
        elapsed = time.monotonic() - self._circuit_opened_at
        if elapsed >= self.CIRCUIT_BREAKER_RESET_SECONDS:
            return False  # Half-open: allow one attempt
        return True

    def _record_success(self) -> None:
        self._consecutive_failures = 0
        self._circuit_opened_at = None

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.CIRCUIT_BREAKER_THRESHOLD:
            if self._circuit_opened_at is None:
                self._circuit_opened_at = time.monotonic()
                log.warning(
                    "espn_circuit_opened",
                    consecutive_failures=self._consecutive_failures,
                    reset_after_s=self.CIRCUIT_BREAKER_RESET_SECONDS,
                )

    async def get_scoreboard(
        self,
        sport: str,
        date: str | None = None,
    ) -> list[ESPNGame]:
        """Fetch the scoreboard for a sport from ESPN.

        Args:
            sport: Odds API sport key (e.g. "basketball_nba")
            date: Optional date in YYYYMMDD format. Defaults to today.

        Returns:
            List of ESPNGame objects, or empty list on failure.
        """
        espn_path = SPORT_MAP.get(sport)
        if espn_path is None:
            log.warning("espn_unsupported_sport", sport=sport)
            return []

        if self._is_circuit_open():
            log.debug("espn_circuit_open", sport=sport)
            return []

        url = f"{self._base_url}/{espn_path}/scoreboard"
        params: dict[str, str] = {}
        if date:
            params["dates"] = date

        try:
            resp = await self._client.get(url, params=params)
            if resp.status_code != 200:
                log.warning("espn_http_error", sport=sport, status=resp.status_code)
                self._record_failure()
                return []
            data = resp.json()
            self._record_success()
        except Exception as e:
            log.warning("espn_request_error", sport=sport, error=str(e))
            self._record_failure()
            return []

        return self._parse_scoreboard(data, sport)

    async def get_game_by_teams(
        self,
        sport: str,
        home_team: str,
        away_team: str,
        date: str | None = None,
    ) -> ESPNGame | None:
        """Find a specific game by team names.

        Uses fuzzy team name matching via the normalization table.
        """
        games = await self.get_scoreboard(sport, date=date)
        return match_game(games, home_team, away_team)

    def _parse_scoreboard(self, data: dict[str, Any], sport: str) -> list[ESPNGame]:
        """Parse ESPN scoreboard JSON into ESPNGame objects."""
        games: list[ESPNGame] = []

        for event in data.get("events", []):
            try:
                espn_id = str(event.get("id", ""))
                status_type = (
                    event.get("status", {}).get("type", {}).get("name", "")
                )
                start_time = event.get("date", "")

                game_status = _map_espn_status(status_type)

                competitors = event.get("competitions", [{}])[0].get(
                    "competitors", []
                )
                home_team = ""
                away_team = ""
                home_score: int | None = None
                away_score: int | None = None

                for comp in competitors:
                    team_name = comp.get("team", {}).get("displayName", "")
                    is_home = comp.get("homeAway") == "home"
                    score_str = comp.get("score", "")

                    try:
                        score = int(score_str)
                    except (ValueError, TypeError):
                        score = None

                    if is_home:
                        home_team = team_name
                        home_score = score
                    else:
                        away_team = team_name
                        away_score = score

                if not home_team or not away_team:
                    continue

                games.append(
                    ESPNGame(
                        espn_id=espn_id,
                        home_team=home_team,
                        away_team=away_team,
                        home_score=home_score,
                        away_score=away_score,
                        status=game_status,
                        start_time=start_time,
                        raw_data=event,
                    )
                )
            except (KeyError, IndexError, TypeError) as e:
                log.debug("espn_parse_event_error", error=str(e))
                continue

        return games

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def _map_espn_status(status_name: str) -> str:
    """Map ESPN status type name to our internal status."""
    status_lower = status_name.lower()
    if status_lower in ("status_final", "final"):
        return "final"
    if status_lower in ("status_in_progress", "in_progress", "status_halftime"):
        return "in_progress"
    if status_lower in ("status_postponed", "postponed"):
        return "postponed"
    if status_lower in ("status_canceled", "status_cancelled", "canceled", "cancelled"):
        return "cancelled"
    if status_lower in ("status_scheduled", "scheduled", "pre"):
        return "scheduled"
    return "pending"


def normalize_team(name: str) -> str:
    """Normalize a team name to lowercase canonical form.

    Checks the alias table first, then falls back to lowercased input.
    """
    import unicodedata
    # Strip accents (é → e, etc.) and normalize unicode
    nfkd = unicodedata.normalize("NFKD", name)
    lower = "".join(c for c in nfkd if not unicodedata.combining(c)).strip().lower()
    # Normalize & to and
    lower = lower.replace("&", "and")
    # Strip apostrophes/okina (Hawai'i → hawaii)
    lower = lower.replace("'", "").replace("\u02bb", "").replace("\u2018", "").replace("\u2019", "")
    return TEAM_ALIASES.get(lower, lower)


def teams_match(name_a: str, name_b: str) -> bool:
    """Check if two team names refer to the same team.

    Uses normalization + substring matching for robustness.
    """
    norm_a = normalize_team(name_a)
    norm_b = normalize_team(name_b)

    if norm_a == norm_b:
        return True

    # Substring match: "Lakers" matches "los angeles lakers"
    if norm_a in norm_b or norm_b in norm_a:
        return True

    # Word match: check if one is a single-word subset of the other
    words_a = set(norm_a.split())
    words_b = set(norm_b.split())
    if words_a and words_b and (words_a <= words_b or words_b <= words_a):
        return True

    return False


def match_game(
    games: list[ESPNGame],
    home_team: str,
    away_team: str,
) -> ESPNGame | None:
    """Find a game matching the given team names."""
    for game in games:
        home_ok = teams_match(game.home_team, home_team)
        away_ok = teams_match(game.away_team, away_team)
        if home_ok and away_ok:
            return game
        # Also try swapped (in case home/away is recorded differently)
        if teams_match(game.home_team, away_team) and teams_match(
            game.away_team, home_team
        ):
            return game
    return None
